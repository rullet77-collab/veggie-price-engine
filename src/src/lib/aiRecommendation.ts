// AI 추천가 산출 로직 (서버 사이드)
// S00-B 신호 해석층의 간이 구현
//
// 입력 신호:
// 1. 단기 (8일)  — 매입가 추세, 변곡점
// 2. 장기 (60일) — 지지선/저항선
// 3. 매출량       — PSP 과거 3개월(고정) + 이번달(MSQ) — 시트 공식 기반 일할계산
// 4. 그룹 동조    — 같은 product_group / parent_product_code 의 추세 참조

import { computeExpectedBaseQty } from "./salesStats";

export type PriceHistory = { date: string; price: number };

export type PriceSensitivity = "예민" | "고정" | "일반";

// Phase 5-A: 박스-소분 관계식 메타
export type PackRole = "박스" | "소분";
export type PackMeta =
  | { formula_divisor: number; actual_weight?: number; unit_kind: string; seasonal?: { winter_months: number[]; winter_divisor: number; summer_divisor: number; winter_actual?: number; summer_actual?: number; note?: string } }
  | { quantity: number; unit_kind: string; half_box?: boolean };

// Phase 5-A: 같은 그룹 멤버 정보
export type GroupMember = {
  product_code: string;
  product_name: string;
  pack_role: PackRole | null;
  pack_meta: PackMeta | null;
  unit: string | null;                   // "박스", "봉", "통", "개", "kg" 등
  spec?: string | null;                  // 규격 ("박스/±5kg", "반박스/10kg", "1kg" 등) — Layer 4-B 단위환산용
  learned_tier?: number | null;          // 1/2/3 (그룹·unit 내 365일 학습 tier)
  purchase_source?: string | null;       // 매입처 풀 — 다른 source 끼리는 직접 매입가 환산 X (변동률만)
  short_history: PriceHistory[];         // 8일 이력
  long_history: PriceHistory[];          // 60일 이력 (장기 참조용)
};

