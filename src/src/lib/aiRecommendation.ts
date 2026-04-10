// AI 추천가 산출 로직 (서버 사이드)
// S00-B 신호 해석층의 간이 구현
//
// 입력 신호:
// 1. 단기 (8일)  — 매입가 추세, 변곡점
// 2. 장기 (60일) — 지지선/저항선
// 3. 매출량       — 최근 3개월 월별 판매 수량 추세
// 4. 그룹 동조    — 같은 product_group / parent_product_code 의 추세 참조

export type PriceHistory = { date: string; price: number };

export type AiRecInput = {
  purchase_price: number;
  prev_purchase_price: number;
  current_selling_price: number;
  prev_selling_price: number;
  target_margin_rate: number | null;
  is_key_item: boolean;

  short_history: PriceHistory[]; // 8일
  long_history: PriceHistory[]; // 60일 (선택)

  monthly_sales: { sale_month: string; quantity: number }[]; // 최근 3~6개월
  prev_monthly_sales: { sale_month: string; quantity: number }[]; // 비교용 (직전 동일 기간)

  group_trend: "상승" | "하락" | "횡보" | null; // 같은 그룹의 평균 추세
};

export type AiRecOutput = {
  ai_price: number;
  ai_reason: string;
  signals: {
    short_trend: "상승" | "하락" | "횡보" | "변곡";
    long_support: number | null; // 지지선
    long_resistance: number | null; // 저항선
    sales_trend: "상승" | "하락" | "횡보" | null;
    sales_change_pct: number | null;
    group_trend: "상승" | "하락" | "횡보" | null;
    purchase_change_pct: number;
    current_margin: number;
  };
};

// ─────────────────────────────────────────
// 1. 단기 추세 판정 (8일 창)
// ─────────────────────────────────────────
function detectShortTrend(prices: number[]): "상승" | "하락" | "횡보" | "변곡" {
  const valid = prices.filter((p) => p > 0);
  if (valid.length < 3) return "횡보";
  const recent = valid.slice(-5);
  const diffs = recent.slice(1).map((p, i) => p - recent[i]);
  const ups = diffs.filter((d) => d > 0).length;
  const downs = diffs.filter((d) => d < 0).length;
  if (ups >= 3 && downs === 0) return "상승";
  if (downs >= 3 && ups === 0) return "하락";
  const lastDiff = diffs[diffs.length - 1] || 0;
  const prevDiff = diffs.length >= 2 ? diffs[diffs.length - 2] : 0;
  if ((lastDiff > 0 && prevDiff < 0) || (lastDiff < 0 && prevDiff > 0)) return "변곡";
  return "횡보";
}

// ─────────────────────────────────────────
// 2. 지지선/저항선 추출 (60일 창, 피벗 클러스터)
// ─────────────────────────────────────────
function extractSupport(longPrices: number[], currentPrice: number): { support: number | null; resistance: number | null } {
  const valid = longPrices.filter((p) => p > 0);
  if (valid.length < 10) return { support: null, resistance: null };

  // 피벗 저점: p[i-1] > p[i] < p[i+1]
  const pivotsLow: number[] = [];
  const pivotsHigh: number[] = [];
  for (let i = 1; i < valid.length - 1; i++) {
    if (valid[i] < valid[i - 1] && valid[i] < valid[i + 1]) pivotsLow.push(valid[i]);
    if (valid[i] > valid[i - 1] && valid[i] > valid[i + 1]) pivotsHigh.push(valid[i]);
  }

  // 클러스터링 (±2% 범위)
  const clusterize = (pivots: number[]) => {
    const clusters: { avg: number; count: number }[] = [];
    for (const p of pivots) {
      let found = false;
      for (const c of clusters) {
        if (Math.abs(c.avg - p) / c.avg < 0.02) {
          c.avg = (c.avg * c.count + p) / (c.count + 1);
          c.count++;
          found = true;
          break;
        }
      }
      if (!found) clusters.push({ avg: p, count: 1 });
    }
    return clusters.filter((c) => c.count >= 2).sort((a, b) => b.count - a.count);
  };

  const lowClusters = clusterize(pivotsLow);
  const highClusters = clusterize(pivotsHigh);

  // 현재가보다 낮은 저점 클러스터 중 가장 가까운 것 = 지지선
  const support = lowClusters
    .filter((c) => c.avg < currentPrice)
    .sort((a, b) => b.avg - a.avg)[0]?.avg || null;

  // 현재가보다 높은 고점 클러스터 중 가장 가까운 것 = 저항선
  const resistance = highClusters
    .filter((c) => c.avg > currentPrice)
    .sort((a, b) => a.avg - b.avg)[0]?.avg || null;

  return {
    support: support ? Math.round(support) : null,
    resistance: resistance ? Math.round(resistance) : null,
  };
}

