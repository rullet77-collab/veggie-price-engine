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
// 1. 단기 추세 판정 (8일 창) — 상세 분석
// ─────────────────────────────────────────
type ShortTrendDetail = {
  label: "상승" | "하락" | "횡보" | "변곡";
  total_change_pct: number;       // 8일 전체 변동률 (첫날→마지막날)
  recent_3d_change_pct: number;   // 최근 3일 변동률
  consecutive_up: number;         // 최근 연속 상승일수
  consecutive_down: number;       // 최근 연속 하락일수
  max_price: number;
  min_price: number;
  volatility: number;             // 변동성 (일간 변동률의 표준편차)
  day_count: number;              // 유효 데이터 일수
  description: string;            // 사람이 읽을 수 있는 8일 분석 요약
};

function analyzeShortTrend(history: PriceHistory[]): ShortTrendDetail {
  const valid = history.filter((h) => h.price > 0);
  const prices = valid.map((h) => h.price);
  const dates = valid.map((h) => h.date);

  const empty: ShortTrendDetail = {
    label: "횡보", total_change_pct: 0, recent_3d_change_pct: 0,
    consecutive_up: 0, consecutive_down: 0,
    max_price: 0, min_price: 0, volatility: 0, day_count: 0,
    description: "매입 이력 부족",
  };

  if (prices.length < 2) return empty;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const totalChange = (last - first) / first;

  // 최근 3일 변동률
  const recent3Start = prices.length >= 3 ? prices[prices.length - 3] : first;
  const recent3Change = recent3Start > 0 ? (last - recent3Start) / recent3Start : 0;

  // 일간 변동률
  const dailyChanges: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) dailyChanges.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  // 연속 상승/하락 일수 (가장 최근부터 역순)
  let consUp = 0, consDown = 0;
  for (let i = dailyChanges.length - 1; i >= 0; i--) {
    if (dailyChanges[i] > 0) { if (consDown === 0) consUp++; else break; }
    else if (dailyChanges[i] < 0) { if (consUp === 0) consDown++; else break; }
    else break; // 동일가
  }

  // 변동성 (표준편차)
  const avgChange = dailyChanges.length > 0 ? dailyChanges.reduce((s, d) => s + d, 0) / dailyChanges.length : 0;
  const variance = dailyChanges.length > 1
    ? dailyChanges.reduce((s, d) => s + (d - avgChange) ** 2, 0) / (dailyChanges.length - 1)
    : 0;
  const volatility = Math.sqrt(variance);

  const maxP = Math.max(...prices);
  const minP = Math.min(...prices);

  // 추세 판정 (복합 기준)
  let label: ShortTrendDetail["label"];
  const ups = dailyChanges.filter((d) => d > 0.001).length;
  const downs = dailyChanges.filter((d) => d < -0.001).length;

  if (totalChange > 0.03 && ups > downs && consUp >= 2) label = "상승";
  else if (totalChange < -0.03 && downs > ups && consDown >= 2) label = "하락";
  else if (consUp >= 2 && consDown === 0 && recent3Change > 0.02) label = "상승";
  else if (consDown >= 2 && consUp === 0 && recent3Change < -0.02) label = "하락";
  else if (
    (dailyChanges.length >= 2 && dailyChanges[dailyChanges.length - 1] > 0.01 && dailyChanges[dailyChanges.length - 2] < -0.01) ||
    (dailyChanges.length >= 2 && dailyChanges[dailyChanges.length - 1] < -0.01 && dailyChanges[dailyChanges.length - 2] > 0.01)
  ) label = "변곡";
  else label = "횡보";

  // 설명 생성
  const firstDate = dates[0]?.slice(5) || "?";  // MM-DD
  const lastDate = dates[dates.length - 1]?.slice(5) || "?";
  const parts: string[] = [];

  parts.push(`${prices.length}일간(${firstDate}~${lastDate}) 매입가 ${first.toLocaleString()}→${last.toLocaleString()}원`);

  if (Math.abs(totalChange) >= 0.005) {
    parts.push(`전체 ${totalChange > 0 ? "+" : ""}${(totalChange * 100).toFixed(1)}%`);
  } else {
    parts.push("보합");
  }

  if (consUp >= 2) parts.push(`최근 ${consUp}일 연속 상승`);
  if (consDown >= 2) parts.push(`최근 ${consDown}일 연속 하락`);

  if (maxP !== minP) {
    parts.push(`최저 ${minP.toLocaleString()} / 최고 ${maxP.toLocaleString()}`);
  }

  if (volatility > 0.05) parts.push("변동성 높음");

  return {
    label,
    total_change_pct: totalChange,
    recent_3d_change_pct: recent3Change,
    consecutive_up: consUp,
    consecutive_down: consDown,
    max_price: maxP,
    min_price: minP,
    volatility,
    day_count: prices.length,
    description: parts.join(". "),
  };
}

