// AI 추천가 산출 로직 (서버 사이드)
// S00-B 신호 해석층의 간이 구현
//
// 입력 신호:
// 1. 단기 (8일)  — 매입가 추세, 변곡점
// 2. 장기 (60일) — 지지선/저항선
// 3. 매출량       — 최근 3개월 월별 판매 수량 추세
// 4. 그룹 동조    — 같은 product_group / parent_product_code 의 추세 참조

export type PriceHistory = { date: string; price: number };

export type PriceSensitivity = "예민" | "고정" | "일반";

export type AiRecInput = {
  purchase_price: number;
  prev_purchase_price: number;
  current_selling_price: number;
  prev_selling_price: number;
  target_margin_rate: number | null;
  is_key_item: boolean;
  price_sensitivity?: PriceSensitivity; // 가격 민감도 (Phase 4 신규)

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
// Layer 1: 적정 매입가 판단
// 오늘 매입가가 아닌, 8일 이력에서 "실제 거래 가격대"를 산출
// ─────────────────────────────────────────
type BasePurchaseResult = {
  base_purchase_price: number;   // 적정 매입가
  confidence: "high" | "medium" | "low";
  method: string;                // 산출 방법
  is_abnormal_today: boolean;    // 오늘 매입가가 적정가 대비 이상인지
  reason: string;                // 학습페이지용 설명
};

function calculateBasePurchasePrice(
  history: PriceHistory[],
  todayPrice: number
): BasePurchaseResult {
  const valid = history.filter((h) => h.price > 0);
  const prices = valid.map((h) => h.price);

  // 유효 데이터 2일 미만 → 오늘 매입가 그대로
  if (prices.length < 2) {
    return {
      base_purchase_price: todayPrice,
      confidence: "low",
      method: "이력 부족 → 오늘 매입가 사용",
      is_abnormal_today: false,
      reason: "[이력 분석] 매입 이력 2일 미만 → 오늘 매입가 기준",
    };
  }

  // Step 1: 중앙값 산출 (이상치 판별 기준)
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  // Step 2: 이상치 제거 (중앙값 대비 ±30% 벗어나는 값)
  const filtered = prices.filter((p) => Math.abs(p - median) / median <= 0.3);
  const filteredCount = prices.length - filtered.length;

  // Step 3: 적정가 산출 (우선순위)
  let basePP: number;
  let method: string;
  let confidence: BasePurchaseResult["confidence"];

  // (1) 최빈값이 명확할 때 (같은 가격이 3회 이상)
  const freqMap = new Map<number, number>();
  for (const p of filtered) freqMap.set(p, (freqMap.get(p) || 0) + 1);
  const maxFreq = Math.max(...freqMap.values());
  const modePrice = [...freqMap.entries()].find(([, cnt]) => cnt === maxFreq)?.[0] || 0;

  if (maxFreq >= 3 && modePrice > 0) {
    basePP = modePrice;
    method = `최빈값(${modePrice.toLocaleString()}원 ${maxFreq}회)`;
    confidence = "high";
  }
  // (2) 박스권 횡보 (최고-최저 차이 < 20%)
  else if (filtered.length >= 3) {
    const fMax = Math.max(...filtered);
    const fMin = Math.min(...filtered);
    const range = fMax > 0 ? (fMax - fMin) / fMin : 0;

    if (range < 0.2) {
      // 중앙값 사용
      const fSorted = [...filtered].sort((a, b) => a - b);
      const fMedian = fSorted.length % 2 === 0
        ? (fSorted[fSorted.length / 2 - 1] + fSorted[fSorted.length / 2]) / 2
        : fSorted[Math.floor(fSorted.length / 2)];
      basePP = Math.round(fMedian);
      method = `중앙값(박스권 ${fMin.toLocaleString()}~${fMax.toLocaleString()}원)`;
      confidence = "medium";
    } else {
      // (3) 변동 큰 품목 → 추세 반영 가중평균 (최근 3일에 가중)
      const recent3 = filtered.slice(-3);
      const older = filtered.slice(0, -3);
      const recent3Avg = recent3.reduce((s, p) => s + p, 0) / recent3.length;
      const olderAvg = older.length > 0 ? older.reduce((s, p) => s + p, 0) / older.length : recent3Avg;
      // 최근 3일에 60% 가중
      basePP = Math.round(recent3Avg * 0.6 + olderAvg * 0.4);
      method = `가중평균(등락 큰 품목, 최근3일 60%가중)`;
      confidence = "medium";
    }
  }
  // 데이터 2일뿐
  else {
    basePP = Math.round(filtered.reduce((s, p) => s + p, 0) / filtered.length);
    method = `평균(${filtered.length}일)`;
    confidence = "low";
  }

  // Step 4: 오늘 매입가와의 괴리 체크
  const deviation = basePP > 0 ? (todayPrice - basePP) / basePP : 0;
  const isAbnormal = Math.abs(deviation) > 0.2; // 적정가 대비 ±20% 이상

  // reason 조립
  const parts: string[] = [];
  const dates = valid.map((h) => h.date);
  const firstDate = dates[0]?.slice(5) || "?";
  const lastDate = dates[dates.length - 1]?.slice(5) || "?";

  // 이력 요약: 가격별 빈도
  const freqDesc = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p, cnt]) => `${p.toLocaleString()}원 ${cnt}회`)
    .join(", ");

  parts.push(`[이력 분석] ${valid.length}일간(${firstDate}~${lastDate}) ${freqDesc}`);
  parts.push(`→ 적정매입가 ${basePP.toLocaleString()}원(${method})`);

  if (filteredCount > 0) {
    parts.push(`이상치 ${filteredCount}건 제외`);
  }

  if (isAbnormal) {
    parts.push(`오늘 ${todayPrice.toLocaleString()}원은 적정가 대비 ${deviation > 0 ? "+" : ""}${(deviation * 100).toFixed(1)}% (이상 매입)`);
  } else if (Math.abs(deviation) > 0.05) {
    parts.push(`오늘 ${todayPrice.toLocaleString()}원은 적정가 대비 ${deviation > 0 ? "+" : ""}${(deviation * 100).toFixed(1)}%`);
  }

  return {
    base_purchase_price: basePP,
    confidence,
    method,
    is_abnormal_today: isAbnormal,
    reason: parts.join(". "),
  };
}

