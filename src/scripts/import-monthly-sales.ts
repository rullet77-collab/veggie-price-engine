// ────────────────────────────────────────────────
// 월별 매출상세 xlsx 4개 파일 → monthly_sales_quantity
//
// 동작:
//  - 기존 monthly_sales_quantity 모두 삭제 (clean import)
//  - 매출 폴더 4개 파일 + 오늘자 파일 파싱
//  - 그룹명 → source 매핑 (식봄/신선행/온일장/배민)
//  - 파일명에서 sale_month 추출
//  - (product_code, sale_month, source) 별 quantity 합산 → upsert
//
// 사용:
//  npx tsx scripts/import-monthly-sales.ts
// ────────────────────────────────────────────────
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

// 파일 목록 — 파일명 → sale_month
const FILES: Array<{ path: string; saleMonth: string }> = [
  { path: "C:/Users/y/Videos/판매가변경영상/매출/2026 2월 매출상세.xlsx", saleMonth: "2026-02-01" },
  { path: "C:/Users/y/Videos/판매가변경영상/매출/2026 3월 매출상세.xlsx", saleMonth: "2026-03-01" },
  { path: "C:/Users/y/Videos/판매가변경영상/매출/2026 4월 매출상세.xlsx", saleMonth: "2026-04-01" },
  { path: "C:/Users/y/Videos/판매가변경영상/매출/2026 5월5일까지 매출상세.xlsx", saleMonth: "2026-05-01" },
  { path: "C:/Users/y/Videos/판매가변경영상/매출/20260506 매출상세.xlsx", saleMonth: "2026-05-01" },  // 5월에 합산
];

// 그룹명 → source 매핑
function detectSource(groupName: string): string | null {
  const g = groupName.replace(/▣/g, "").trim();
  if (g.startsWith("식봄")) return "식봄";
  if (g.startsWith("신선행")) return "신선행";
  if (g.startsWith("온일장")) return "온일장";
  if (g.startsWith("배민")) return "배민";
  return null;  // 세현(관리), 직원, etc. skip
}

function getKey(): string {
  const env = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const m = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  if (!m) throw new Error(".env.local 에 NEXT_PUBLIC_SUPABASE_ANON_KEY 없음");
  return m[1].trim();
}

async function fetchExistingCodes(key: string): Promise<Set<string>> {
  const all = new Set<string>();
  let from = 0;
  const limit = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products?select=product_code&limit=${limit}&offset=${from}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const data = (await res.json()) as { product_code: string }[];
    if (data.length === 0) break;
    for (const d of data) all.add(d.product_code);
    if (data.length < limit) break;
    from += limit;
  }
  return all;
}

function normalizeCode(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "[합 계]" || s.includes("합계")) return null;
  return s.padStart(6, "0");
}

async function main() {
  const key = getKey();

  console.log("[1] products 코드 fetch");
  const existingCodes = await fetchExistingCodes(key);
  console.log(`    products ${existingCodes.size}개`);

  console.log("[2] 기존 monthly_sales_quantity 삭제");
  const delRes = await fetch(
    `${SUPABASE_URL}/rest/v1/monthly_sales_quantity?id=gte.0`,
    {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }
  );
  console.log(`    DELETE status ${delRes.status}`);

  console.log("[3] xlsx 파싱 + (code, month, source) 합산");
  // 키: "code__month__source" → quantity
  const agg = new Map<string, { product_code: string; sale_month: string; source: string; quantity: number }>();
  let badRows = 0, missingProduct = 0, otherSource = 0, totalRows = 0;

  for (const { path, saleMonth } of FILES) {
    if (!fs.existsSync(path)) {
      console.log(`    스킵 (없음): ${path}`);
      continue;
    }
    const wb = XLSX.readFile(path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    console.log(`    ${path.split("/").pop()}: ${rows.length}행 (sale_month=${saleMonth})`);

    for (const row of rows) {
      totalRows++;
      const code = normalizeCode(row["상품코드"]);
      const groupName = row["그룹명"];
      const qty = Number(row["수량"]) || 0;
      if (!code) { badRows++; continue; }
      if (!existingCodes.has(code)) { missingProduct++; continue; }
      if (!groupName) { badRows++; continue; }

      const source = detectSource(String(groupName));
      if (!source) { otherSource++; continue; }
      if (qty <= 0) { badRows++; continue; }

      const key = `${code}__${saleMonth}__${source}`;
      const cur = agg.get(key);
      if (cur) cur.quantity += qty;
      else agg.set(key, { product_code: code, sale_month: saleMonth, source, quantity: qty });
    }
  }
  console.log(`    원본 ${totalRows}행 → 집계 ${agg.size}행 / bad ${badRows} / 미존재상품 ${missingProduct} / 기타source ${otherSource}`);

  console.log("[4] monthly_sales_quantity insert");
  const records = [...agg.values()];
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/monthly_sales_quantity?on_conflict=product_code,sale_month,source`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      }
    );
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`insert ${res.status}: ${txt.slice(0, 300)}`);
    }
    inserted += batch.length;
    if (((i / BATCH) % 5) === 0) console.log(`    ${Math.min(i + BATCH, records.length)}/${records.length}`);
  }
  console.log(`완료. 총 ${inserted}건 upsert`);
}

main().catch((e) => { console.error(e); process.exit(1); });
