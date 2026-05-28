// 야채판매현황260512.xlsx → products 동기화 v2
// Step 1: 신규 코드 INSERT (모든 NOT NULL 컬럼 포함)
// Step 2: 기존 코드 PATCH (product_type, platform_status 만)
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";
const SOURCE_FILE = "C:/Users/y/Videos/판매가변경영상/야채판매현황260512.xlsx";

function getKey(): string {
  const env = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const m = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  if (!m) throw new Error(".env.local 에 NEXT_PUBLIC_SUPABASE_ANON_KEY 없음");
  return m[1].trim();
}

type SheetRow = {
  product_code: string;
  category_name: string | null;
  product_group: number | null;
  product_name: string | null;
  spec: string | null;
  unit: string | null;
};

function parseSheet(sheet: XLSX.WorkSheet): SheetRow[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });
  return rows
    .filter((r) => r["상품코드(수정금지)"])
    .map((r) => ({
      product_code: String(r["상품코드(수정금지)"]).padStart(6, "0"),
      category_name: r["소분류명(천년)"] || null,
      product_group: r["상품그룹"] ? parseInt(String(r["상품그룹"]), 10) : null,
      product_name: r["상품명"] || null,
      spec: r["규격"] || null,
      unit: r["단위"] || null,
    }));
}

async function fetchExistingCodes(key: string): Promise<Set<string>> {
  const all = new Set<string>();
  let from = 0;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products?select=product_code&limit=1000&offset=${from}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const data = (await res.json()) as { product_code: string }[];
    if (data.length === 0) break;
    for (const d of data) all.add(d.product_code);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function bulkPatch(key: string, codes: string[], payload: Record<string, unknown>) {
  if (codes.length === 0) return 0;
  const BATCH = 100; // URL 길이 보수적
  let updated = 0;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const inList = batch.map((c) => `"${c}"`).join(",");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products?product_code=in.(${inList})`,
      {
        method: "PATCH",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      console.error(`  PATCH ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    updated += batch.length;
  }
  return updated;
}

async function bulkInsert(key: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return 0;
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/products`,
      {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(batch),
      }
    );
    if (!res.ok) {
      console.error(`  INSERT ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    inserted += batch.length;
  }
  return inserted;
}

async function main() {
  const key = getKey();

  console.log("[1] 야채판매현황 파싱");
  const wb = XLSX.readFile(SOURCE_FILE);
  const active = parseSheet(wb.Sheets["판매중상품260512기준"]);
  const inactive = parseSheet(wb.Sheets["판매중지상품260512기준"]);
  console.log(`    판매중 ${active.length} / 판매중지 ${inactive.length}`);

  // 중복 제거 — 시트 내 동일 코드 (003021 같이 2회 등장) → 첫 행만
  function dedup(rows: SheetRow[]): SheetRow[] {
    const seen = new Set<string>();
    const out: SheetRow[] = [];
    for (const r of rows) {
      if (seen.has(r.product_code)) continue;
      seen.add(r.product_code);
      out.push(r);
    }
    return out;
  }
  const activeDedup = dedup(active);
  const inactiveDedup = dedup(inactive);
  // 시트 간 중복 — 판매중지 우선
  const inactiveCodes = new Set(inactiveDedup.map((r) => r.product_code));
  const dedupedActive = activeDedup.filter((r) => !inactiveCodes.has(r.product_code));
  console.log(`    시트내 dedup active ${activeDedup.length} / inactive ${inactiveDedup.length}`);
  console.log(`    시트간 dedup active ${dedupedActive.length}`);

  console.log("[2] 기존 products 코드");
  const existing = await fetchExistingCodes(key);
  console.log(`    ${existing.size}개`);

  // 분류
  const activeExistingCodes: string[] = [];
  const activeNewRows: Record<string, unknown>[] = [];
  const inactiveExistingCodes: string[] = [];
  const inactiveNewRows: Record<string, unknown>[] = [];

  for (const r of dedupedActive) {
    if (existing.has(r.product_code)) {
      activeExistingCodes.push(r.product_code);
    } else {
      activeNewRows.push({
        product_code: r.product_code,
        product_name: r.product_name || `(미설정) ${r.product_code}`,
        spec: r.spec, unit: r.unit, category_name: r.category_name,
        product_group: r.product_group,
        product_type: "야채", platform_status: "판매중",
        is_key_item: false, is_event_item: false,
      });
    }
  }
  for (const r of inactiveDedup) {
    if (existing.has(r.product_code)) {
      inactiveExistingCodes.push(r.product_code);
    } else {
      inactiveNewRows.push({
        product_code: r.product_code,
        product_name: r.product_name || `(미설정) ${r.product_code}`,
        spec: r.spec, unit: r.unit, category_name: r.category_name,
        product_group: r.product_group,
        product_type: "야채", platform_status: "판매중지",
        is_key_item: false, is_event_item: false,
      });
    }
  }

  console.log(`[3] 기존 PATCH: 판매중 ${activeExistingCodes.length} / 판매중지 ${inactiveExistingCodes.length}`);
  console.log(`    신규 INSERT: 판매중 ${activeNewRows.length} / 판매중지 ${inactiveNewRows.length}`);

  console.log("[4] 기존 PATCH 실행");
  const u1 = await bulkPatch(key, activeExistingCodes, { product_type: "야채", platform_status: "판매중" });
  console.log(`    판매중 PATCH ${u1}`);
  const u2 = await bulkPatch(key, inactiveExistingCodes, { product_type: "야채", platform_status: "판매중지" });
  console.log(`    판매중지 PATCH ${u2}`);

  console.log("[5] 신규 INSERT 실행");
  const i1 = await bulkInsert(key, activeNewRows);
  console.log(`    판매중 INSERT ${i1}`);
  const i2 = await bulkInsert(key, inactiveNewRows);
  console.log(`    판매중지 INSERT ${i2}`);

  console.log("[6] 검증");
  const verifyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/products?product_type=eq.야채&select=platform_status&limit=2000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const verify = (await verifyRes.json()) as { platform_status: string | null }[];
  const counts = { 판매중: 0, 판매중지: 0, null: 0 };
  for (const v of verify) {
    if (v.platform_status === "판매중") counts.판매중++;
    else if (v.platform_status === "판매중지") counts.판매중지++;
    else counts.null++;
  }
  console.log(`    야채 총 ${verify.length} = 판매중 ${counts.판매중} / 판매중지 ${counts.판매중지} / null ${counts.null}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
