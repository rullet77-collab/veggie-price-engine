// ★ 플랫폼시트에서 기존판매가, 판매가, 수익률일괄변경용 가져와서 DB 업데이트
const SHEET_ID = "1XTEsLofvN7c3VVg110OYkOoSnttAgPF9_JYxr4cGkfE";
const SHEET_NAME = encodeURIComponent("전체상품(야채용)");

async function fetchColumn(range: string): Promise<string[]> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${SHEET_NAME}&range=${range}`;
  const res = await fetch(url);
  const text = await res.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => {
    // Remove surrounding quotes
    let v = l.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v.replace(/""/g, '"').trim();
  });
}

function parseNum(val: string): number | null {
  if (!val || val === "-" || val === "") return null;
  // Remove commas, spaces, %
  const cleaned = val.replace(/[,\s]/g, "");
  // Handle percentage
  const pctMatch = cleaned.match(/^([\d.]+)%$/);
  if (pctMatch) return parseFloat(pctMatch[1]);
  // Handle values like "54(3)" -> take first number
  const numMatch = cleaned.match(/^[\d.]+/);
  if (!numMatch) return null;
  const n = parseFloat(numMatch[0]);
  return isNaN(n) ? null : n;
}

async function main() {
  console.log("★ 플랫폼시트에서 컬럼별 데이터 가져오는 중...");

  // 각 컬럼 별도 fetch
  const [codes, prevSelling, selling, targetMargin] = await Promise.all([
    fetchColumn("A2:A740"),          // 상품코드
    fetchColumn("AG2:AG740"),        // 기존판매가 (col 32)
    fetchColumn("AH2:AH740"),        // 판매가 (col 33)
    fetchColumn("AR2:AR740"),        // 수익률일괄변경용 (col 43)
  ]);

  console.log(`상품코드: ${codes.length}개`);
  console.log(`기존판매가: ${prevSelling.length}개`);
  console.log(`판매가: ${selling.length}개`);
  console.log(`수익률일괄변경용: ${targetMargin.length}개`);

  // 샘플 확인
  for (let i = 0; i < 5; i++) {
    console.log(`  ${codes[i]}: 기존=${prevSelling[i]}, 판매가=${selling[i]}, 일괄변경=${targetMargin[i]}`);
  }

  // Supabase 키 읽기
  const fs = await import("fs");
  const envPath = "C:/Users/y/Videos/판매가변경영상/src/.env.local";
  let supabaseKey = "";
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    const match = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
    if (match) supabaseKey = match[1].trim();
  }
  if (!supabaseKey) {
    console.error("Supabase 키를 찾을 수 없습니다");
    return;
  }

  const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

  // 1) product_selling_prices 업데이트 (기존판매가 + 판매가)
  let sellingUpdated = 0;
  let sellingInserted = 0;
  let sellingSkipped = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code || code.length > 6) continue;

    const prevPrice = parseNum(prevSelling[i] || "");
    const price = parseNum(selling[i] || "");

    if (prevPrice == null && price == null) {
      sellingSkipped++;
      continue;
    }

    const body: Record<string, unknown> = {
      product_code: code,
      updated_at: new Date().toISOString(),
    };
    if (price != null) body.selling_price = price;
    if (prevPrice != null) body.prev_selling_price = prevPrice;

    // PATCH 먼저 시도
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/product_selling_prices?product_code=eq.${code}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: "return=headers-only",
        },
        body: JSON.stringify(body),
      }
    );

    // content-range 헤더로 영향받은 행 수 확인
    const contentRange = patchRes.headers.get("content-range");
    const affected = contentRange ? parseInt(contentRange.split("/")[1] || "0") : -1;

    if (patchRes.ok && affected > 0) {
      sellingUpdated++;
    } else {
      // 없으면 INSERT
      const insertRes = await fetch(
        `${SUPABASE_URL}/rest/v1/product_selling_prices`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: "return=minimal,resolution=merge-duplicates",
          },
          body: JSON.stringify(body),
        }
      );
      if (insertRes.ok) {
        sellingInserted++;
      } else {
        // ignore FK errors
      }
    }
  }

  console.log(`\nproduct_selling_prices: ${sellingUpdated}건 업데이트, ${sellingInserted}건 신규, ${sellingSkipped}건 스킵`);

  // 2) products 테이블 target_margin_rate 업데이트
  let marginUpdated = 0;
  let marginSkipped = 0;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code || code.length > 6) continue;

    const margin = parseNum(targetMargin[i] || "");
    if (margin == null) {
      marginSkipped++;
      continue;
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products?product_code=eq.${code}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          target_margin_rate: margin,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (res.ok) {
      marginUpdated++;
    }
  }

  console.log(`products target_margin_rate: ${marginUpdated}건 업데이트, ${marginSkipped}건 스킵`);
  console.log("\n완료!");
}

main().catch(console.error);