export type AiRecInput = {
  purchase_price: number;
  prev_purchase_price: number;
  current_selling_price: number;
  prev_selling_price: number;
  target_margin_rate: number | null;
  is_key_item: boolean;
  price_sensitivity?: PriceSensitivity; // 가격 민감도 (Phase 4 신규)

  // Phase 5-A: 내 품목의 pack 정보 + 그룹 멤버
  pack_role?: PackRole | null;
  pack_meta?: PackMeta | null;
  group_members?: GroupMember[];         // 같은 그룹의 다른 멤버 (나 제외)
  price_date?: string;                   // 분석 기준일 (시즌 판정용)
  unit?: string;                         // 내 단위
  product_name?: string | null;          // Layer 4-B 등급키 매칭용
  spec?: string | null;                  // Layer 4-B kg 환산용
  learned_tier?: number | null;          // 365일 학습 tier (1=top/2=mid/3=low)
  product_group?: number | null;         // 그룹별 tier ratio 조회용
  purchase_source?: string | null;       // 매입처 풀 — 다른 source 멤버는 1차 anchor 제외
  tier_ratios?: Map<string, number> | null; // "groupId-tierA-tierB" → ratio (B-3)

  short_history: PriceHistory[]; // 8일
  long_history: PriceHistory[]; // 60일 (선택)

  // [레거시] 스크립트 호환용 — 메인 로직은 아래 PSP 컬럼 기반 사용
  monthly_sales: { sale_month: string; quantity: number }[];
  prev_monthly_sales: { sale_month: string; quantity: number }[];

  // [신규] PSP 고정 과거 3개월 + MSQ 이번달 (시트 공식과 동일)
  //   month_1_qty = 3개월 전, month_2_qty = 2개월 전, month_3_qty = 1개월 전
  //   current_month_qty = MSQ(source='전체', 현재월)
  month_1_qty?: number | null;
  month_2_qty?: number | null;
  month_3_qty?: number | null;
  current_month_qty?: number | null;

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
// Layer 1: 적정 매입가 판단 — basePP_v3 (2025-04 정의)
//
//   파라미터
//     THRESHOLD      = 0.05  구간추세 판별 ±5%
//     RECENT_N       = 4     최근/과거 분할
//     W_RECENT       = 0.70  최근 가중치
//     W_OLDER        = 0.30  과거 가중치
//     SPIKE_UP/DN    = 0.15  당일 급등/급락 ±15%
//     MODE_GAP_LIMIT = 0.15  최빈값 버림(오늘가 대비 15%↓)
//
//   메인 흐름
//     STEP1 당일충격 → 급등=오늘가 / 급락=완충(높은값)
//     STEP2 최빈값 유효성(오늘가 대비 -15% 초과면 버림)
//     STEP3+4 추세별 비대칭 선택
//        상승:  max(최빈, 가중, 오늘가×0.95)
//        하락:  max(최빈, 가중)             ← 완충
//        횡보:  median(최빈, 가중)
//        최빈X: median(오늘가, 최근중앙, 가중)
// ─────────────────────────────────────────
const V3_THRESHOLD = 0.05;
const V3_RECENT_N = 4;
const V3_W_RECENT = 0.70;
const V3_W_OLDER = 0.30;
const V3_SPIKE_UP = 0.15;
const V3_SPIKE_DN = 0.15;
const V3_MODE_GAP_LIMIT = 0.15;

type V3Trend = "상승" | "하락" | "횡보";
type V3Shock = "급등" | "급락" | "정상";

type BasePurchaseResult = {
  base_purchase_price: number;
  confidence: "high" | "medium" | "low";
  method: string;
  is_abnormal_today: boolean;
  reason: string;
  // v3 신호 (downstream 분기에서 활용)
  v3_trend?: V3Trend;
  v3_shock?: V3Shock;
};

// sp = 최신→과거 순
function v3GetTrend(sp: number[]): V3Trend {
  const recent = sp.slice(0, V3_RECENT_N);
  const older = sp.slice(V3_RECENT_N);
  if (older.length === 0) return "횡보";
  const rAvg = recent.reduce((s, p) => s + p, 0) / recent.length;
  const oAvg = older.reduce((s, p) => s + p, 0) / older.length;
  if (oAvg <= 0) return "횡보";
  const ratio = (rAvg - oAvg) / oAvg;
  if (ratio > V3_THRESHOLD) return "상승";
  if (ratio < -V3_THRESHOLD) return "하락";
  return "횡보";
}

function v3GetMode(prices: number[], trend: V3Trend): { modePrice: number | null; maxFreq: number; note: string } {
  const freq = new Map<number, number>();
  for (const p of prices) freq.set(p, (freq.get(p) || 0) + 1);
  let maxFreq = 0;
  for (const v of freq.values()) if (v > maxFreq) maxFreq = v;
  const modes: number[] = [];
  for (const [k, v] of freq.entries()) if (v === maxFreq) modes.push(k);
  modes.sort((a, b) => a - b);

  if (maxFreq >= 3 && modes.length === 1) {
    return { modePrice: modes[0], maxFreq, note: "단일최빈" };
  }
  if (maxFreq >= 3 && modes.length > 1) {
    if (trend === "상승") return { modePrice: Math.max(...modes), maxFreq, note: "동률→상승→max" };
    if (trend === "하락") return { modePrice: Math.min(...modes), maxFreq, note: "동률→하락→min" };
    const mid = modes.length % 2 === 0
      ? (modes[modes.length / 2 - 1] + modes[modes.length / 2]) / 2
      : modes[Math.floor(modes.length / 2)];
    return { modePrice: Math.trunc(mid), maxFreq, note: "동률→횡보→중앙" };
  }
  return { modePrice: null, maxFreq, note: `최빈<3(max ${maxFreq}회)` };
}

function v3GetWavg(sp: number[]): number {
  const recent = sp.slice(0, V3_RECENT_N);
  const older = sp.slice(V3_RECENT_N);
  const rAvg = recent.reduce((s, p) => s + p, 0) / recent.length;
  const oAvg = older.length > 0 ? older.reduce((s, p) => s + p, 0) / older.length : rAvg;
  return Math.round(rAvg * V3_W_RECENT + oAvg * V3_W_OLDER);
}

function v3GetRecentMedian(sp: number[]): number {
  const recent = sp.slice(0, V3_RECENT_N);
  const sorted = [...recent].sort((a, b) => a - b);
  const med = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return Math.trunc(med);
}

function v3MedianOf3(a: number, b: number, c: number): number {
  const arr = [a, b, c].sort((x, y) => x - y);
  return Math.trunc(arr[1]);
}

function v3MedianOf2(a: number, b: number): number {
  return Math.trunc((a + b) / 2);
}

type V3Result = {
  basePP: number;
  today: number;
  yesterday: number;
  day_chg: number;
  shock: V3Shock;
  trend: V3Trend;
  mode_price: number | null;
  mode_note: string;
  wavg: number;
  recent_median: number;
  basis: string;
};

function calcBasePP_v3(sp: number[]): V3Result {
  const today = sp[0];
  const yesterday = sp.length > 1 ? sp[1] : sp[0];
  const trend = v3GetTrend(sp);
  let { modePrice, maxFreq: _mf, note: modeNote } = v3GetMode(sp, trend);
  void _mf;
  const wavg = v3GetWavg(sp);
  const recentMed = v3GetRecentMedian(sp);
  const dayChg = yesterday > 0 ? (today - yesterday) / yesterday : 0;

  // STEP 1 — 당일충격
  if (dayChg >= V3_SPIKE_UP) {
    if (modePrice !== null && (today - modePrice) / today > V3_MODE_GAP_LIMIT) {
      modeNote += "→최빈버림";
      modePrice = null;
    }
    return {
      basePP: today, today, yesterday, day_chg: dayChg, shock: "급등", trend,
      mode_price: modePrice, mode_note: modeNote, wavg, recent_median: recentMed,
      basis: "당일급등→오늘가",
    };
  }
  if (dayChg <= -V3_SPIKE_DN) {
    let basePP: number;
    let basis: string;
    if (modePrice !== null) {
      basePP = Math.max(modePrice, wavg);
      basis = "당일급락→완충(최빈/가중 높은값)";
    } else {
      basePP = Math.max(recentMed, wavg);
      basis = "당일급락→완충(최근중앙/가중 높은값)";
    }
    return {
      basePP, today, yesterday, day_chg: dayChg, shock: "급락", trend,
      mode_price: modePrice, mode_note: modeNote, wavg, recent_median: recentMed, basis,
    };
  }

  // STEP 2 — 최빈값 유효성 검사
  if (modePrice !== null && (today - modePrice) / today > V3_MODE_GAP_LIMIT) {
    const dropPct = ((today - modePrice) / today * 100).toFixed(0);
    modeNote += `(오늘가 대비 ${dropPct}%↓버림)`;
    modePrice = null;
  }

  // STEP 3+4 — 추세별 비대칭 선택
  let basePP: number;
  let basis: string;
  if (modePrice !== null) {
    if (trend === "상승") {
      basePP = Math.max(modePrice, wavg, Math.round(today * 0.95));
      basis = "상승→max(최빈,가중,오늘가×0.95)";
    } else if (trend === "하락") {
      // 안정 신호: 최근 2일 동가 → 최빈값과 오늘가의 평균 (점진 수렴, 완충 약화)
      if (sp.length >= 2 && sp[0] === sp[1]) {
        basePP = v3MedianOf2(modePrice, today);
        basis = "하락안정(최근2일동가)→MEDIAN(최빈,오늘가)";
      } else {
        basePP = Math.max(modePrice, wavg);
        basis = "하락→완충(최빈/가중 높은값)";
      }
    } else {
      basePP = v3MedianOf2(modePrice, wavg);
      basis = "횡보→MEDIAN(최빈,가중)";
    }
  } else {
    basePP = v3MedianOf3(today, recentMed, wavg);
    basis = `최빈없음→MEDIAN(오늘${today.toLocaleString()},최근중앙${recentMed.toLocaleString()},가중${wavg.toLocaleString()})`;
  }

  return {
    basePP, today, yesterday, day_chg: dayChg, shock: "정상", trend,
    mode_price: modePrice, mode_note: modeNote, wavg, recent_median: recentMed, basis,
  };
}

function calculateBasePurchasePrice(
  history: PriceHistory[],
  todayPrice: number
): BasePurchaseResult {
  const valid = history.filter((h) => h.price > 0);

  // sp 구성: 최신→과거 (history 는 ASC 정렬이므로 reverse)
  let sp = valid.slice().reverse().map((h) => h.price);

  // 오늘 매입이 history 에 없을 수 있으면 todayPrice 를 sp[0] 에 우선
  // (mgmt 와 daily_purchase_prices 가 항상 일치하지 않을 수 있어 안전장치)
  if (todayPrice > 0 && (sp.length === 0 || sp[0] !== todayPrice)) {
    sp = [todayPrice, ...sp];
  }

  // 유효 데이터 2일 미만 → 오늘 매입가 그대로
  if (sp.length < 2) {
    return {
      base_purchase_price: todayPrice,
      confidence: "low",
      method: "이력 부족 → 오늘 매입가 사용",
      is_abnormal_today: false,
      reason: "[이력 분석] 매입 이력 2일 미만 → 오늘 매입가 기준",
    };
  }

  // v3 알고리즘 실행
  const v3 = calcBasePP_v3(sp);

  // 신뢰도 매핑
  let confidence: BasePurchaseResult["confidence"];
  if (v3.shock !== "정상") confidence = "high";
  else if (v3.mode_price !== null) confidence = "high";
  else confidence = "medium";

  // 오늘 매입가와의 괴리 체크 (이상치 표기는 기존 인터페이스 유지)
  const deviation = v3.basePP > 0 ? (todayPrice - v3.basePP) / v3.basePP : 0;
  const isAbnormal = Math.abs(deviation) > 0.2;

  // reason 조립
  const parts: string[] = [];
  const dates = valid.map((h) => h.date);
  const firstDate = dates[0]?.slice(5) || "?";
  const lastDate = dates[dates.length - 1]?.slice(5) || "?";

  // 가격별 빈도 (최신→과거 순 sp 기준)
  const freqMap = new Map<number, number>();
  for (const p of sp) freqMap.set(p, (freqMap.get(p) || 0) + 1);
  const freqDesc = [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p, cnt]) => `${p.toLocaleString()}원 ${cnt}회`)
    .join(", ");

  parts.push(`[이력 분석 v3] ${sp.length}일간(${firstDate}~${lastDate}) ${freqDesc}`);
  parts.push(
    `추세=${v3.trend} / 충격=${v3.shock}(일변동${(v3.day_chg * 100).toFixed(1)}%) / 최빈=${
      v3.mode_price !== null ? v3.mode_price.toLocaleString() + "원" : "X"
    }(${v3.mode_note}) / 가중=${v3.wavg.toLocaleString()}원 / 최근${V3_RECENT_N}중앙=${v3.recent_median.toLocaleString()}원`
  );
  parts.push(`→ 적정매입가 ${v3.basePP.toLocaleString()}원 (${v3.basis})`);

  if (isAbnormal) {
    parts.push(
      `오늘 ${todayPrice.toLocaleString()}원은 적정가 대비 ${deviation > 0 ? "+" : ""}${(deviation * 100).toFixed(1)}% (이상 매입)`
    );
  } else if (Math.abs(deviation) > 0.05) {
    parts.push(
      `오늘 ${todayPrice.toLocaleString()}원은 적정가 대비 ${deviation > 0 ? "+" : ""}${(deviation * 100).toFixed(1)}%`
    );
  }

  return {
    base_purchase_price: v3.basePP,
    confidence,
    method: v3.basis,
    is_abnormal_today: isAbnormal,
    reason: parts.join(". "),
    v3_trend: v3.trend,
    v3_shock: v3.shock,
  };
}