// ─────────────────────────────────────────
// 3. 매출량 추세 (최근 vs 직전 동기)
// ─────────────────────────────────────────
function detectSalesTrend(
  recent: { sale_month: string; quantity: number }[],
  previous: { sale_month: string; quantity: number }[]
): { trend: "상승" | "하락" | "횡보" | null; change_pct: number | null } {
  if (!recent.length) return { trend: null, change_pct: null };

  const recentTotal = recent.reduce((s, r) => s + (r.quantity || 0), 0);
  const prevTotal = previous.reduce((s, r) => s + (r.quantity || 0), 0);

  if (recentTotal === 0 && prevTotal === 0) return { trend: null, change_pct: null };
  if (prevTotal === 0) return { trend: "상승", change_pct: null };

  const changePct = (recentTotal - prevTotal) / prevTotal;
  if (changePct > 0.15) return { trend: "상승", change_pct: changePct };
  if (changePct < -0.15) return { trend: "하락", change_pct: changePct };
  return { trend: "횡보", change_pct: changePct };
}

// ─────────────────────────────────────────
// 메인 추천 함수
// ─────────────────────────────────────────
export function calculateAiRecommendation(input: AiRecInput): AiRecOutput {
  const {
    purchase_price: pp,
    prev_purchase_price: prevPP,
    current_selling_price: cur,
    prev_selling_price: prev,
    target_margin_rate: targetM,
    is_key_item: isKey,
    short_history,
    long_history,
    monthly_sales,
    prev_monthly_sales,
    group_trend,
  } = input;

  const signals: AiRecOutput["signals"] = {
    short_trend: "횡보",
    long_support: null,
    long_resistance: null,
    sales_trend: null,
    sales_change_pct: null,
    group_trend: group_trend || null,
    purchase_change_pct: 0,
    current_margin: 0,
  };

  if (pp <= 0) {
    return {
      ai_price: 0,
      ai_reason: "매입가 없음 — 추천 불가",
      signals,
    };
  }

  const targetMargin = targetM || 20;
  const targetPrice = Math.ceil(pp / (1 - targetMargin / 100) / 10) * 10;
  const currentMargin = cur > 0 ? 1 - pp / cur : 0;
  const purchaseChange = prevPP > 0 ? (pp - prevPP) / prevPP : 0;

  signals.current_margin = currentMargin;
  signals.purchase_change_pct = purchaseChange;

  // 단기 추세
  const shortPrices = short_history.map((h) => h.price);
  signals.short_trend = detectShortTrend(shortPrices);

  // 장기 지지선/저항선
  const longPrices = long_history.map((h) => h.price);
  const { support, resistance } = extractSupport(longPrices, pp);
  signals.long_support = support;
  signals.long_resistance = resistance;

  // 매출량 추세
  const { trend: salesTrend, change_pct: salesChange } = detectSalesTrend(
    monthly_sales,
    prev_monthly_sales
  );
  signals.sales_trend = salesTrend;
  signals.sales_change_pct = salesChange;

  // ─────────────────────────────────────
  // 의사결정
  // ─────────────────────────────────────
  // ※ targetPrice(수익률일괄변경가)는 "역마진 / 긴급 가격 변경" 상황에만 사용한다.
  //    일상적인 추천가에서는 사용하지 않고, 사용자 수동 트리거(UI의 '수익률일괄변경 실행'
  //    버튼)로만 적용한다. 그 외는 매입 변동·추세 기반 점진적 조정을 추천한다.
  const reasons: string[] = [];
  let aiPrice: number;

  // (A) 역마진 발생 — 긴급 상황: targetPrice 적용
  //     판매가가 매입가보다 낮아 손실이 나는 경우에 한해서만 일괄변경가 제안
  if (cur > 0 && cur <= pp) {
    aiPrice = targetPrice;
    reasons.push(
      `역마진 발생(판매가 ${cur.toLocaleString()}원 ≤ 매입가 ${pp.toLocaleString()}원) → 수익률일괄변경가 ${targetPrice.toLocaleString()}원 긴급 적용 권장`
    );
  }
  // (B) 매입 급등 + 상승 추세 — 상승분 100% 반영 (점진적 인상)
  else if (purchaseChange > 0.05 && signals.short_trend === "상승") {
    const adjustment = Math.round(pp - prevPP);
    aiPrice = Math.ceil((prev + adjustment) / 10) * 10;
    reasons.push(
      `매입가 ${(purchaseChange * 100).toFixed(1)}% 급등 + 단기 상승추세 → 상승분 전액 반영 (+${adjustment.toLocaleString()}원)`
    );
  }
  // (C) 매입 상승 (3~5%)
  else if (purchaseChange > 0.03) {
    const adjustment = Math.round((pp - prevPP) * 0.7);
    aiPrice = Math.ceil((prev + adjustment) / 10) * 10;
    reasons.push(
      `매입가 ${(purchaseChange * 100).toFixed(1)}% 상승 → 상승분의 70% 반영 (${adjustment}원)`
    );
  }
  // (D) 매입 급락 + 하락추세 — 하락분 50%만 반영 (마진 확보)
  else if (purchaseChange < -0.05 && signals.short_trend === "하락") {
    const adjustment = Math.round((pp - prevPP) * 0.5);
    aiPrice = Math.ceil((prev + adjustment) / 10) * 10;
    reasons.push(
      `매입가 ${(Math.abs(purchaseChange) * 100).toFixed(1)}% 하락 + 하락추세 → 하락분의 50%만 반영 (마진 확보)`
    );
  }
  // (E) 변곡점 — 관망
  else if (signals.short_trend === "변곡") {
    aiPrice = prev || cur;
    reasons.push(`매입 추세 전환(변곡점) 감지 → 1~2일 관망 권장`);
  }
  // (F) 기본 — 현재가 유지
  else {
    aiPrice = cur;
    reasons.push(
      `매입가 변동 ${(purchaseChange * 100).toFixed(1)}% + ${signals.short_trend} → 현재가 유지`
    );
  }

  // ─────────────────────────────────────
  // 보정 신호 (매출량, 지지선, 그룹)
  // ─────────────────────────────────────

  // 저수익 경고 — 역마진은 아니지만 수익률이 매우 낮은 경우 안내만 추가 (가격은 건드리지 않음)
  if (cur > pp && currentMargin < 0.1) {
    reasons.push(
      `수익률 ${(currentMargin * 100).toFixed(1)}%로 낮음 — 급한 경우 '수익률일괄변경 실행'으로 ${targetPrice.toLocaleString()}원(수익률 ${targetMargin}%)까지 상향 가능`
    );
  }

  // 매출량 급락 — 가격 인하 유도
  if (salesTrend === "하락" && salesChange !== null && salesChange < -0.2) {
    const reducedPrice = Math.ceil((aiPrice * 0.97) / 10) * 10;
    if (reducedPrice > pp / 0.9) {
      aiPrice = reducedPrice;
      reasons.push(
        `매출량 ${(salesChange * 100).toFixed(0)}% 급감 → 판매 촉진을 위해 3% 추가 인하`
      );
    }
  }
  // 매출량 급증 + 매입 상승 — 가격 인상 여력
  else if (
    salesTrend === "상승" &&
    salesChange !== null &&
    salesChange > 0.2 &&
    purchaseChange > 0
  ) {
    reasons.push(
      `매출량 ${(salesChange * 100).toFixed(0)}% 증가 → 인상 여력 있음`
    );
  }

  // 지지선 근접 — 과도한 인하 방지
  if (support !== null && aiPrice > 0) {
    const minFromSupport = Math.ceil(support / (1 - targetMargin / 100) / 10) * 10;
    if (aiPrice < minFromSupport && purchaseChange >= 0) {
      reasons.push(
        `장기 지지선 ${support.toLocaleString()}원 확인 → 과도한 인하 방지`
      );
      aiPrice = minFromSupport;
    }
  }

  // 그룹 추세 반영 — 매입 이력이 없는 소분상품에 특히 유용
  if (group_trend && purchaseChange === 0) {
    if (group_trend === "상승") {
      reasons.push(`동일 그룹 원물 상승 추세 → 인상 고려 권장`);
    } else if (group_trend === "하락") {
      reasons.push(`동일 그룹 원물 하락 추세 → 인하 여지 있음`);
    }
  }

  // 주요 경쟁품목 가드 — 너무 공격적인 인상 억제
  if (isKey && aiPrice > cur * 1.05) {
    reasons.push(`주요 경쟁품목 → 5% 이상 인상 억제`);
    aiPrice = Math.ceil((cur * 1.05) / 10) * 10;
  }

  // 최소 마진 하한 (5%)
  const minPrice = Math.ceil(pp / 0.95 / 10) * 10;
  if (aiPrice < minPrice && pp > 0) {
    aiPrice = minPrice;
    reasons.push(`최소 마진 5% 하한선 적용`);
  }

  return {
    ai_price: aiPrice,
    ai_reason: reasons.join(". "),
    signals,
  };
}
