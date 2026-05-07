// ────────────────────────────────────────────────
// 매출상세 xlsx 모두 → monthly_sales_quantity (4채널: 식봄/신선행/온일장/배민)
//
// 2가지 파일 포맷:
//  A. 채널 단일 파일 — 파일명에서 채널 + 일자 컬럼에서 sale_month 추출
//     · "2026 2월 식봄 매출상세.xlsx"
//     · "2026 3월 식봄 매출상세.xlsx"
//     · "2026 4월 식봄 매출상세.xlsx"
//     · "2026 5월1~6일까지 식봄 매출상세.xlsx"
//     · "2026 2월1일~5월6일까지 배민상회 매출상세.xlsx"
//     · "2026 2월1일~5월6일까지 신선행 매출상세.xlsx"
//     · "2026 2월1일~5월6일까지 온일장 매출상세.xlsx"
//  B. 일자 RAW — "그룹명" 컬럼에서 채널 추출
//     · "20260507 매출상세.xlsx"
//
// 동작:
//  1. monthly_sales_quantity 전체 삭제 (clean import)
//  2. 모든 파일 파싱
//  3. (product_code, sale_month, source) 별 quantity 합산
//  4. upsert
// ────────────────────────────────────────────────
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";
const FOLDER = "C:/Users/y/Videos/판매가변경영상/매출";

// 파일명 → 채널 매핑
function detectSourceFromFilename(filename: string): string | null {
  if (filename.includes("식봄")) return "식봄";
  if (filename.includes("신선행")) return "신선행";
  if (filename.includes("온일장")) return "온일장";
  if (filename.includes("배민")) return "배민";
  return null;
}

// 그룹명 → 채널 (RAW 파일용)
function detectSourceFromGroup(groupName: string): string | null {
  const g = groupName.replace(/▣/g, "").trim();
  if (g.startsWith("식봄")) return "식봄";
  if (g.startsWith("신선행")) return "신선행";
  if (g.startsWith("온일장")) return "온일장";
  if (g.startsWith("배민")) return "배민";
  return null;
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
  if (!s || s.includes("합계")) return null;
  return s.padStart(6, "0");
}

function normalizeDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    const m = v.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  return null;
}

async function main() {
  const key = getKey();

  console.log("[1] products 코드");
  const existing = await fetchExistingCodes(key);
  console.log(`    ${existing.size}개`);

  console.log("[2] 기존 monthly_sales_quantity 삭제");
  const delRes = await fetch(`${SUPABASE_URL}/rest/v1/monthly_sales_quantity?id=gte.0`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  console.log(`    DELETE status ${delRes.status}`);

  console.log("[3] 매출 폴더 파일 처리");
  const files = fs.readdirSync(FOLDER).filter((f) => f.endsWith(".xlsx"));
  // 키: code__saleMonth__source → quantity
  const agg = new Map<string, { product_code: string; sale_month: string; source: string; quantity: number }>();
  let totalRows = 0, badDate = 0, badCode = 0, missingProduct = 0, badQty = 0, otherSource = 0;

  for (const filename of files) {
    const filepath = path.join(FOLDER, filename);
    const wb = XLSX.readFile(filepath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]], { defval: null });
    const fileSource = detectSourceFromFilename(filename);
    const isRaw = !fileSource;  // 파일명에 채널 정보 없으면 그룹명 컬럼 사용 (RAW 파일)
    console.log(`    ${filename}: ${rows.length}행 (${isRaw ? "RAW(그룹명)" : "채널=" + fileSource})`);

    for (const r of rows) {
      totalRows++;
      const code = normalizeCode(r["코드"] ?? r["기본코드"]);
      if (!code) { badCode++; continue; }
      if (!existing.has(code)) { missingProduct++; continue; }

      const dateRaw = r["일자"];
      const date = normalizeDate(dateRaw);
      if (!date) { badDate++; continue; }
      const saleMonth = date.slice(0, 7) + "-01";

      const qty = Number(r["수량"]) || 0;
      if (qty <= 0) { badQty++; continue; }

      let source: string | null;
      if (fileSource) source = fileSource;
      else source = detectSourceFromGroup(String(r["그룹명"] || ""));
      if (!source) { otherSource++; continue; }

      const k = `${code}__${saleMonth}__${source}`;
      const cur = agg.get(k);
      if (cur) cur.quantity += qty;
      else agg.set(k, { product_code: code, sale_month: saleMonth, source, quantity: qty });
    }
  }
  console.log(`    원본 ${totalRows} → 집계 ${agg.size} / badDate ${badDate} / badCode ${badCode} / missingProduct ${missingProduct} / badQty ${badQty} / 기타source ${otherSource}`);

  console.log("[4] upsert");
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
    if (!res.ok) throw new Error(`insert ${res.status}: ${(await res.text()).slice(0, 300)}`);
    inserted += batch.length;
    if (i % 2500 === 0) console.log(`    ${Math.min(i + BATCH, records.length)}/${records.length}`);
  }
  console.log(`완료. ${inserted}건 upsert`);
}

main().catch((e) => { console.error(e); process.exit(1); });
