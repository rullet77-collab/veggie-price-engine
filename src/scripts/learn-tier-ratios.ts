// Tier 비율 학습 CLI
//
// 사용법:
//   npx tsx scripts/learn-tier-ratios.ts            // 365일 (default)
//   npx tsx scripts/learn-tier-ratios.ts --days=180 // 180일
//
// 학습된 결과는 group_tier_ratios 테이블에 upsert. AI 추천 엔진이 자동 활용.

import { learnTierRatios } from "../src/lib/tierRatios";

async function main() {
  const argv = process.argv.slice(2);
  const daysArg = argv.find((a) => a.startsWith("--days="))?.split("=")[1];
  const days = daysArg ? parseInt(daysArg) : 365;

  console.log(`Tier 비율 학습 시작 — 지난 ${days}일 매입 이력 분석...`);
  const start = Date.now();
  const result = await learnTierRatios(days);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n결과 (${elapsed}s):`);
  console.log(`  학습된 tier 페어:  ${result.learnedPairs}건`);
  console.log(`  총 샘플 수:        ${result.totalSamples}건 (페어×공통일)`);
  console.log(`  그룹별 샘플 분포:`);
  const groupEntries = Object.entries(result.byGroup).sort((a, b) => b[1] - a[1]);
  for (const [groupId, count] of groupEntries.slice(0, 10)) {
    console.log(`    group ${groupId.padStart(3)}: ${count}건`);
  }
  if (groupEntries.length > 10) console.log(`    ... 외 ${groupEntries.length - 10}개 그룹`);
}

main().catch((e) => {
  console.error("학습 실패:", e);
  process.exit(1);
});