// ─────────────────────────────────────────
// Layer 2: 매출량 판정 (Phase 3)
// ─────────────────────────────────────────
type SalesTier = "비인기" | "보통" | "인기" | "주력" | "없음";

type SalesAnalysis = {
  tier: SalesTier;
  monthly_avg: number;        // 월평균 건수
  recent_total: number;       // 최근 3개월 총합
  prev_total: number;         // 직전 3개월 총합
  change_pct: number | null;  // 전기대비 변화율
  direction: "급감" | "감소" | "안정" | "증가" | "호조" | "없음";
  recommendation: string;     // 기본 대응 전략
};

function analyzeSales(
  recent: { sale_month: string; quantity: number }[],
  previous: { sale_month: string; quantity: number }[]
): SalesAnalysis {
  const recentTotal = recent.reduce((s, r) => s + (r.quantity || 0), 0);
  const prevTotal = previous.reduce((s, r) => s + (r.quantity || 0), 0);
  const monthCount = Math.max(recent.length, 1);
  const monthlyAvg = recentTotal / monthCount;

  // Tier 판정 (월평균 건수 기준)
  let tier: SalesTier;
  if (recentTotal === 0) tier = "없음";
  else if (monthlyAvg < 10) tier = "비인기";
  else if (monthlyAvg < 50) tier = "보통";
  else if (monthlyAvg < 100) tier = "인기";
  else tier = "주력";

  // 변화율 계산
  let changePct: number | null = null;
  if (prevTotal > 0) changePct = (recentTotal - prevTotal) / prevTotal;

  // 방향 판정
  let direction: SalesAnalysis["direction"];
  if (recentTotal === 0) direction = "없음";
  else if (changePct === null) direction = "안정"; // 이전 데이터 없으면 기본값
  else if (changePct < -0.5) direction = "급감";
  else if (changePct < -0.15) direction = "감소";
  else if (changePct <= 0.15) direction = "안정";
  else if (changePct <= 0.5) direction = "증가";
  else direction = "호조";

  // 기본 대응 전략
  let recommendation: string;
  switch (direction) {
    case "급감": recommendation = "가격 인하로 매출 촉진 필요"; break;
    case "감소": recommendation = "소폭 인하 검토"; break;
    case "안정": recommendation = "현 수준 유지"; break;
    case "증가": recommendation = "유지/소폭 인상 여력"; break;
    case "호조": recommendation = "인상 여력 있음"; break;
    case "없음":
      recommendation = prevTotal >= 50
        ? "기존 매출처 있음, 공격적 인하로 회복 시도"
        : "비인기 품목, 수익률 낮춰 매출 유도";
      break;
  }

  return {
    tier,
    monthly_avg: monthlyAvg,
    recent_total: recentTotal,
    prev_total: prevTotal,
    change_pct: changePct,
    direction,
    recommendation,
  };
}