// ─────────────────────────────────────────
// Layer 2: 매출량 판정 (Phase 3) — 플랫폼시트 공식과 동일
//   a_daily = AVERAGE(각 과거월별 수량 ÷ 그 달의 일수)   ← 데이터 있는 월만 카운트
//   e_base  = a_daily × DAY(priceDate)                  ← 오늘까지의 기대 누적치
//   d_rate  = (currentQty - e_base) / e_base            ← 3개월대비 변화율
// ─────────────────────────────────────────
type SalesTier = "비인기" | "보통" | "인기" | "주력" | "없음";

type SalesAnalysis = {
  tier: SalesTier;
  monthly_avg: number;        // 과거 3개월 월평균 건수 (데이터 있는 월만)
  recent_total: number;       // 이번달 누적 건수 (MSQ)
  prev_total: number;         // PSP 과거 3개월 총합
  expected_base: number;      // 시트 공식 e_base (오늘까지 기대치)
  change_pct: number | null;  // 시트 공식 d_rate
  direction: "급감" | "감소" | "안정" | "증가" | "호조" | "없음";
  recommendation: string;
};

function analyzeSales(
  m1: number | null | undefined,
  m2: number | null | undefined,
  m3: number | null | undefined,
  currentQty: number | null | undefined,
  priceDate: string | null | undefined
): SalesAnalysis {
  const v1 = m1 || 0;
  const v2 = m2 || 0;
  const v3 = m3 || 0;
  const cur = currentQty || 0;

  const prevTotal = v1 + v2 + v3;
  const nonZeroMonths = [v1, v2, v3].filter((v) => v > 0).length;
  const monthlyAvg = nonZeroMonths > 0 ? prevTotal / nonZeroMonths : 0;

  // Tier 판정 (과거 3개월 월평균 기준)
  let tier: SalesTier;
  if (nonZeroMonths === 0 && cur === 0) tier = "없음";
  else if (monthlyAvg === 0 && cur > 0) tier = "보통"; // 신규매출은 기본 tier 부여
  else if (monthlyAvg < 10) tier = "비인기";
  else if (monthlyAvg < 50) tier = "보통";
  else if (monthlyAvg < 100) tier = "인기";
  else tier = "주력";

  // e_base / d_rate 계산 (시트 공식)
  const eBase = priceDate ? (computeExpectedBaseQty(v1 || null, v2 || null, v3 || null, priceDate) || 0) : 0;

  let changePct: number | null = null;
  if (eBase >= 0.1) changePct = (cur - eBase) / eBase;

  // 방향 판정
  let direction: SalesAnalysis["direction"];
  if (nonZeroMonths === 0 && cur === 0) {
    direction = "없음";
  } else if (nonZeroMonths === 0 && cur > 0) {
    direction = "호조"; // 신규매출
  } else if (eBase < 0.1) {
    // 과거가 극소량인데 현재도 있으면 일단 안정 취급 (기준치미달)
    direction = cur > 0 ? "안정" : "없음";
  } else if (cur === 0) {
    direction = "없음";
  } else if (changePct === null) {
    direction = "안정";
  } else if (changePct > 0.5) {
    direction = "호조";
  } else if (changePct > 0.15) {
    direction = "증가";
  } else if (changePct >= -0.15) {
    direction = "안정";
  } else if (changePct >= -0.5) {
    direction = "감소";
  } else {
    direction = "급감";
  }

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
    recent_total: cur,
    prev_total: prevTotal,
    expected_base: eBase,
    change_pct: changePct,
    direction,
    recommendation,
  };
}

// 매입 안정성 판정 (v3 신호: 횡보 + 정상 충격)
function isPurchaseStable(layer1: BasePurchaseResult): boolean {
  if (layer1.v3_trend !== undefined) {
    return layer1.v3_trend === "횡보" && layer1.v3_shock === "정상";
  }
  // fallback: 옛 method 문자열 기반
  return layer1.method.includes("최빈") || layer1.method.includes("중앙") || layer1.method.includes("MEDIAN");
}

// ─────────────────────────────────────────
// Layer 4 / Phase 5-A: 박스-소분 관계식 + 그룹 교차 참조
// ─────────────────────────────────────────

// 가지 시즌 판정 (11~6월 ÷30 / 7~10월 ÷45)
export function getActiveDivisor(meta: PackMeta | null | undefined, date: Date): number | null {
  if (!meta || !("formula_divisor" in meta)) return null;
  if (meta.seasonal) {
    const m = date.getMonth() + 1;
    if (meta.seasonal.winter_months.includes(m)) return meta.seasonal.winter_divisor;
    return meta.seasonal.summer_divisor;
  }
  return meta.formula_divisor;
}

// 박스 실제무게 (소분→박스 환산용, 마진 미반영). seasonal 있으면 winter_actual/summer_actual,
// 없으면 actual_weight, 그것도 없으면 formula_divisor 폴백 (하위호환).
export function getActiveActual(meta: PackMeta | null | undefined, date: Date): number | null {
  if (!meta || !("formula_divisor" in meta)) return null;
  if (meta.seasonal) {
    const m = date.getMonth() + 1;
    const isWinter = meta.seasonal.winter_months.includes(m);
    const actual = isWinter ? meta.seasonal.winter_actual : meta.seasonal.summer_actual;
    if (actual != null) return actual;
  }
  if (meta.actual_weight != null) return meta.actual_weight;
  return getActiveDivisor(meta, date);
}

// 10원 단위 올림
export function ceil10(v: number): number {
  return Math.ceil(v / 10) * 10;
}

// 박스 매입가 → 소분 수량에 해당하는 매입가
export function boxToSubdiv(boxPrice: number, boxMeta: PackMeta, subdivMeta: PackMeta, date: Date): number | null {
  if (!("formula_divisor" in boxMeta)) return null;
  if (!("quantity" in subdivMeta)) return null;
  const divisor = getActiveDivisor(boxMeta, date);
  if (!divisor) return null;
  // 반박스는 박스의 ÷2
  if (subdivMeta.half_box) {
    return ceil10(boxPrice / 2);
  }
  // 박스 × (수량 / 공식수) = 소분가
  return ceil10(boxPrice * subdivMeta.quantity / divisor);
}

