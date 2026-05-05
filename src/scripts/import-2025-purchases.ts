// ────────────────────────────────────────────────
// 야채매입상세 xlsx 파일들 → daily_purchase_prices 일괄 import
//
// 사용:
//   npx tsx scripts/import-2025-purchases.ts
//
// 동작:
//   - 매입상세 xlsx 여러 파일 자동 탐색 (2025/2026 등)
//   - 코드/일자/단가/수량/단위/공급가액 파싱
//   - products 테이블에 존재하는 코드만 필터
//   - daily_purchase_prices 에 UPSERT (UNIQUE constraint 충돌 시 skip)
// ────────────────────────────────────────────────
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";
const XLSX_PATHS = [
  "C:/Users/y/Videos/판매가변경영상/2025 1~4월 야채매입상세.xlsx",
  "C:/Users/y/Videos/판매가변경영상/2025 5~8월 야채매입상세.xlsx",
  "C:/Users/y/Videos/판매가변경영상/2025 9~12월 야채매입상세.xlsx",
  "C:/Users/y/Videos/판매가변경영상/2026 1~5월 야채매입상세.xlsx",
];
const BATCH_SIZE = 500;

type ImportRow = {
  product_code: string;
  price_date: string;        // "YYYY-MM-DD"
  purchase_price: number;
  quantity: number | null;
  unit: string | null;
  supply_amount: number | null;
};

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
    if (!res.ok) throw new Error(`products fetch: ${res.status}`);
    const data = await res.json() as { product_code: string }[];
    if (data.length === 0) break;
    for (const d of data) all.add(d.product_code);
    if (data.length < limit) break;
    from += limit;
  }
  return all;
}

function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    // "2025-01-24" or "2025/01/24"
    const m = v.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // 엑셀 serial (number) 케이스 처리
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  return null;
}

function normalizeCode(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.padStart(6, "0");
}

async function batchInsert(rows: ImportRow[], key: string): Promise<{ inserted: number; skipped: number }> {
  // on_conflict 명시 + merge-duplicates → 동일 (product_code, price_date, purchase_price) 행은 덮어쓰기
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_purchase_prices?on_conflict=product_code,price_date,purchase_price`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`insert ${res.status}: ${txt.slice(0, 300)}`);
  }
  return { inserted: rows.length, skipped: 0 };
}

async function main() {
  const key = getKey();
  console.log("[1] products 마스터 코드 로딩...");
  const existing = await fetchExistingCodes(key);
  console.log(`    products 코드 ${existing.size}개`);

  console.log("[2] xlsx 파싱...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = [];
  for (const path of XLSX_PATHS) {
    if (!fs.existsSync(path)) {
      console.log(`    스킵 (없음): ${path}`);
      continue;
    }
    const wb = XLSX.readFile(path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
    console.log(`    ${path.split("/").pop()}: ${rows.length} 행`);
    raw.push(...rows);
  }
  console.log(`    원본 합계 ${raw.length} 행`);

  // ImportRow 변환 + 검증
  const rows: ImportRow[] = [];
  let badCount = 0, missingProductCount = 0;
  const missingCodes = new Set<string>();
  for (const r of raw) {
    const code = normalizeCode(r["코드"]);
    const date = normalizeDate(r["일자"]);
    const price = Number(r["단가"]);
    if (!code || !date || !price || price <= 0) { badCount++; continue; }
    if (!existing.has(code)) {
      missingProductCount++;
      missingCodes.add(code);
      continue;
    }
    rows.push({
      product_code: code,
      price_date: date,
      purchase_price: Math.round(price),
      quantity: r["수량"] != null ? Number(r["수량"]) : null,
      unit: r["단위"] ? String(r["단위"]) : null,
      supply_amount: r["공급가액"] != null ? Math.round(Number(r["공급가액"])) : null,
    });
  }
  console.log(`    유효 행: ${rows.length} / 결손 단가 ${badCount} / 마스터 미존재 코드 ${missingProductCount}건 (${missingCodes.size}개 코드)`);
  if (missingCodes.size > 0 && missingCodes.size <= 20) {
    console.log(`    누락 코드 샘플: ${[...missingCodes].slice(0, 20).join(", ")}`);
  }

  console.log("[3] daily_purchase_prices 배치 insert (UNIQUE 충돌 skip)...");
  let totalInserted = 0, totalSkipped = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { inserted, skipped } = await batchInsert(batch, key);
    totalInserted += inserted;
    totalSkipped += skipped;
    if (((i / BATCH_SIZE) % 10) === 0) {
      console.log(`    ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} (insert ${totalInserted} / skip ${totalSkipped})`);
    }
  }

  console.log(`\n결과: insert ${totalInserted} / skip ${totalSkipped} / 처리불가 ${badCount + missingProductCount}`);
  console.log(`   대상 상품 ${new Set(rows.map(r => r.product_code)).size}개`);
}

main().catch((e) => { console.error(e); process.exit(1); });