// 매입 안정성 판정 (Layer 1의 method 문자열 기반)
function isPurchaseStable(method: string): boolean {
  return method.includes("최빈값") || method.includes("중앙값") || method.includes("박스권");
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
    price_sensitivity: priceSensitivity = "일반",
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
  const currentMargin = cur > 0 ? 1 - pp / cur : 0;
  const purchaseChange = prevPP > 0 ? (pp - prevPP) / prevPP : 0;

  signals.current_margin = currentMargin;
  signals.purchase_change_pct = purchaseChange;

  // ─────────────────────────────────────
  // Layer 1: 적정 매입가 판단
  // ─────────────────────────────────────
  const layer1 = calculateBasePurchasePrice(short_history, pp);
  const basePP = layer1.base_purchase_price; // 오늘 매입가 대신 적정 매입가 사용

  // targetPrice는 적정매입가 기준으로 산출 (역마진/긴급 시에만)
  const targetPrice = Math.ceil(basePP / (1 - targetMargin / 100) / 10) * 10;

  // 단기 추세 — 8일 이력 상세 분석
  const trendDetail = analyzeShortTrend(short_history);
  signals.short_trend = trendDetail.label;

  // 장기 지지선/저항선
  const longPrices = long_history.map((h) => h.price);
  const { support, resistance } = extractSupport(longPrices, basePP);
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
  // 의사결정 (Layer 1 적정매입가 기반)
  // ─────────────────────────────────────
  const reasons: string[] = [];
  let aiPrice: number;

  // Layer 1 분석 결과를 첫 번째 reason으로 항상 포함
  reasons.push(layer1.reason);

  // 8일 전체 변동률 + 최근 3일 변동률
  const totalTrend = trendDetail.total_change_pct;
  const recent3d = trendDetail.recent_3d_change_pct;

  // ─────────────────────────────────────
  // Layer 3 이상치 판정 (수익률 변동폭 ≥ 5%p)
  // 오늘 매입가가 기존 판매가 대비 수익률에 얼마나 영향 주는지
  // ─────────────────────────────────────
  const ABNORMAL_THRESHOLD = 0.05;              // 5%p
  const MARGIN_UPPER_PROTECT_K = 0.25;          // 상승 이상치 시 수익률 포기 계수
  const MARGIN_LOWER_PROTECT_RATIO = 0.1;       // 하락 이상치 시 판매가 인하 비율
  const MARGIN_FLOOR = 0.15;                    // 수익률 하한 15%

  const purchaseChangeFromBase = basePP > 0 ? (pp - basePP) / basePP : 0;
  let marginDeviation = 0;
  if (prev > 0) {
    const currentMarginWithTodayPurchase = 1 - pp / prev;
    marginDeviation = targetMargin / 100 - currentMarginWithTodayPurchase;
  }
  const isAbnormal = prev > 0 && Math.abs(marginDeviation) >= ABNORMAL_THRESHOLD;

  // (A) 역마진 발생 — 긴급 상황: targetPrice 적용 (적정매입가 기준)
  if (cur > 0 && cur <= basePP) {
    aiPrice = targetPrice;
    reasons.push(
      `역마진 발생(판매가 ${cur.toLocaleString()}원 ≤ 적정매입가 ${basePP.toLocaleString()}원) → 수익률일괄변경가 ${targetPrice.toLocaleString()}원 긴급 적용 권장`
    );
  }
  // (A-1) 상승 이상치 — 매입 급등 → 수익률 보수적 포기 (k=0.25)
  else if (isAbnormal && purchaseChangeFromBase > 0) {
    const riseRate = purchaseChangeFromBase;
    const newMarginPct = Math.max(
      MARGIN_FLOOR * 100,
      targetMargin - MARGIN_UPPER_PROTECT_K * riseRate * 100
    );
    aiPrice = Math.ceil(pp / (1 - newMarginPct / 100) / 10) * 10;
    // marginDeviation > 0 (실제 수익률이 기준보다 낮아짐)
    reasons.push(
      `[이상치-상승] 매입 +${(riseRate * 100).toFixed(1)}% (적정가 ${basePP.toLocaleString()}→${pp.toLocaleString()}원, 기존판매가 기준 수익률이 기준보다 -${(marginDeviation * 100).toFixed(1)}%p 낮음) → 수익률 ${newMarginPct.toFixed(1)}%로 재조정(max(15%, 기준${targetMargin}% − 0.25×${(riseRate * 100).toFixed(1)}%)) → 판매가 ${aiPrice.toLocaleString()}원`
    );
  }
  // (A-2) 하락 이상치 — 매입 급락 → 판매가 소극적 인하 (매입하락률 × 0.1)
  else if (isAbnormal && purchaseChangeFromBase < 0 && prev > 0) {
    const dropRate = Math.abs(purchaseChangeFromBase);
    const priceDropRate = dropRate * MARGIN_LOWER_PROTECT_RATIO;
    aiPrice = Math.ceil((prev * (1 - priceDropRate)) / 10) * 10;
    // marginDeviation < 0 (실제 수익률이 기준보다 높아짐) → 표기는 절대값으로
    reasons.push(
      `[이상치-하락] 매입 -${(dropRate * 100).toFixed(1)}% (적정가 ${basePP.toLocaleString()}→${pp.toLocaleString()}원, 기존판매가 기준 수익률이 기준보다 +${Math.abs(marginDeviation * 100).toFixed(1)}%p 높음) → 판매가 소극적 인하 -${(priceDropRate * 100).toFixed(1)}% (${prev.toLocaleString()}→${aiPrice.toLocaleString()}원)`
    );
  }
  // (B) 8일간 큰 폭 상승 (>5%) + 최근 가속
  else if (totalTrend > 0.05 && trendDetail.label === "상승" && trendDetail.consecutive_up >= 2) {
    // 적정매입가 기준 수익률 산출
    const appliedMargin = targetMargin + (recent3d > 0.03 ? 2 : 1); // 상승기: 기준+1~2%p (마진 방어)
    aiPrice = Math.ceil(basePP / (1 - appliedMargin / 100) / 10) * 10;
    reasons.push(
      `8일간 ${(totalTrend * 100).toFixed(1)}% 상승 + ${trendDetail.consecutive_up}일 연속 → 수익률 ${appliedMargin.toFixed(1)}%(기준${targetMargin}% + 매입상승보정) × 적정매입가 ${basePP.toLocaleString()}원`
    );
  }
  // (C) 완만한 상승 (2~5%) 또는 단기 상승
  else if (totalTrend > 0.02 || (recent3d > 0.03 && trendDetail.consecutive_up >= 2)) {
    const appliedMargin = targetMargin + 1; // 완만상승: 기준+1%p
    aiPrice = Math.ceil(basePP / (1 - appliedMargin / 100) / 10) * 10;
    reasons.push(
      `상승 추세(${(Math.max(totalTrend, recent3d) * 100).toFixed(1)}%) → 수익률 ${appliedMargin.toFixed(1)}%(기준${targetMargin}% + 1%p) × 적정매입가 ${basePP.toLocaleString()}원`
    );
  }
  // (D) 8일간 큰 폭 하락 (>5%) + 하락 지속
  else if (totalTrend < -0.05 && trendDetail.label === "하락" && trendDetail.consecutive_down >= 2) {
    // 하락기에도 마진 방어: 기준+1~2%p
    const appliedMargin = targetMargin + (Math.abs(totalTrend) > 0.1 ? 2 : 1);
    aiPrice = Math.ceil(basePP / (1 - appliedMargin / 100) / 10) * 10;
    reasons.push(
      `8일간 ${(Math.abs(totalTrend) * 100).toFixed(1)}% 하락 + ${trendDetail.consecutive_down}일 연속 → 수익률 ${appliedMargin.toFixed(1)}%(기준${targetMargin}% + 하락기보정) × 적정매입가 ${basePP.toLocaleString()}원`
    );
  }
  // (E) 완만한 하락 (2~5%)
  else if (totalTrend < -0.02 || (recent3d < -0.03 && trendDetail.consecutive_down >= 2)) {
    const appliedMargin = targetMargin + 1; // 완만하락: 기준+1%p 마진 방어
    aiPrice = Math.ceil(basePP / (1 - appliedMargin / 100) / 10) * 10;
    reasons.push(
      `하락 추세(${(Math.abs(Math.min(totalTrend, recent3d)) * 100).toFixed(1)}%) → 수익률 ${appliedMargin.toFixed(1)}%(기준${targetMargin}% + 마진방어 1%p) × 적정매입가 ${basePP.toLocaleString()}원`
    );
  }
  // (F) 변곡점 — 관망, 기준수익률 그대로
  else if (trendDetail.label === "변곡") {
    aiPrice = Math.ceil(basePP / (1 - targetMargin / 100) / 10) * 10;
    reasons.push(`매입 추세 전환(변곡점) → 기준수익률 ${targetMargin}% × 적정매입가 ${basePP.toLocaleString()}원`);
  }
  // (G) 횡보 — 기준수익률 적용
  else {
    aiPrice = Math.ceil(basePP / (1 - targetMargin / 100) / 10) * 10;
    if (trendDetail.day_count >= 3) {
      reasons.push(`보합(${(totalTrend * 100).toFixed(1)}%) → 기준수익률 ${targetMargin}% × 적정매입가 ${basePP.toLocaleString()}원`);
    } else {
      reasons.push(`매입 이력 부족 → 기준수익률 ${targetMargin}% × 오늘매입가 ${pp.toLocaleString()}원`);
    }
  }

  // ─────────────────────────────────────
  // Layer 2: 매출량 분석 (Phase 3 강화)
  // ─────────────────────────────────────
  const salesAnalysis = analyzeSales(monthly_sales, prev_monthly_sales);
  const purchaseStable = isPurchaseStable(layer1.method);

  // 매출 판정 reason (tier + 변화 + 대응 전략)
  {
    const changeStr = salesAnalysis.change_pct === null
      ? "신규"
      : (salesAnalysis.change_pct >= 0 ? "▲" : "▼") + Math.abs(salesAnalysis.change_pct * 100).toFixed(0) + "%";
    const monthlyStr = salesAnalysis.tier === "없음"
      ? "매출 없음"
      : `월평균 ${salesAnalysis.monthly_avg.toFixed(1)}건`;
    reasons.push(
      `[매출 판정] 최근 3개월 ${salesAnalysis.recent_total.toLocaleString()}건 (${monthlyStr}, ${salesAnalysis.tier}, 전기대비 ${changeStr}) → ${salesAnalysis.recommendation}`
    );
  }

  // ─────────────────────────────────────
  // 보정 신호 (매출량 기반 가격 조정, 지지선, 그룹, 경쟁품목)
  // ─────────────────────────────────────

  // 저수익 경고 — 적정매입가 기준 수익률 체크
  const baseMargin = aiPrice > 0 ? 1 - basePP / aiPrice : 0;
  if (cur > basePP && currentMargin < 0.1) {
    reasons.push(
      `현재 수익률 ${(currentMargin * 100).toFixed(1)}%로 낮음 — 수익률일괄변경가 ${targetPrice.toLocaleString()}원(${targetMargin}%)까지 상향 가능`
    );
  }

  // ─────────────────────────────────────
  // Layer 2 매출 기반 가격 조정 (Phase 3)
  // ─────────────────────────────────────

  // (1) 매출 없음 — 두 전략 분기
  if (salesAnalysis.direction === "없음") {
    if (salesAnalysis.prev_total >= 50) {
      // 직전 3개월 50건+ 있었는데 이번에 없음 → 공격적 인하
      const aggressiveMargin = Math.max(15, targetMargin - 3);
      const aggressivePrice = Math.ceil(basePP / (1 - aggressiveMargin / 100) / 10) * 10;
      if (aggressivePrice < aiPrice) {
        aiPrice = aggressivePrice;
        reasons.push(
          `직전 3개월 ${salesAnalysis.prev_total}건 있었으나 최근 없음 → 공격적 인하 (수익률 ${aggressiveMargin.toFixed(1)}%, 기준${targetMargin}% - 3%p)로 매출 회복 시도`
        );
      }
    } else if (targetMargin > 15) {
      // 매출 원래 적음 → 15%부터 시작
      const floorMargin = 15;
      const floorPrice = Math.ceil(basePP / (1 - floorMargin / 100) / 10) * 10;
      if (floorPrice < aiPrice) {
        aiPrice = floorPrice;
        reasons.push(
          `비인기 품목 (매출 없음) → 수익률 ${floorMargin}%(최저)로 매출 유도`
        );
      }
    }
  }
  // (2) 매출 급감 (▼50% 이상) — 매입 안정성 기반 분기
  else if (salesAnalysis.direction === "급감") {
    const changePct = salesAnalysis.change_pct || 0;
    if (purchaseStable) {
      // 매입 안정 → 기준수익률 최저 15%까지 하향 (매출 하락률에 비례)
      const intensity = Math.min(1, Math.abs(changePct));
      const marginReduction = Math.min(targetMargin - 15, intensity * 5); // 최대 5%p
      const newMargin = Math.max(15, targetMargin - marginReduction);
      const newPrice = Math.ceil(basePP / (1 - newMargin / 100) / 10) * 10;
      if (newPrice < aiPrice) {
        aiPrice = newPrice;
        reasons.push(
          `매출 급감 ▼${(Math.abs(changePct) * 100).toFixed(0)}% + 매입 안정(${layer1.method.split("(")[0]}) → 수익률 ${newMargin.toFixed(1)}%(기준${targetMargin}% - ${marginReduction.toFixed(1)}%p)로 하향`
        );
      }
    } else {
      // 매입 등락 심함 → 1~2%p만 낮춤 (리스크 방어)
      const marginReduction = Math.abs(changePct) > 0.7 ? 2 : 1;
      const newMargin = Math.max(15, targetMargin - marginReduction);
      const newPrice = Math.ceil(basePP / (1 - newMargin / 100) / 10) * 10;
      if (newPrice < aiPrice) {
        aiPrice = newPrice;
        reasons.push(
          `매출 급감 ▼${(Math.abs(changePct) * 100).toFixed(0)}% + 매입 등락(가중평균) → 수익률 ${newMargin.toFixed(1)}%(${marginReduction}%p만 하향, 리스크 방어)`
        );
      }
    }
  }
  // (3) 매출 감소 (▼15~50%) — 소폭 인하
  else if (salesAnalysis.direction === "감소") {
    const newMargin = Math.max(15, targetMargin - 1);
    const newPrice = Math.ceil(basePP / (1 - newMargin / 100) / 10) * 10;
    if (newPrice < aiPrice && purchaseStable) {
      aiPrice = newPrice;
      reasons.push(
        `매출 감소 ▼${(Math.abs(salesAnalysis.change_pct || 0) * 100).toFixed(0)}% → 수익률 ${newMargin.toFixed(1)}%(-1%p)로 소폭 인하`
      );
    }
  }
  // (4) 매출 증가 (▲15%+) — 가격예민/고정/일반 차등 대응
  else if (salesAnalysis.direction === "증가" || salesAnalysis.direction === "호조") {
    const changePct = salesAnalysis.change_pct || 0;
    if (priceSensitivity === "예민") {
      // 가격예민: 수익률 점진 상향 (+0.5%p)
      const boostedMargin = targetMargin + 0.5;
      const boostedPrice = Math.ceil(basePP / (1 - boostedMargin / 100) / 10) * 10;
      if (boostedPrice > aiPrice) {
        aiPrice = boostedPrice;
        reasons.push(
          `매출 ▲${(changePct * 100).toFixed(0)}% + 가격예민 품목 → 수익률 점진 상향(+0.5%p) ${boostedMargin.toFixed(1)}%`
        );
      }
    } else if (priceSensitivity === "고정") {
      // 가격고정: 건드리지 않고 유지
      if (prev > 0 && Math.abs((aiPrice - prev) / prev) > 0.02) {
        reasons.push(
          `매출 ▲${(changePct * 100).toFixed(0)}% + 가격고정 품목 → 건드리지 않고 유지 (${prev.toLocaleString()}원)`
        );
        aiPrice = prev;
      }
    } else if (purchaseChange > 0) {
      reasons.push(
        `매출 ▲${(changePct * 100).toFixed(0)}% + 매입 상승 → 인상 여력 있음`
      );
    }
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

  // 주요 경쟁품목 가드 — 기준수익률 -1%p (경쟁력 유지)
  if (isKey) {
    const keyMargin = targetMargin - 1;
    const keyPrice = Math.ceil(basePP / (1 - keyMargin / 100) / 10) * 10;
    if (aiPrice > keyPrice) {
      aiPrice = keyPrice;
      reasons.push(`주요 경쟁품목 → 수익률 ${keyMargin.toFixed(1)}%(기준-1%p)로 경쟁력 유지`);
    }
  }

  // 기존판매가 대비 ±15% 이상 변동 시 경고
  if (prev > 0 && aiPrice > 0) {
    const priceChangePct = (aiPrice - prev) / prev;
    if (Math.abs(priceChangePct) > 0.15) {
      reasons.push(`기존판매가 대비 ${priceChangePct > 0 ? "+" : ""}${(priceChangePct * 100).toFixed(1)}% 변동 — 확인 필요`);
    }
  }

  // 최소 마진 하한 (기본 15%) — 오늘 매입가(pp) 기준으로 역마진 방지
  // ※ 플랫폼 수수료(식봄 6.6% / 배민 5.5~7.7% / 신선행 4.5% / 온일장 5%) 고려 시
  //    5% 미만은 즉시 역마진이므로 야채/수산 품목은 15% 이상 유지
  // ※ basePP(적정매입가)가 아닌 pp(오늘 매입가) 기준 — 적정가가 오늘보다 낮을 때
  //    basePP 기준으로 계산하면 판매가가 오늘 매입가보다 낮아져 역마진 발생
  const minPrice = Math.ceil(pp / (1 - MARGIN_FLOOR) / 10) * 10;
  if (aiPrice < minPrice && pp > 0) {
    const originalAiPrice = aiPrice;
    aiPrice = minPrice;
    reasons.push(
      `최소 마진 ${(MARGIN_FLOOR * 100).toFixed(0)}% 하한선 적용 (오늘 매입가 ${pp.toLocaleString()}원 기준, ${originalAiPrice.toLocaleString()}→${aiPrice.toLocaleString()}원)`
    );
  }

  return {
    ai_price: aiPrice,
    ai_reason: reasons.join(". "),
    signals,
  };
}