// 소분 매입가 → 같은 분류 박스 매입가 역산 (실제무게 기준 — 마진 제거)
export function subdivToBox(subdivPrice: number, subdivMeta: PackMeta, boxMeta: PackMeta, date: Date): number | null {
  if (!("quantity" in subdivMeta)) return null;
  if (!("formula_divisor" in boxMeta)) return null;
  const actual = getActiveActual(boxMeta, date);
  if (!actual) return null;
  if (subdivMeta.half_box) {
    return subdivPrice * 2;
  }
  // 소분가 ÷ 수량 × 실제무게 = 박스가 (10원 단위 올림 — 박스↔소분 일관성)
  return ceil10(subdivPrice / subdivMeta.quantity * actual);
}

// 단위 민감도 계수 (다른 단위 간 변동률 전파 시)
function getUnitSensitivity(fromUnit: string | null | undefined, toUnit: string | null | undefined): number {
  const isBox = (u: string | null | undefined) => u === "박스" || u === "반박스" || u === "망";
  const isPiece = (u: string | null | undefined) => u === "봉" || u === "단" || u === "통" || u === "개";
  const fromBox = isBox(fromUnit);
  const toBox = isBox(toUnit);
  const fromPiece = isPiece(fromUnit);
  const toPiece = isPiece(toUnit);
  if (fromBox && toBox) return 1.0;
  if (fromPiece && toPiece) return 1.0;
  if (fromPiece && toBox) return 0.75;   // 낱개→박스: 박스는 변동 완화
  if (fromBox && toPiece) return 1.3;    // 박스→낱개: 낱개는 민감
  return 1.0;
}

// 두 이력에서 공통 매입일 찾기
function findOverlapDates(a: PriceHistory[], b: PriceHistory[]): { date: string; aPrice: number; bPrice: number }[] {
  const bMap = new Map<string, number>();
  for (const h of b) if (h.price > 0) bMap.set(h.date, h.price);
  const overlap: { date: string; aPrice: number; bPrice: number }[] = [];
  for (const h of a) {
    if (h.price > 0 && bMap.has(h.date)) {
      overlap.push({ date: h.date, aPrice: h.price, bPrice: bMap.get(h.date)! });
    }
  }
  return overlap.sort((x, y) => x.date.localeCompare(y.date));
}

// Phase 5-A 메인: 그룹 기반 매입가 추정
type GroupEstimateResult = {
  estimated_price: number;
  method: string;        // "박스→소분 관계식" / "소분→박스 관계식" / "변동률 교차참조" / "동일등급 단위환산"
  anchor_code: string;   // 참조한 품목 코드
  anchor_name: string;
  reason: string;        // 학습페이지용 설명
  confidence: "high" | "medium" | "low";
};

// ─────────────────────────────────────────
// Layer 4-B: 동일 등급 단위환산 (xlsx 매핑 밖 상품들 간 가격 유추)
// 예: 005045(가지/상/박스) ↔ 007751(가지/상/반박스)  공유 텍스트 "가지/상" → 박스 ÷2 = 반박스
// ─────────────────────────────────────────

/**
 * product_name 에서 "품목/등급" 키 추출
 *  "**가지/특/국내산"   → "가지/특"
 *  "**가지/상/국내산"   → "가지/상"
 *  "가지/상/국내산"      → "가지/상"
 *  "**감자/왕특/국내산"  → "감자/왕특"
 *  "**청양고추/홀용/국내산" → "청양고추/홀용"
 *  "가지 1kg/국내산"     → null  (등급 슬래시 없음)
 *  "가지 3개/국내산"     → null
 */
/**
 * 상품명을 의미있는 토큰들로 분리 (Layer 4-B 등급 매칭용)
 *  - 슬래시(/)와 공백으로 분리
 *  - 선행 ** 제거
 *  - 원산지 토큰 제외 (국내산/수입산/중국산 등)
 *  - 숫자로 시작하는 토큰 제외 (1kg, 3개 등 수량/규격)
 *
 *  "**가지/특/국내산"            → ["가지", "특"]
 *  "**가지/상/국내산"            → ["가지", "상"]
 *  "**고구마/밤/긴상/꿀/국내산"  → ["고구마", "밤", "긴상", "꿀"]
 *  "고구마/밤 1kg/국내산"        → ["고구마", "밤"]
 *  "가지 3개/국내산"             → ["가지"]
 */
export function tokenizeName(name: string | null | undefined): string[] {
  if (!name) return [];
  return name.replace(/^\*+/, "").trim()
    .split(/[\s/]+/)
    .filter((t) => t.length > 0)
    .filter((t) => !/^(국내산|수입산|중국산|미국산|뉴질랜드산|국산|외국산|일본산|미얀마산)$/.test(t))
    .filter((t) => !/^\d/.test(t));
}

/**
 * 상품명에서 등급 tier 추출 — 작을수록 높은 등급(=비쌈)
 *
 * 사용자 도메인 규칙:
 *  - 1호 > 2호 > 3호  (숫자 호 패턴, 1호 가장 비쌈)
 *  - 특 > 상 > 일반 > 보통 > 파지
 *  - (default 마커 없음) > B  (예: 적근대 > 적근대B)
 *  - (default 마커 없음) > /상  (예: 치커리 > 치커리/상)
 *  - 고구마/밤 그룹: 中 > 긴하·특 > 왕大 > 긴왕·왕왕
 *  - 꿀(honey suffix) = 프리미엄
 *
 *  반환값: 작을수록 높은 등급. 등급 마커 없음 = 5 (default 최상).
 */
export function getGradeTier(name: string | null | undefined): number {
  const tokens = tokenizeName(name);
  if (tokens.length === 0) return 5;

  // 1) 숫자 호 패턴 (1호=101, 2호=102...) — 명시 등급 우선
  for (const t of tokens) {
    const m = t.match(/^(\d+)호$/);
    if (m) return 100 + parseInt(m[1]);
  }

  // 2) 등급 키워드 사전 (작을수록 높은 등급)
  const ranks: Record<string, number> = {
    // 최상위 (tier 5) — default 마커 없음과 동급
    "中": 5, "중": 5,
    "꿀": 5,

    // 2단계 (tier 10) — 최상급 라벨
    "특": 10,
    "긴상": 10,
    "긴하": 10,

    // 3단계 (tier 20) — 王/大 계열 큰 사이즈
    "왕大": 20, "왕대": 20,
    "왕": 20, "大": 20, "대": 20,

    // 4단계 (tier 25) — 中사이즈
    "왕왕": 25,
    "긴왕": 25,
    "긴중": 25,
    "中사이즈": 25,

    // 5단계 (tier 30)
    "상": 30,

    // 6단계 (tier 40)
    "일반": 40,
    "보통": 40,
    "中급": 40,

    // 하위 (tier 50+)
    "B": 50,
    "하": 50,
    "小": 55, "소": 55,
    "파지": 60,
  };

  let minRank = Infinity;
  for (const t of tokens) {
    const r = ranks[t];
    if (r != null && r < minRank) minRank = r;
  }

  // 등급 마커 토큰 없음 → 5 (default = 최상급, 치커리 vs 치커리/상 케이스)
  return minRank === Infinity ? 5 : minRank;
}

/**
 * 두 토큰 배열의 공통 토큰 수 (등급 매칭 점수)
 */
export function gradeMatchScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let count = 0;
  for (const t of a) if (setB.has(t)) count++;
  return count;
}

/**
 * @deprecated tokenizeName + gradeMatchScore 사용 권장
 * 첫 슬래시 기준 등급키 추출 (호환용)
 */
