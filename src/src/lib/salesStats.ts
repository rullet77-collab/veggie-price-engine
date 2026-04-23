// 매출 통계 유틸 — 플랫폼시트 공식과 동일하게 계산
//
// 시트 공식 원본:
//   a_daily = AVERAGE(각 과거월별 수량 ÷ 그 달의 일수)  ← 데이터 있는 월만 카운트
//   e_base  = a_daily × DAY(TODAY())                    ← 오늘까지의 기대 누적치
//   d_rate  = (val_cur - e_base) / e_base
//
// - month_1/2/3_qty 는 priceDate 기준 "3개월 전 → 2개월 전 → 1개월 전" 으로 해석
// - 각 월의 실제 일수를 반영 (2월 28/29일, 31일 달 구분)
// - priceDate 의 day 부분을 "오늘 진행 일수" 로 사용

/**
 * 해당 연/월의 총일수 (1-indexed month)
 */
export function daysOfYearMonth(year: number, month1: number): number {
  // Date(y, monthIdx+1, 0) = 해당 월의 마지막 날짜
  return new Date(year, month1, 0).getDate();
}

/**
 * priceDate 기준으로 과거 3개월의 (year, month) 를 계산
 * month_1 = 3개월 전, month_2 = 2개월 전, month_3 = 1개월 전
 */
export function pastMonthsFromPriceDate(priceDate: string): Array<{ year: number; month: number; days: number }> {
  const [y, mo] = priceDate.split("-").map(Number);
  const out: Array<{ year: number; month: number; days: number }> = [];
  for (const offset of [3, 2, 1]) {
    // JS Date 로 연도 롤오버 처리
    const d = new Date(y, mo - 1 - offset, 1); // mo 는 1-indexed
    const py = d.getFullYear();
    const pm = d.getMonth() + 1;
    out.push({ year: py, month: pm, days: daysOfYearMonth(py, pm) });
  }
  return out; // [month_1, month_2, month_3]
}

/**
 * 3개월대비 변화율 문자열 — 플랫폼시트 공식 그대로
 *   n_mo = 값이 0보다 큰 과거 월 개수
 *   n_mo=0 → val_cur>0 ? "신규매출" : null
 *   a_daily = Σ(qty_i / days_i, qty_i>0) / n_mo
 *   e_base  = a_daily × DAY(priceDate)
 *   e_base<0.1 → val_cur>0 ? "▲기준치미달" : "0.00%"
 *   d_rate = (val_cur - e_base) / e_base
 *   양수 "▲X.XX%" / 음수 "▼X.XX%" / 0 "0.00%"
 */
export function computePrev3MonthPct(
  m1: number | null,
  m2: number | null,
  m3: number | null,
  currentQty: number | null,
  priceDate: string | null
): string | null {
  if (!priceDate) return null;

  const months = pastMonthsFromPriceDate(priceDate);
  const vals = [m1 || 0, m2 || 0, m3 || 0];
  const days = [months[0].days, months[1].days, months[2].days];

  const nMo = vals.filter((v) => v > 0).length;
  const valCur = currentQty || 0;

  if (nMo === 0) {
    return valCur > 0 ? "신규매출" : null;
  }

  let sumDaily = 0;
  for (let i = 0; i < 3; i++) {
    if (vals[i] > 0) sumDaily += vals[i] / days[i];
  }
  const aDaily = sumDaily / nMo;

  const dayOfMonth = Number(priceDate.slice(8, 10));
  const eBase = aDaily * dayOfMonth;

  if (eBase < 0.1) {
    return valCur > 0 ? "▲기준치미달" : "0.00%";
  }

  const dRate = (valCur - eBase) / eBase;
  if (dRate > 0) return `▲${(dRate * 100).toFixed(2)}%`;
  if (dRate < 0) return `▼${(Math.abs(dRate) * 100).toFixed(2)}%`;
  return "0.00%";
}

/**
 * 시트 공식과 동일한 "오늘까지의 기대 누적치 (e_base)"
 * - AI 로직에서 매출 비교 기준으로 사용
 */
export function computeExpectedBaseQty(
  m1: number | null,
  m2: number | null,
  m3: number | null,
  priceDate: string | null
): number | null {
  if (!priceDate) return null;
  const months = pastMonthsFromPriceDate(priceDate);
  const vals = [m1 || 0, m2 || 0, m3 || 0];
  const days = [months[0].days, months[1].days, months[2].days];
  const nMo = vals.filter((v) => v > 0).length;
  if (nMo === 0) return null;

  let sumDaily = 0;
  for (let i = 0; i < 3; i++) {
    if (vals[i] > 0) sumDaily += vals[i] / days[i];
  }
  const aDaily = sumDaily / nMo;
  const dayOfMonth = Number(priceDate.slice(8, 10));
  return aDaily * dayOfMonth;
}