// 호환용 래퍼 (기존 코드에서 사용)
function detectShortTrend(prices: number[]): "상승" | "하락" | "횡보" | "변곡" {
  const history = prices.map((p, i) => ({ date: `day-${i}`, price: p }));
  return analyzeShortTrend(history).label;
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

  // 단기 추세 — 8일 이력 상세 분석
  const trendDetail = analyzeShortTrend(short_history);
  signals.short_trend = trendDetail.label;

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
  // 의사결정 (8일 이력 기반)
  // ─────────────────────────────────────
  // ※ targetPrice(수익률일괄변경가)는 "역마진 / 긴급 가격 변경" 상황에만 사용한다.
  const reasons: string[] = [];
  let aiPrice: number;

  // 8일 이력 분석 결과를 첫 번째 reason으로 항상 포함
  if (trendDetail.day_count >= 2) {
    reasons.push(trendDetail.description);
  }

  // 8일 전체 변동률 + 최근 3일 변동률 (2일 비교보다 신뢰도 높음)
  const totalTrend = trendDetail.total_change_pct;
  const recent3d = trendDetail.recent_3d_change_pct;

  // (A) 역마진 발생 — 긴급 상황: targetPrice 적용
  if (cur > 0 && cur <= pp) {
    aiPrice = targetPrice;
    reasons.push(
      `역마진 발생(판매가 ${cur.toLocaleString()}원 ≤ 매입가 ${pp.toLocaleString()}원) → 수익률일괄변경가 ${targetPrice.toLocaleString()}원 긴급 적용 권장`
    );
  }
  // (B) 8일간 큰 폭 상승 (>5%) + 최근 가속 — 상승분 100% 반영
  else if (totalTrend > 0.05 && trendDetail.label === "상승" && trendDetail.consecutive_up >= 2) {
    const basePrice = trendDetail.min_price || prevPP || pp;
    const adjustment = Math.round(pp - basePrice);
    const reflectRate = recent3d > 0.03 ? 1.0 : 0.8; // 최근 가속이면 전액, 아니면 80%
    const applied = Math.round(adjustment * reflectRate);
    aiPrice = Math.ceil((prev + applied) / 10) * 10;
    reasons.push(
      `8일간 ${(totalTrend * 100).toFixed(1)}% 상승 + ${trendDetail.consecutive_up}일 연속 상승 → 상승분의 ${Math.round(reflectRate * 100)}% 반영 (+${applied.toLocaleString()}원)`
    );
  }
  // (C) 완만한 상승 (3~5%) 또는 단기 상승
  else if (totalTrend > 0.02 || (recent3d > 0.03 && trendDetail.consecutive_up >= 2)) {
    const changePct = Math.max(totalTrend, recent3d);
    const reflectRate = trendDetail.consecutive_up >= 3 ? 0.7 : 0.5;
    const adjustment = Math.round((pp - (prevPP || pp)) * reflectRate);
    aiPrice = Math.ceil(((prev || cur) + adjustment) / 10) * 10;
    if (adjustment !== 0) {
      reasons.push(
        `상승 추세(${(changePct * 100).toFixed(1)}%) → 상승분의 ${Math.round(reflectRate * 100)}% 반영 (${adjustment > 0 ? "+" : ""}${adjustment.toLocaleString()}원)`
      );
    } else {
      reasons.push(`완만한 상승 추세 → 현재가 유지`);
    }
  }
  // (D) 8일간 큰 폭 하락 (>5%) + 하락 지속 — 하락분 50%만 반영 (마진 확보)
  else if (totalTrend < -0.05 && trendDetail.label === "하락" && trendDetail.consecutive_down >= 2) {
    const adjustment = Math.round((pp - (prevPP || pp)) * 0.5);
    aiPrice = Math.ceil(((prev || cur) + adjustment) / 10) * 10;
    reasons.push(
      `8일간 ${(Math.abs(totalTrend) * 100).toFixed(1)}% 하락 + ${trendDetail.consecutive_down}일 연속 하락 → 하락분의 50%만 반영 (마진 확보)`
    );
  }
  // (E) 완만한 하락 (2~5%)
  else if (totalTrend < -0.02 || (recent3d < -0.03 && trendDetail.consecutive_down >= 2)) {
    const adjustment = Math.round((pp - (prevPP || pp)) * 0.3);
    aiPrice = Math.ceil(((prev || cur) + adjustment) / 10) * 10;
    if (adjustment !== 0) {
      reasons.push(
        `하락 추세(${(Math.abs(totalTrend) * 100).toFixed(1)}%) → 하락분의 30%만 반영 (마진 우선)`
      );
    } else {
      reasons.push(`완만한 하락 추세 → 현재가 유지`);
    }
  }
  // (F) 변곡점 — 관망
  else if (trendDetail.label === "변곡") {
    aiPrice = prev || cur;
    reasons.push(`매입 추세 전환(변곡점) 감지 → 1~2일 관망 권장`);
  }
  // (G) 횡보 — 현재가 유지
  else {
    aiPrice = cur;
    if (trendDetail.day_count >= 3) {
      reasons.push(`8일간 보합(${(totalTrend * 100).toFixed(1)}%) → 현재가 유지`);
    } else {
      reasons.push(`매입 이력 부족 → 현재가 유지`);
    }
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