export function extractGradeKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name.replace(/^\*+/, "").trim();
  // 패턴: 품목명 + "/" + 등급 + ("/원산지" 또는 끝)
  const m = cleaned.match(/^([가-힣A-Za-z0-9]+)\/([가-힣A-Za-z0-9]+)(?=\/|$)/);
  if (!m) return null;
  // "1kg", "3개", "10봉" 같은 패턴은 등급이 아님 — 숫자+단위 형태 제외
  if (/^\d/.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * spec 문자열에서 kg 무게 추출 (그램도 kg 로 환산)
 *  "박스/±5kg" → 5,  "반박스/10kg" → 10,  "1kg" → 1,
 *  "500g" → 0.5,  "2kg(반박스)" → 2,  "박스/12개" → null
 */
function extractKgFromSpec(spec: string | null | undefined): number | null {
  if (!spec) return null;
  // kg 우선 매치 (2kg 의 g 를 그램으로 오인식 방지)
  const kg = spec.match(/(\d+\.?\d*)\s*[kK][gG]/);
  if (kg) return parseFloat(kg[1]);
  // 그램 — 앞에 k 가 없는 g (단어 경계)
  const g = spec.match(/(\d+\.?\d*)\s*[gG]\b/);
  if (g) return parseFloat(g[1]) / 1000;
  return null;
}

/**
 * 단위환산 비율 산출 — anchor 단위 기준 1, target 단위는 비율
 * 반환: target = anchor.price / ratio  (즉 박스(ratio=2) → 반박스 = 박스/2)
 *
 * 케이스:
 *  - 박스 ↔ 반박스: ratio = 2
 *  - 박스(spec kg) ↔ 봉(spec kg): ratio = 박스kg / 봉kg
 *  - 같은 단위: ratio = 1 (같은 등급이면 단가 같다고 보고 그대로)
 */
export function getUnitConversionRatio(
  anchorUnit: string | null | undefined,
  anchorSpec: string | null | undefined,
  myUnit: string | null | undefined,
  mySpec: string | null | undefined
): { ratio: number; note: string } | null {
  const a = (anchorUnit || "").trim();
  const t = (myUnit || "").trim();
  if (!a || !t) return null;

  const aKg = extractKgFromSpec(anchorSpec);
  const tKg = extractKgFromSpec(mySpec);

  // 같은 단위 — spec kg 가 다르면 kg 비례, 같거나 미상이면 ratio 1
  if (a === t) {
    if (aKg && tKg && aKg > 0 && tKg > 0 && aKg !== tKg) {
      return { ratio: aKg / tKg, note: `${aKg}kg→${tKg}kg ÷${(aKg / tKg).toFixed(2)}` };
    }
    return { ratio: 1, note: "동일 단위" };
  }

  // 박스 ↔ 반박스 (spec kg 가 둘 다 있으면 kg 비례 우선)
  if (aKg && tKg && aKg > 0 && tKg > 0) {
    return { ratio: aKg / tKg, note: `${aKg}kg→${tKg}kg ÷${(aKg / tKg).toFixed(2)}` };
  }
  if (a === "박스" && t === "반박스") return { ratio: 2, note: "박스→반박스 ÷2" };
  if (a === "반박스" && t === "박스") return { ratio: 0.5, note: "반박스→박스 ×2" };

  return null;
}

/**
 * Layer 4-B 메인: 같은 그룹 + 토큰 점수 매칭 + 단위환산으로 가격 유추
 *  - pack_role 태깅 없이도 동작 (xlsx 매핑 밖 상품들 대상)
 *  - 정렬: 공통 토큰 점수 ↓ → 자기 기준가 유사도 ↑ → 최신 매입일 ↓
 *  - myReferencePrice 가 있으면 가격 유사도 동점처리에 활용 (자기 매입가 기준)
 */
/**
 * tier 페어 비율 조회 (B-3)
 *  - direct: (groupId, tierA, tierB) → 그대로
 *  - reverse: (groupId, tierB, tierA) 학습됐으면 1/그값
 *  - 미학습이면 null (보정 안 함)
 *  - 의미: target(tierA) = anchor(tierB) × ratio
 */
function lookupTierRatio(
  ratios: Map<string, number> | null | undefined,
  productGroup: number | null | undefined,
  tierA: number,
  tierB: number
): number | null {
  if (!ratios || !productGroup) return null;
  if (tierA === tierB) return 1;
  const direct = ratios.get(`${productGroup}-${tierA}-${tierB}`);
  if (direct != null && direct > 0) return direct;
  const reverse = ratios.get(`${productGroup}-${tierB}-${tierA}`);
  if (reverse != null && reverse > 0) return 1 / reverse;
  return null;
}

function inferFromSameGradeMember(
  myName: string,
  myUnit: string | null | undefined,
  mySpec: string | null | undefined,
  members: GroupMember[],
  myReferencePrice: number = 0,
  myLearnedTier: number | null = null,
  myProductGroup: number | null | undefined = null,
  tierRatios: Map<string, number> | null | undefined = null,
  myPurchaseSource: string | null | undefined = null
): GroupEstimateResult | null {
  // 매입처 풀 분리 — 다른 source 멤버는 1차 anchor 후보에서 제외
  // (사용자가 같은 그룹이지만 다른 매입처라 명시한 케이스 — 직접 단위환산 부적절)
  const sourceFiltered = members.filter((m) => {
    const ms = m.purchase_source ?? null;
    const my = myPurchaseSource ?? null;
    return ms === my;
  });
  members = sourceFiltered.length > 0 ? sourceFiltered : []; // 같은 source 없으면 1차 anchor 없음 → 2차로
  const myTokens = tokenizeName(myName);
  if (myTokens.length === 0) return null;

  // 후보: 단위환산 가능 + 매입 이력 보유 + 공통 토큰 1개 이상
  type Cand = {
    member: GroupMember;
    conv: { ratio: number; note: string };
    score: number;
    latest: PriceHistory;
  };
  const candidates: Cand[] = [];
  for (const m of members) {
    const conv = getUnitConversionRatio(m.unit, m.spec, myUnit, mySpec);
    if (!conv) continue;
    const latest = [...m.short_history].reverse().find((h) => h.price > 0);
    if (!latest) continue;
    const score = gradeMatchScore(myTokens, tokenizeName(m.product_name));
    if (score === 0) continue;
    candidates.push({ member: m, conv, score, latest });
  }
  if (candidates.length === 0) return null;

  const myKeyTier = getGradeTier(myName);
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // 같은 unit 우선
    const aUnitMatch = a.member.unit === myUnit ? 0 : 1;
    const bUnitMatch = b.member.unit === myUnit ? 0 : 1;
    if (aUnitMatch !== bUnitMatch) return aUnitMatch - bUnitMatch;
    // 학습 tier diff 우선 (양쪽 다 있을 때) — 365일 매입 데이터 기반 ranking
    if (myLearnedTier != null && a.member.learned_tier != null && b.member.learned_tier != null) {
      const aLD = Math.abs(a.member.learned_tier - myLearnedTier);
      const bLD = Math.abs(b.member.learned_tier - myLearnedTier);
      if (aLD !== bLD) return aLD - bLD;
    }
    // fallback: 키워드 기반 등급 tier diff
    const aTierDiff = Math.abs(getGradeTier(a.member.product_name) - myKeyTier);
    const bTierDiff = Math.abs(getGradeTier(b.member.product_name) - myKeyTier);
    if (aTierDiff !== bTierDiff) return aTierDiff - bTierDiff;
    if (myReferencePrice > 0) {
      const aDiff = Math.abs(a.latest.price / a.conv.ratio - myReferencePrice);
      const bDiff = Math.abs(b.latest.price / b.conv.ratio - myReferencePrice);
      if (aDiff !== bDiff) return aDiff - bDiff;
    }
    if (a.latest.date !== b.latest.date) return b.latest.date.localeCompare(a.latest.date);
    return a.member.product_code.localeCompare(b.member.product_code);
  });

  const w = candidates[0];
  // 단위 환산 후 1차 가격
  const unitConverted = w.latest.price / w.conv.ratio;
  // 등급 비율 보정 (B-3): 다른 등급이면 학습된 ratio 적용
  const anchorTier = getGradeTier(w.member.product_name);
  const tierRatio = lookupTierRatio(tierRatios, myProductGroup, myKeyTier, anchorTier);
  const estimatedPrice = ceil10(tierRatio != null ? unitConverted * tierRatio : unitConverted);
  if (estimatedPrice <= 0) return null;

  const tierNote = tierRatio != null && tierRatio !== 1
    ? ` × 등급비율 ${tierRatio.toFixed(3)}(t${anchorTier}→t${myKeyTier})`
    : "";
  return {
    estimated_price: estimatedPrice,
    method: "동일등급 단위환산" + (tierRatio != null && tierRatio !== 1 ? " + 등급보정" : ""),
    anchor_code: w.member.product_code,
    anchor_name: w.member.product_name,
    reason: `[동일등급 추론] 토큰 ${w.score}개 공유: ${w.member.product_name}(${w.member.product_code}) ${w.latest.price.toLocaleString()}원 (${w.member.unit}, ${w.latest.date.slice(5)}) → ${w.conv.note}${tierNote} → ${myUnit} 환산 ${estimatedPrice.toLocaleString()}원`,
    confidence: "high",
  };
}

