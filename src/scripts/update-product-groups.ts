// 260421상품그룹.xlsx 기반 products.product_group 일괄 업데이트
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function fetchKey(): Promise<string> {
  const envContent = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const match = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  return match ? match[1].trim() : "";
}

type Row = {
  code: string;       // 상품코드
  name: string;       // 상품명
  group: number | null;
};

async function main() {
  const key = await fetchKey();
  if (!key) throw new Error("Supabase key not found");

  const XLSX_PATH = "C:/Users/y/Downloads/260421상품그룹.xlsx";
  const wb = XLSX.readFile(XLSX_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });

  const parsed: Row[] = rows.map((r) => ({
    code: String(r["상품코드(수정금지)"]).padStart(6, "0"),
    name: String(r["상품명"] || ""),
    group: r["상품그룹"] != null ? Number(r["상품그룹"]) : null,
  }));

  console.log(`엑셀: ${parsed.length}개 품목`);
  console.log(`그룹 할당: ${parsed.filter(p => p.group != null).length}개`);

  let updated = 0, skipped = 0, unchanged = 0, notfound = 0;

  for (const row of parsed) {
    if (!row.code || row.code === "NaN") { skipped++; continue; }

    // 현재 DB 값 조회
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/products?product_code=eq.${row.code}&select=product_code,product_group`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const existing = await getRes.json();
    if (!Array.isArray(existing) || existing.length === 0) {
      notfound++;
      continue;
    }

    const current = existing[0].product_group;
    if (current === row.group) { unchanged++; continue; }

    // 업데이트
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/products?product_code=eq.${row.code}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          product_group: row.group,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (patchRes.ok) {
      updated++;
    } else {
      console.error(`  실패: ${row.code} ${row.name}: ${patchRes.status}`);
    }
  }

  console.log(`\n결과:`);
  console.log(`  업데이트:   ${updated}건`);
  console.log(`  동일(스킵): ${unchanged}건`);
  console.log(`  DB에 없음:  ${notfound}건`);
  console.log(`  스킵:       ${skipped}건`);
}

main().catch(console.error);
