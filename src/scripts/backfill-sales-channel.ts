// ────────────────────────────────────────────────
// sales_detail.channel 백필 스크립트
//
// 동작:
//  1. 매출 폴더의 모든 xlsx 파일을 읽어 ROWKEY → 채널 매핑 빌드
//  2. sales_detail 의 channel IS NULL 인 행을 ROWKEY 기반 UPDATE
//
// 채널 매핑 규칙:
//  - 채널 단일 파일 (파일명 기반): "2026 4월 식봄 매출상세.xlsx" 등 → 파일명에서 채널 추출
//  - RAW 파일 (그룹명 컬럼): "20260507 매출상세.xlsx" → 그룹명에서 채널 추출
// ────────────────────────────────────────────────
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";
const FOLDER = "C:/Users/y/Videos/판매가변경영상/매출";

function detectSourceFromFilename(filename: string): string | null {
  if (filename.includes("식봄")) return "식봄";
  if (filename.includes("신선행")) return "신선행";
  if (filename.includes("온일장")) return "온일장";
  if (filename.includes("배민")) return "배민";
  return null;
}

function detectChannelFromGroup(groupName: string): string | null {
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

async function main() {
  const key = getKey();

  console.log("[1] 매출 xlsx 폴더 ROWKEY → 채널 매핑 빌드");
  const files = fs.readdirSync(FOLDER).filter((f) => f.endsWith(".xlsx"));
  const rkChannel = new Map<string, string>();

  for (const filename of files) {
    const filepath = path.join(FOLDER, filename);
    const wb = XLSX.readFile(filepath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]], { defval: null });
    const fileSource = detectSourceFromFilename(filename);
    let added = 0;

    for (const r of rows) {
      const rk = String(r["ROWKEY"] || "");
      if (!rk) continue;
      let ch: string | null;
      if (fileSource) ch = fileSource;
      else ch = detectChannelFromGroup(String(r["그룹명"] || ""));
      if (!ch) continue;
      if (!rkChannel.has(rk)) {
        rkChannel.set(rk, ch);
        added++;
      }
    }
    console.log(`    ${filename}: +${added} (누적 ${rkChannel.size})`);
  }

  console.log(`[2] 매핑 완료: ${rkChannel.size} ROWKEY`);

  console.log("[3] sales_detail.channel IS NULL 인 row_key 가져오기");
  const targetKeys: string[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/sales_detail?channel=is.null&select=row_key&limit=${PAGE}&offset=${from}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const data = (await res.json()) as { row_key: string }[];
    if (data.length === 0) break;
    for (const d of data) targetKeys.push(d.row_key);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`    채널 NULL 행수: ${targetKeys.length}`);

  console.log("[4] UPDATE — 채널별 그룹화 후 batch UPDATE");
  // ROWKEY 들을 채널별로 묶어서 한 번에 UPDATE
  const byChannel = new Map<string, string[]>();
  let unmapped = 0;
  for (const rk of targetKeys) {
    const ch = rkChannel.get(rk);
    if (!ch) { unmapped++; continue; }
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(rk);
  }
  console.log(`    매핑 안된 ROWKEY (스킵): ${unmapped}`);

  let updated = 0;
  for (const [ch, rks] of byChannel.entries()) {
    const BATCH = 200; // URL 길이 제한 회피
    for (let i = 0; i < rks.length; i += BATCH) {
      const batch = rks.slice(i, i + BATCH);
      const inList = batch.map((k) => `"${k}"`).join(",");
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/sales_detail?row_key=in.(${inList})`,
        {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ channel: ch }),
        }
      );
      if (!res.ok) {
        console.error(`UPDATE ${ch} 실패: ${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      updated += batch.length;
    }
    console.log(`    ${ch}: ${rks.length}건 update`);
  }
  console.log(`완료. 총 ${updated}건 update`);
}

main().catch((e) => { console.error(e); process.exit(1); });