function estimateFromGroupMembers(
  myCode: string,
  myName: string,
  myPackRole: PackRole | null | undefined,
  myPackMeta: PackMeta | null | undefined,
  myUnit: string | null | undefined,
  mySpec: string | null | undefined,
  myHistory: PriceHistory[],
  members: GroupMember[],
  date: Date,
  myReferencePrice: number = 0,
  myLearnedTier: number | null = null,
  myProductGroup: number | null | undefined = null,
  tierRatios: Map<string, number> | null | undefined = null,
  myPurchaseSource: string | null | undefined = null
): GroupEstimateResult | null {
  if (members.length === 0) return null;

  // 박스소분 89개 매핑(pack_role+pack_meta)이 있으면 Layer 4-A 관계식이 1차.
  // Layer 4-B(토큰 매칭 단위환산)는 5단계에서 제거 — 매핑 없는 상품은 Case B(변동률 교차참조)만 사용.
  const hasPackMapping = !!(myPackRole && myPackMeta);

  // pack_role / 변동률 교차참조도 같은 매입처 풀로 한정 (다른 풀 매입가 직접 환산 방지)
  const sourceSame = members.filter((m) => (m.purchase_source ?? null) === (myPurchaseSource ?? null));
  members = sourceSame;
  if (members.length === 0) return null;

  // Case A: 나는 관계식 있고, 같은 그룹에 다른 관계식 품목이 최근 매입있음
  if (myPackRole && myPackMeta) {
    const formulaMembers = members
      .filter((m) => m.pack_role && m.pack_meta && m.short_history.length > 0)
      .sort((a, b) => b.short_history.length - a.short_history.length);

    for (const m of formulaMembers) {
      // 최신 매입가 가져오기
      const latest = [...m.short_history].reverse().find((h) => h.price > 0);
      if (!latest) continue;

      let estimatedPrice: number | null = null;
      let via: string;

      if (m.pack_role === "박스" && myPackRole === "소분") {
        // 박스 → 나(소분)
        estimatedPrice = boxToSubdiv(latest.price, m.pack_meta!, myPackMeta, date);
        via = "박스→소분 관계식";
      } else if (m.pack_role === "소분" && myPackRole === "박스") {
        // 소분 → 나(박스)
        estimatedPrice = subdivToBox(latest.price, m.pack_meta!, myPackMeta, date);
        via = "소분→박스 관계식";
      } else if (m.pack_role === "소분" && myPackRole === "소분") {
        // 소분 → 박스 → 내 소분 (calc_group 미태깅 상품 전용 폴백 — calc_group 태깅 상품은
        // buildFamilyNormalizedHistory 의 가족 재산출 경로를 대신 사용)
        const box = subdivToBox(latest.price, m.pack_meta!, myPackMeta, date);
        if (box) {
          estimatedPrice = boxToSubdiv(box, myPackMeta, myPackMeta, date);
          // 내 pack_meta 기준으로 역환산인데, 공식수만 필요하므로 reuse
          // 사실은 m.quantity가 내 quantity와 다르면 변환해야 함
          // 가지3개(3) → 가지5개(5) : 3개 기준 단가 × 5
          if ("quantity" in m.pack_meta! && "quantity" in myPackMeta) {
            estimatedPrice = ceil10(latest.price / m.pack_meta!.quantity * myPackMeta.quantity);
          }
        }
        via = "소분→소분 관계식";
      } else if (m.pack_role === "박스" && myPackRole === "박스") {
        // 박스끼리 — 보통 같은 분류면 공식수가 같을 테니 그대로 사용
        if ("formula_divisor" in m.pack_meta! && "formula_divisor" in myPackMeta &&
            m.pack_meta!.formula_divisor === myPackMeta.formula_divisor) {
          estimatedPrice = latest.price;
        } else {
          // 다른 공식수 → 비례 환산
          const mDiv = getActiveDivisor(m.pack_meta!, date);
          const myDiv = getActiveDivisor(myPackMeta, date);
          if (mDiv && myDiv) estimatedPrice = Math.round(latest.price / mDiv * myDiv);
        }
        via = "박스→박스 관계식";
      } else {
        continue;
      }

      if (estimatedPrice && estimatedPrice > 0) {
        return {
          estimated_price: estimatedPrice,
          method: via,
          anchor_code: m.product_code,
          anchor_name: m.product_name,
          reason: `[그룹 참조] ${via}: ${m.product_name}(${m.product_code}) 최근 매입 ${latest.price.toLocaleString()}원 (${latest.date.slice(5)}) → 환산 ${estimatedPrice.toLocaleString()}원`,
          confidence: "high",
        };
      }
    }
  }

  // Case B: 관계식 환산 실패 or 나는 관계식 없음 → 변동률 교차참조
  // 정렬: 토큰 점수 ↓ → 같은 unit 우선 → 학습 tier diff ↑ → 키워드 tier diff ↑ → 가격 유사도 ↑ → 이력 길이 ↓
  const myTokensForSort = tokenizeName(myName);
  const myKeyTierForSort = getGradeTier(myName);
  const candidates = members
    .filter((m) => m.short_history.some((h) => h.price > 0))
    .sort((a, b) => {
      const aScore = gradeMatchScore(myTokensForSort, tokenizeName(a.product_name));
      const bScore = gradeMatchScore(myTokensForSort, tokenizeName(b.product_name));
      if (aScore !== bScore) return bScore - aScore;
      const aUnitMatch = a.unit === myUnit ? 0 : 1;
      const bUnitMatch = b.unit === myUnit ? 0 : 1;
      if (aUnitMatch !== bUnitMatch) return aUnitMatch - bUnitMatch;
      // 학습 tier 우선 (양쪽 다 있을 때)
      if (myLearnedTier != null && a.learned_tier != null && b.learned_tier != null) {
        const aLD = Math.abs(a.learned_tier - myLearnedTier);
        const bLD = Math.abs(b.learned_tier - myLearnedTier);
        if (aLD !== bLD) return aLD - bLD;
      }
      // 키워드 tier diff fallback
      const aTierDiff = Math.abs(getGradeTier(a.product_name) - myKeyTierForSort);
      const bTierDiff = Math.abs(getGradeTier(b.product_name) - myKeyTierForSort);
      if (aTierDiff !== bTierDiff) return aTierDiff - bTierDiff;
      if (myReferencePrice > 0) {
        const aLatest = [...a.short_history].reverse().find((h) => h.price > 0)?.price ?? 0;
        const bLatest = [...b.short_history].reverse().find((h) => h.price > 0)?.price ?? 0;
        const aDiff = Math.abs(aLatest - myReferencePrice);
        const bDiff = Math.abs(bLatest - myReferencePrice);
        if (aDiff !== bDiff) return aDiff - bDiff;
      }
      return b.short_history.filter((h) => h.price > 0).length - a.short_history.filter((h) => h.price > 0).length;
    });

  for (const anchor of candidates) {
    const anchorValid = anchor.short_history.filter((h) => h.price > 0);
    if (anchorValid.length < 2) continue;

    // 내 이력과 공통일 찾기 (우선 8일, 부족하면 60일 확장)
    const overlap8 = findOverlapDates(myHistory.filter((h) => h.price > 0), anchorValid);
    const overlap = overlap8.length > 0
      ? overlap8
      : findOverlapDates(myHistory.filter((h) => h.price > 0), anchor.long_history.filter((h) => h.price > 0));

    if (overlap.length === 0) continue;

    // 가장 최근 공통일 기준
    const ref = overlap[overlap.length - 1];
    const anchorLatest = [...anchorValid].reverse().find((h) => h.price > 0)!;

    if (ref.bPrice <= 0) continue;
    const anchorChangeRate = (anchorLatest.price - ref.bPrice) / ref.bPrice;
    const unitCoef = getUnitSensitivity(anchor.unit, myUnit);
    const reflectRatio = 0.7; // 너무 공격적 반영 방지
    const adjustedRate = anchorChangeRate * unitCoef * reflectRatio;
    const estimatedPrice = ceil10(ref.aPrice * (1 + adjustedRate));

    if (estimatedPrice > 0) {
      return {
        estimated_price: estimatedPrice,
        method: "변동률 교차참조",
        anchor_code: anchor.product_code,
        anchor_name: anchor.product_name,
        reason: `[그룹 참조] 변동률 교차참조: ${anchor.product_name}(${anchor.product_code}) ${ref.date.slice(5)}→${anchorLatest.date.slice(5)} ${(anchorChangeRate * 100).toFixed(1)}% × 단위계수${unitCoef} × 반영${reflectRatio} → 내 ${ref.date.slice(5)} ${ref.aPrice.toLocaleString()}원에 ${(adjustedRate * 100).toFixed(1)}% 적용 → 추정 ${estimatedPrice.toLocaleString()}원`,
        confidence: overlap.length >= 2 ? "medium" : "low",
      };
    }
  }

  // 박스소분 89개 매핑 상품은 Layer 4-B(토큰매칭) 미사용 —
  // 관계식(Case A) + 변동률(Case B) 모두 실패하면 추정 불가로 반환
  void hasPackMapping;
  return null;
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
// 메인 추천 함수
// ─────────────────────────────────────────
export function calculateAiRecommendation(input: AiRecInput): AiRecOutput {
  const {
    prev_purchase_price: prevPP,
    current_selling_price: cur,
    prev_selling_price: prev,
    target_margin_rate: targetM,
    is_key_item: isKey,
    price_sensitivity: priceSensitivity = "일반",
    pack_role,
    pack_meta,
    group_members,
    price_date,
    unit: myUnit,
    short_history,
    long_history,
    group_trend,
  } = input;
  let pp = input.purchase_price;  // 그룹 참조로 덮어쓸 수 있음

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

  // Phase 5-A: 매입 없음 or 이력 부족 시 그룹 참조로 추정
  let estimatedFromGroup: GroupEstimateResult | null = null;
  const validHistory = short_history.filter((h) => h.price > 0);
  const shouldTryGroup = (pp <= 0 || validHistory.length < 5) && group_members && group_members.length > 0;

  if (shouldTryGroup) {
    const analysisDate = price_date ? new Date(price_date) : new Date();
    // 자기 매입가(있으면) 또는 직전 매입가를 가격유사도 기준으로 전달
    const myReferencePrice = pp > 0 ? pp : prevPP > 0 ? prevPP : 0;
    estimatedFromGroup = estimateFromGroupMembers(
      "",  // myCode 별도 불필요
      input.product_name || "",
      pack_role,
      pack_meta,
      myUnit,
      input.spec || null,
      short_history,
      group_members || [],
      analysisDate,
      myReferencePrice,
      input.learned_tier ?? null,
      input.product_group ?? null,
      input.tier_ratios ?? null,
      input.purchase_source ?? null
    );
  }

  // 매입 완전히 없는데 그룹 참조도 실패
  if (pp <= 0 && !estimatedFromGroup) {
    return {
      ai_price: 0,
      ai_reason: "매입가 없음 + 그룹 참조 실패 — 추천 불가",
      signals,
    };
  }

  // pp가 없고 그룹 참조 성공 → 그 값으로 pp 대체하여 이후 로직 진행
  if (pp <= 0 && estimatedFromGroup) {
    pp = estimatedFromGroup.estimated_price;
  }

  // 목표마진 = null/undefined → 20% fallback. 0 은 명시적 0% 로 보존 (?? vs ||)
  const targetMargin = targetM ?? 20;
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

  // 매출량 분석 (Phase 3) — PSP 과거3개월 + 이번달(MSQ) 시트 공식 기반
  const salesAnalysis = analyzeSales(
    input.month_1_qty,
    input.month_2_qty,
    input.month_3_qty,
    input.current_month_qty,
    price_date || null
  );
  // 신호 매핑: direction → 상승/하락/횡보
  let mappedSalesTrend: "상승" | "하락" | "횡보" | null = null;
  if (salesAnalysis.direction === "호조" || salesAnalysis.direction === "증가") mappedSalesTrend = "상승";
  else if (salesAnalysis.direction === "감소" || salesAnalysis.direction === "급감") mappedSalesTrend = "하락";
  else if (salesAnalysis.direction === "안정") mappedSalesTrend = "횡보";
  signals.sales_trend = mappedSalesTrend;
  signals.sales_change_pct = salesAnalysis.change_pct;

  // ─────────────────────────────────────
  // 의사결정 (Layer 1 적정매입가 기반)
  // ─────────────────────────────────────
  const reasons: string[] = [];
  let aiPrice: number;

  // Phase 5-A: 그룹 참조로 매입가를 추정했으면 먼저 표시
  if (estimatedFromGroup && input.purchase_price <= 0) {
    reasons.push(estimatedFromGroup.reason);
  } else if (estimatedFromGroup && input.purchase_price > 0) {
    // 이력 부족이지만 오늘 매입가는 있음 — 보조 정보만 기록
    reasons.push(`[그룹 참조 보조] ${estimatedFromGroup.method} (${estimatedFromGroup.anchor_name}) 추정 ${estimatedFromGroup.estimated_price.toLocaleString()}원 / 오늘 매입 ${pp.toLocaleString()}원`);
  }

  // Layer 1 분석 결과를 reason에 포함
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

  // 민감도별 수익률 하한 — 가격예민은 상향, 고정/일반은 15% 동일
  const SENSITIVITY_FLOORS: Record<string, number> = {
    "예민": 0.18,  // 대파/양상추/상추 등 — 실제 운영 수익률 반영
    "고정": 0.15,  // 콩나물/두부/마늘 등 — 기본 하한 유지
    "일반": 0.15,  // 야채/수산 기본
  };
  const MARGIN_FLOOR = SENSITIVITY_FLOORS[priceSensitivity] ?? 0.15;
  const MARGIN_FLOOR_PCT = MARGIN_FLOOR * 100;  // 백분율 버전

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
  // (A-2) 하락 이상치 — 비활성화 (사용자 의도: prev_selling_price 영향 제거)
  //   원래 의도: 매입 급락 시 prev × (1 - 매입하락률 × 0.1) 로 보수적 인하
  //   부작용: prev 가 stale 한 경우 잘못된 anchor 사용. 자기 추천가가 prev 로 롤오버되는
  //   새 운영 모델에선 self-loop 위험. (B/C/D/E) 의 마진 보정으로 충분.
  // else if (isAbnormal && purchaseChangeFromBase < 0 && prev > 0) { ... }
  else if (false /* (A-2) deactivated */) {
    void MARGIN_LOWER_PROTECT_RATIO;  // 변수 보존 (다른 곳에서 사용 가능)
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
  // Layer 2: 매출량 분석 (Phase 3) — salesAnalysis 는 위에서 이미 계산됨
  // ─────────────────────────────────────
  const purchaseStable = isPurchaseStable(layer1);

  // 매출 판정 reason (이번달 / 3개월대비 / 대응 전략)
  {
    const changeStr = salesAnalysis.change_pct === null
      ? (salesAnalysis.recent_total > 0 ? "신규매출" : "데이터없음")
      : (salesAnalysis.change_pct >= 0 ? "▲" : "▼") + Math.abs(salesAnalysis.change_pct * 100).toFixed(2) + "%";
    const monthlyStr = salesAnalysis.tier === "없음"
      ? "과거 매출 없음"
      : `과거3개월 월평균 ${salesAnalysis.monthly_avg.toFixed(1)}건`;
    const eBaseStr = salesAnalysis.expected_base >= 0.1
      ? `기대치 ${salesAnalysis.expected_base.toFixed(1)}건`
      : "기대치 미달";
    reasons.push(
      `[매출 판정] 이번달 ${salesAnalysis.recent_total.toLocaleString()}건 / ${monthlyStr} / ${eBaseStr} / 3개월대비 ${changeStr} (${salesAnalysis.tier}, ${salesAnalysis.direction}) → ${salesAnalysis.recommendation}`
    );
  }

  // ─────────────────────────────────────
  // 보정 신호 (매출량 기반 가격 조정, 지지선, 그룹, 경쟁품목)
  // ─────────────────────────────────────

  // 저수익 경고 — 현재 판매가 기준 실 수익률 체크 (currentMargin 만 사용, basePP 기준은 아래에서 별도)
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
      const aggressiveMargin = Math.max(MARGIN_FLOOR_PCT, targetMargin - 3);
      const aggressivePrice = Math.ceil(basePP / (1 - aggressiveMargin / 100) / 10) * 10;
      if (aggressivePrice < aiPrice) {
        aiPrice = aggressivePrice;
        reasons.push(
          `직전 3개월 ${salesAnalysis.prev_total}건 있었으나 최근 없음 → 공격적 인하 (수익률 ${aggressiveMargin.toFixed(1)}%, 기준${targetMargin}% - 3%p, 민감도${priceSensitivity}하한${MARGIN_FLOOR_PCT}%)로 매출 회복 시도`
        );
      }
    } else if (targetMargin > MARGIN_FLOOR_PCT) {
      // 매출 원래 적음 → 민감도별 하한부터 시작 (예민 18% / 고정 13% / 일반 15%)
      const floorPrice = Math.ceil(basePP / (1 - MARGIN_FLOOR) / 10) * 10;
      if (floorPrice < aiPrice) {
        aiPrice = floorPrice;
        reasons.push(
          `비인기 품목 (매출 없음) → 수익률 ${MARGIN_FLOOR_PCT}%(민감도${priceSensitivity} 하한)로 매출 유도`
        );
      }
    }
  }
  // (2) 매출 급감 (▼50% 이상) — 매입 안정성 기반 분기
  else if (salesAnalysis.direction === "급감") {
    const changePct = salesAnalysis.change_pct || 0;
    if (purchaseStable) {
      // 매입 안정 → 기준수익률 민감도별 하한까지 하향 (매출 하락률에 비례)
      const intensity = Math.min(1, Math.abs(changePct));
      const marginReduction = Math.min(targetMargin - MARGIN_FLOOR_PCT, intensity * 5); // 최대 5%p
      const newMargin = Math.max(MARGIN_FLOOR_PCT, targetMargin - marginReduction);
      const newPrice = Math.ceil(basePP / (1 - newMargin / 100) / 10) * 10;
      if (newPrice < aiPrice) {
        aiPrice = newPrice;
        reasons.push(
          `매출 급감 ▼${(Math.abs(changePct) * 100).toFixed(0)}% + 매입 안정(${layer1.v3_trend ?? layer1.method.split("(")[0]}/${layer1.v3_shock ?? "정상"}) → 수익률 ${newMargin.toFixed(1)}%(기준${targetMargin}% - ${marginReduction.toFixed(1)}%p, 민감도${priceSensitivity}하한${MARGIN_FLOOR_PCT}%)로 하향`
        );
      }
    } else {
      // 매입 등락 심함 → 1~2%p만 낮춤 (리스크 방어)
      const marginReduction = Math.abs(changePct) > 0.7 ? 2 : 1;
      const newMargin = Math.max(MARGIN_FLOOR_PCT, targetMargin - marginReduction);
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
    const newMargin = Math.max(MARGIN_FLOOR_PCT, targetMargin - 1);
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

  // 최소 마진 하한 — 민감도별 차등 적용, 오늘 매입가(pp) 기준 역마진 방지
  // ※ 예민 18% / 고정 13% / 일반 15%
  // ※ 플랫폼 수수료(식봄 6.6% / 배민 5.5~7.7% / 신선행 4.5% / 온일장 5%) 고려
  // ※ basePP가 아닌 pp(오늘 매입가) 기준 — 적정가가 오늘보다 낮을 때 역마진 방지
  const minPrice = Math.ceil(pp / (1 - MARGIN_FLOOR) / 10) * 10;
  if (aiPrice < minPrice && pp > 0) {
    const originalAiPrice = aiPrice;
    aiPrice = minPrice;
    reasons.push(
      `최소 마진 ${MARGIN_FLOOR_PCT}% 하한선 적용 (민감도 ${priceSensitivity}, 오늘 매입가 ${pp.toLocaleString()}원 기준, ${originalAiPrice.toLocaleString()}→${aiPrice.toLocaleString()}원)`
    );
  }

  return {
    ai_price: aiPrice,
    ai_reason: reasons.join(". "),
    signals,
  };
}
