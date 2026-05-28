// ────────────────────────────────────────────────
// 학습 tier 재계산 (CLI) — Postgres learn_tiers() RPC 호출
//
// 동작:
//   - 365일 매입가 기반 그룹·unit 내 NTILE(3) 자동 산출
//   - products.learned_tier / learned_median_price / learned_n_samples / learned_at 갱신
//
// 사용:
//   npx tsx scripts/learn-tiers.ts                # 365일 (default)
//   npx tsx scripts/learn-tiers.ts --days=180     # 180일
// ────────────────────────────────────────────────
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

function getKey(): string {
  const env = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const m = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  if (!m) throw new Error(".env.local 에 NEXT_PUBLIC_SUPABASE_ANON_KEY 없음");
  return m[1].trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const daysArg = argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? parseInt(daysArg) : 365;

  console.log(`[learn-tiers] 최근 ${days}일 매입 이력으로 그룹·unit 내 NTILE(3) 학습`);
  const key = getKey();

  const start = Date.now();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/learn_tiers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ days }),
  });

  if (!res.ok) {
    console.error(`RPC 실패 ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data = (await res.json()) as Array<{
    updated: number; tier1: number; tier2: number; tier3: number;
  }>;
  const r = data[0];
  const elapsed = Date.now() - start;
  console.log(`완료 (${elapsed}ms): ${r.updated}개 갱신 — tier1=${r.tier1} / tier2=${r.tier2} / tier3=${r.tier3}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
