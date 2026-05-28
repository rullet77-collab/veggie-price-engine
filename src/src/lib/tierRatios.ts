// Tier 가격비율 학습/조회 (B-3 지원)
//
// 그룹 내 등급(tier) 별 가격 차이를 매입 이력에서 empirical 하게 학습.
// 같은 날짜에 다른 등급 박스가 동시 매입된 경우 그 비율을 수집해 median 산출.
//
// ─ 데이터 흐름 ─
//   daily_purchase_prices (1년치+)
//     → 같은 그룹의 두 product 페어 × 공통 매입일 → 가격비
//     → tier 페어로 그룹화 → median
//     → group_tier_ratios 테이블에 저장
//
// ─ 사용 ─
//   AI 추천 엔진에서 다른 tier anchor 사용 시 비율 보정:
//     inferred_price = (anchor_price / unit_ratio) × tier_ratio

import { supabase } from "./supabase";
import { getGradeTier, getUnitConversionRatio } from "./aiRecommendation";

export type TierRatio = {
  product_group: number;
  tier_a: number;
  tier_b: number;
  ratio: number;        // price_at_tier_a / price_at_tier_b
  sample_count: number;
};

type ProdRow = {
  product_code: string;
  product_name: string | null;
  product_group: number | null;
  unit: string | null;
  spec: string | null;
};

type PurchRow = {
  product_code: string;
  price_date: string;
  purchase_price: number;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 그룹별 tier 페어 비율 학습
 *  - 입력: 지난 N일 매입 이력
 *  - 출력: group_tier_ratios 테이블에 upsert
 *  - 반환: 학습된 페어 수
 */
export async function learnTierRatios(daysBack = 365): Promise<{
  learnedPairs: number;
  totalSamples: number;
  byGroup: Record<number, number>;
}> {
  // 1) 모든 products
  const { data: prodsData } = await supabase
    .from("products")
    .select("product_code,product_name,product_group,unit,spec");
  const products = (prodsData || []) as ProdRow[];

  // 2) 그룹별 멤버
  const byGroup = new Map<number, ProdRow[]>();
  for (const p of products) {
    if (!p.product_group) continue;
    if (!byGroup.has(p.product_group)) byGroup.set(p.product_group, []);
    byGroup.get(p.product_group)!.push(p);
  }

  // 3) 매입 이력 (지난 N일)
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);

  // 페이지네이션
  const allPurchases: PurchRow[] = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("daily_purchase_prices")
      .select("product_code,price_date,purchase_price")
      .gte("price_date", sinceStr)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allPurchases.push(...(data as PurchRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // 4) 인덱스: date → product_code → price
  const priceByDateAndCode = new Map<string, Map<string, number>>();
  for (const p of allPurchases) {
    if (!priceByDateAndCode.has(p.price_date)) priceByDateAndCode.set(p.price_date, new Map());
    priceByDateAndCode.get(p.price_date)!.set(p.product_code, p.purchase_price);
  }

  // 5) 그룹별, 페어별 ratio 수집 후 tier 페어로 집계
  const tierPairAccum = new Map<string, number[]>(); // "groupId-tierA-tierB" → [페어 median ratios]
  const groupSampleCount: Record<number, number> = {};

  for (const [groupId, members] of byGroup.entries()) {
    if (members.length < 2) continue;

    for (let i = 0; i < members.length; i++) {
      for (let j = 0; j < members.length; j++) {
        if (i === j) continue;
        const a = members[i];
        const b = members[j];
        const tierA = getGradeTier(a.product_name);
        const tierB = getGradeTier(b.product_name);
        if (tierA === tierB) continue;

        // unit 환산 가능 + ratio ≤ 2 페어만 (cross-unit 노이즈 제외)
        const conv = getUnitConversionRatio(b.unit, b.spec, a.unit, a.spec);
        if (!conv) continue;
        if (conv.ratio < 0.5 || conv.ratio > 2) continue;

        const pairRatios: number[] = [];
        for (const [, codeMap] of priceByDateAndCode) {
          const pa = codeMap.get(a.product_code);
          const pb = codeMap.get(b.product_code);
          if (!pa || !pb || pa <= 0 || pb <= 0) continue;
          const bInAUnit = pb / conv.ratio;
          if (bInAUnit > 0) pairRatios.push(pa / bInAUnit);
        }

        if (pairRatios.length < 3) continue; // 최소 3페어

        const pairMedian = median(pairRatios);
        const key = `${groupId}-${tierA}-${tierB}`;
        if (!tierPairAccum.has(key)) tierPairAccum.set(key, []);
        tierPairAccum.get(key)!.push(pairMedian);
        groupSampleCount[groupId] = (groupSampleCount[groupId] || 0) + pairRatios.length;
      }
    }
  }

  // 6) 집계 → DB upsert
  let learnedPairs = 0;
  let totalSamples = 0;
  const upserts: TierRatio[] = [];
  for (const [key, medians] of tierPairAccum) {
    const [groupId, tierA, tierB] = key.split("-").map(Number);
    if (medians.length === 0) continue;
    const finalRatio = median(medians);
    if (!isFinite(finalRatio) || finalRatio <= 0) continue;
    upserts.push({
      product_group: groupId,
      tier_a: tierA,
      tier_b: tierB,
      ratio: Math.round(finalRatio * 10000) / 10000,
      sample_count: medians.length,
    });
    learnedPairs++;
    totalSamples += medians.length;
  }

  if (upserts.length > 0) {
    const { error } = await supabase
      .from("group_tier_ratios")
      .upsert(
        upserts.map((u) => ({ ...u, last_calibrated: new Date().toISOString() })),
        { onConflict: "product_group,tier_a,tier_b" }
      );
    if (error) throw error;
  }

  return { learnedPairs, totalSamples, byGroup: groupSampleCount };
}

/**
 * 학습된 비율 전체 로드 (메모리 캐시용)
 *  반환: Map<"groupId-tierA-tierB", ratio>
 */
export async function loadTierRatios(): Promise<Map<string, number>> {
  const { data } = await supabase
    .from("group_tier_ratios")
    .select("product_group,tier_a,tier_b,ratio");
  const result = new Map<string, number>();
  for (const r of (data || []) as TierRatio[]) {
    result.set(`${r.product_group}-${r.tier_a}-${r.tier_b}`, Number(r.ratio));
  }
  return result;
}

/**
 * tier 페어 비율 조회. 직접 학습 안 됐어도 reverse 또는 transitive 로 추정.
 *  - direct: (tier_a, tier_b) → 그대로
 *  - reverse: (tier_b, tier_a) 학습됐으면 1/그값
 *  - transitive: 미구현 (필요시 그래프 BFS)
 *
 *  반환 의미: target(tier_a) = anchor(tier_b) × ratio
 */
export function getTierRatio(
  ratios: Map<string, number>,
  productGroup: number,
  tierA: number,
  tierB: number
): number | null {
  if (tierA === tierB) return 1;
  const direct = ratios.get(`${productGroup}-${tierA}-${tierB}`);
  if (direct != null && direct > 0) return direct;
  const reverse = ratios.get(`${productGroup}-${tierB}-${tierA}`);
  if (reverse != null && reverse > 0) return 1 / reverse;
  return null;
}
