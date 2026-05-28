// ────────────────────────────────────────────────
// 통합 매출 파일 → sales_detail 백필 (일회성)
//
// 동작:
//  1. 매출 폴더의 통합 파일 (식봄/신선행/온일장/배민 매출상세) 읽음
//  2. 파일명에서 채널 추출
//  3. sales_detail 에 채널과 함께 UPSERT (자동키 = date_code_channel_qty_price)
//
// 일자 RAW (ROWKEY 있는 파일) 은 제외 — 이미 sales_detail 에 있음
// ────────────────────────────────────────────────
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";
const FOLDER = "C:/Users/y/Videos/판매가변경영상/매출";

function detectChannelFromFilename(filename: string): string | null {
  if (filename.includes("식봄")) return "식봄";
  if (filename.includes("신선행")) return "신선행";
  if (filename.includes("온일장")) return "온일장";
  if (filename.includes("배민")) return "배민";
  return null;
}

function getKey(): string {
  const env = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const m = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  if (!m) throw new Error(".env.local 에 NEXT_PUBLIC_SUPABASE_ANON_KEY 없음");
  return m[1].trim();
}

function padCode(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.includes("합계")) return null;
  return s.padStart(6, "0");
}

function parseDateRaw(v: unknown): string | null {
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

async function fetchProductCodes(key: string): Promise<Set<string>> {
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

async function main() {
  const key = getKey();

  console.log("[1] products 코드");
  const valid = await fetchProductCodes(key);
  console.log(`    ${valid.size}개`);

  console.log("[2] 통합 매출 파일 처리");
  const files = fs.readdirSync(FOLDER).filter((f) => f.endsWith(".xlsx"));
  // 통합파일만: 파일명에 채널 포함 + 일자 RAW 패턴(YYYYMMDD) 제외
  const integFiles = files.filter((f) => {
    const ch = detectChannelFromFilename(f);
    if (!ch) return false;
    if (/^\d{8}\s/.test(f)) return false;
    return true;
  });

  const records: Record<string, unknown>[] = [];
  for (const fname of integFiles) {
    const ch = detectChannelFromFilename(fname)!;
    const fp = path.join(FOLDER, fname);
    const wb = XLSX.readFile(fp);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]], { defval: null });
    let added = 0, badCode = 0, badDate = 0, badQty = 0, missing = 0;

    for (const r of rows) {
      const code = padCode(r["기본코드"] ?? r["코드"]);
      if (!code) { badCode++; continue; }
      if (!valid.has(code)) { missing++; continue; }
      const date = parseDateRaw(r["일자"]);
      if (!date) { badDate++; continue; }
      const qty = Number(r["수량"]) || 0;
      if (qty <= 0) { badQty++; continue; }
      const unitPrice = Math.round(Number(r["단가"] ?? r["단  가"]) || 0);
      const platform = (r["거래처"] || null) as string | null;
      const rowKey = `${date}_${code}_${ch}_${qty}_${unitPrice}`;

      records.push({
        sale_date: date,
        product_code: code,
        product_name: (r["상품명"] ?? r["상  품  명"]) || null,
        spec: (r["규격"] ?? r["규  격"]) || null,
        unit: r["단위"] || null,
        quantity: qty,
        unit_price: unitPrice,
        supply_amount: Math.round(Number(r["공급가액"]) || 0) || null,
        total_amount: Math.round(Number(r["합계액"]) || 0) || null,
        purchase_price: Math.round(Number(r["매입가"]) || 0) || null,
        selling_price: Math.round(Number(r["매출가"] ?? r["단가"] ?? r["단  가"]) || 0) || null,
        margin_rate: null,
        platform,
        row_key: rowKey,
        channel: ch,
      });
      added++;
    }
    console.log(`    ${fname} (${ch}): +${added} (badCode ${badCode}, badDate ${badDate}, badQty ${badQty}, missing ${missing})`);
  }

  console.log(`[3] sales_detail upsert (${records.length}건)`);
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sales_detail?on_conflict=row_key`,
      {
        method: "POST",
        headers: {
          apikey: key, Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      }
    );
    if (!res.ok) {
      console.error(`upsert ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    inserted += batch.length;
    if (i % 2500 === 0) console.log(`    ${Math.min(i + BATCH, records.length)}/${records.length}`);
  }
  console.log(`[4] 완료. ${inserted}건 처리`);

  // RPC 재호출로 monthly 갱신
  console.log("[5] recompute_monthly_sales (since 2026-02-01)");
  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/recompute_monthly_sales`, {
    method: "POST",
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ since_month: "2026-02-01" }),
  });
  console.log(`    RPC status ${rpcRes.status}: ${await rpcRes.text()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
