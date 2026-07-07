// 매입 이력·매출 집계 공유 모듈 — rollSellingPrices / api/products / api/dashboard 3경로 공용
import { boxToSubdiv, subdivToBox, ceil10, type PackMeta } from "./aiRecommendation";

export const SALES_CHANNELS = ["식봄", "신선행", "온일장", "배민"] as const;

export type PurchaseRow = {
  product_code: string;
  price_date: string;
  purchase_price: number;
  quantity: number | null;
};

// 같은 (상품, 날짜) 에 매입가 여러 건이면 (매입처 상이/재고소분변경)
// 거래수량(quantity) 최대 가격을 그날 대표가로. 동량이면 더 비싼 가격. (명세 2.0절)
export function buildRepPriceIndex(rows: PurchaseRow[]): Map<string, Map<string, number>> {
  const repByCodeDate = new Map<string, Map<string, { price: number; qty: number }>>();
  for (const ph of rows) {
    if (!repByCodeDate.has(ph.product_code)) repByCodeDate.set(ph.product_code, new Map());
    const dm = repByCodeDate.get(ph.product_code)!;
    const qty = ph.quantity ?? 0;
    const cur = dm.get(ph.price_date);
    if (!cur || qty > cur.qty || (qty === cur.qty && ph.purchase_price > cur.price)) {
      dm.set(ph.price_date, { price: ph.purchase_price, qty });
    }
  }
  const repIndex = new Map<string, Map<string, number>>();
  for (const [code, dm] of repByCodeDate.entries()) {
    const dateMap = new Map<string, number>();
    for (const [date, v] of dm.entries()) dateMap.set(date, v.price);
    repIndex.set(code, dateMap);
  }
  return repIndex;
}

export type HistoryMaps = {
  shortHistoryMap: Map<string, { date: string; price: number }[]>;   // 8일 (날짜 오름차순)
  longHistoryMap: Map<string, { date: string; price: number }[]>;    // 전체 윈도우 (날짜 오름차순)
  dailyTodayMap: Map<string, number>;   // 가장 최근 distinct date 의 대표가
  dailyPrevMap: Map<string, number>;    // 그 직전 distinct date 의 대표가
  purchaseMap: Map<string, { prices: number[]; todayPrice: number | null }>;  // 7일 UI 용
  priceByDateAndCode: Map<string, Map<string, number>>;              // date → (code → 대표가), 7일 윈도우만
};

export function buildHistoryMaps(
  repIndex: Map<string, Map<string, number>>,
  opts: { priceDate: string; eightDaysAgoStr: string; sevenDaysAgoStr: string }
): HistoryMaps {
  const { priceDate, eightDaysAgoStr, sevenDaysAgoStr } = opts;

  const shortHistoryMap = new Map<string, { date: string; price: number }[]>();
  const longHistoryMap = new Map<string, { date: string; price: number }[]>();
  const purchaseMap = new Map<string, { prices: number[]; todayPrice: number | null }>();
  const priceByDateAndCode = new Map<string, Map<string, number>>();

  for (const [code, dp] of repIndex.entries()) {
    const dates = [...dp.keys()].sort();
    for (const date of dates) {
      const price = dp.get(date)!;
      const entry = { date, price };

      if (!longHistoryMap.has(code)) longHistoryMap.set(code, []);
      longHistoryMap.get(code)!.push(entry);

      if (date >= eightDaysAgoStr) {
        if (!shortHistoryMap.has(code)) shortHistoryMap.set(code, []);
        shortHistoryMap.get(code)!.push(entry);
      }

      if (date >= sevenDaysAgoStr) {
        if (!purchaseMap.has(code)) purchaseMap.set(code, { prices: [], todayPrice: null });
        const u = purchaseMap.get(code)!;
        u.prices.push(price);
        if (date === priceDate) u.todayPrice = price;

        if (!priceByDateAndCode.has(date)) priceByDateAndCode.set(date, new Map());
        priceByDateAndCode.get(date)!.set(code, price);
      }
    }
  }

  const dailyTodayMap = new Map<string, number>();
  const dailyPrevMap = new Map<string, number>();
  for (const [code, dp] of repIndex.entries()) {
    const sd = [...dp.keys()].sort().reverse();
    if (sd[0]) dailyTodayMap.set(code, dp.get(sd[0])!);
    if (sd[1]) dailyPrevMap.set(code, dp.get(sd[1])!);
  }

  return {
    shortHistoryMap,
    longHistoryMap,
    dailyTodayMap,
    dailyPrevMap,
    purchaseMap,
    priceByDateAndCode,
  };
}

// ────────────────────────────────────────────────
// 박스경유 재산출 (calc_group 가족 정규화 이력) — 엔진_로직_명세.md 3.2.1절
//
// 소분 실매입이 있어도 직접 쓰지 않는다. 매일 가족 단위로:
//  ① 박스 멤버 실매입(대표가) 있으면 그 값을 박스 원가로
//  ② 없으면 소분 멤버 중 실매입 있는 것 중 product_code 오름차순 첫 번째를
//     subdivToBox 로 환산해 박스 원가로 (결정성 확보)
//  ③ 둘 다 없으면 그 날짜는 skip
// 이후 박스 원가로 전 멤버 가격을 재산출 (박스=그대로, 소분=boxToSubdiv).
// ────────────────────────────────────────────────
export type FamilyMember = {
  product_code: string;
  pack_role: string | null;        // 박스/소분
  pack_meta: unknown;              // PackMeta
};

export function buildFamilyNormalizedHistory(
  members: FamilyMember[],
  repIndex: Map<string, Map<string, number>>,  // buildRepPriceIndex 결과
  dates: string[],                              // 소급할 날짜들 (오름차순)
): Map<string, { date: string; price: number }[]> {
  const result = new Map<string, { date: string; price: number }[]>();
  for (const m of members) result.set(m.product_code, []);

  const boxMembers = members.filter((m) => m.pack_role === "박스" && m.pack_meta);
  const subdivMembers = [...members.filter((m) => m.pack_role === "소분" && m.pack_meta)]
    .sort((a, b) => a.product_code.localeCompare(b.product_code));

  for (const date of dates) {
    const dateObj = new Date(date);

    // ① 박스 원가 결정 — 박스 멤버 실매입 우선
    let boxCost: number | null = null;
    for (const box of boxMembers) {
      const price = repIndex.get(box.product_code)?.get(date);
      if (price != null && price > 0) {
        boxCost = price;
        break;
      }
    }

    // ② 없으면 소분 실매입 중 product_code 오름차순 첫 번째를 박스 원가로 환산
    if (boxCost == null) {
      const anchorBox = boxMembers[0];
      if (anchorBox) {
        for (const sub of subdivMembers) {
          const price = repIndex.get(sub.product_code)?.get(date);
          if (price == null || price <= 0) continue;
          const converted = subdivToBox(price, sub.pack_meta as PackMeta, anchorBox.pack_meta as PackMeta, dateObj);
          if (converted != null && converted > 0) {
            boxCost = converted;
            break;
          }
        }
      }
    }

    // ③ 둘 다 없으면 skip
    if (boxCost == null) continue;

    // 멤버별 재산출가
    for (const box of boxMembers) {
      result.get(box.product_code)!.push({ date, price: boxCost });
    }
    for (const sub of subdivMembers) {
      const anchorBox = boxMembers[0];
      if (!anchorBox) continue;
      const price = boxToSubdiv(boxCost, anchorBox.pack_meta as PackMeta, sub.pack_meta as PackMeta, dateObj);
      if (price != null && price > 0) {
        result.get(sub.product_code)!.push({ date, price });
      }
    }
  }

  return result;
}

// ────────────────────────────────────────────────
// 등락률 차용 (중그룹 ↔ 소그룹) — 엔진_로직_명세.md 3.2.1절 / 4단계
//
// relation_type='등락률공유' 상품(소그룹)은 박스소분 환산 대상이 아니고
// 같은 calc_group 의 중그룹 가족(소분관계/수량동일)과 등락률(%)만 주고받는다.
//
// 방향 1 — 소그룹이 빌림: 등락률공유 상품이 오늘 실매입 없음
//   → 같은 calc_group 가족재산출 이력(박스 기준)의 오늘 rate 를 자기 마지막 대표가에 적용.
//   가족재산출 이력에 오늘이 없으면 차용 불발(기존 동작 유지).
// 방향 2 — 중그룹이 빌림: 가족 전체 오늘 매입 없음(가족재산출 이력에 오늘 없음)
//   → 같은 calc_group 등락률공유 상품 중 [90일 매입일수 최다 & 오늘 실매입 있는] 대장의
//   등락률을 가족 마지막 박스원가에 적용해 전 멤버 재산출(boxToSubdiv). 대장 없으면 불발(기존 동작 유지).
//
// rate 는 감쇠·단위계수 없이 순수 %(×1.0). 차용값은 daily_purchase_prices 에 안 씀 (메모리 주입만).
// ────────────────────────────────────────────────
export type RateShareMember = {
  product_code: string;
  calc_group: number;
};

export type RateBorrowResult = {
  code: string;               // 차용받은(재산출된) 상품 코드
  anchorCode: string;          // 대표(anchor) 코드 — 7일동향 표시용
  direction: "소그룹차용" | "중그룹차용";
};

/**
 * @param rateShareMembers 등락률공유 상품 (calc_group 포함)
 * @param familyMembersByGroup calc_group → 중그룹 가족 멤버 (pack_role/pack_meta 포함, buildFamilyNormalizedHistory 입력과 동일)
 * @param familyNormalizedByGroup calc_group → buildFamilyNormalizedHistory 결과 (박스 기준 재산출 이력)
 * @param repIndex buildRepPriceIndex 결과 (오늘 실매입 여부·90일 매입일수 판단)
 * @param dailyTodayMap / dailyPrevMap 갱신 대상 (in-place 반영)
 * @param shortHistoryMap 8일 이력 — 차용 성공 시 오늘 슬롯 추가 (in-place 반영)
 * @param longHistoryMap 전체 윈도우 이력 — 차용 성공 시 오늘 슬롯 추가 (in-place 반영)
 * @param priceDate 오늘 날짜
 * @param eightDaysAgoStr 8일 윈도우 시작일 (shortHistoryMap 필터용)
 * @param ninetyDaysAgoStr 90일 윈도우 시작일 (대장 선정 매입일수 카운트용 — repIndex 는 이 윈도우를 커버해야 함)
 */
export function applyRateBorrowing(
  rateShareMembers: RateShareMember[],
  familyMembersByGroup: Map<number, FamilyMember[]>,
  familyNormalizedByGroup: Map<number, Map<string, { date: string; price: number }[]>>,
  repIndex: Map<string, Map<string, number>>,
  dailyTodayMap: Map<string, number>,
  dailyPrevMap: Map<string, number>,
  shortHistoryMap: Map<string, { date: string; price: number }[]>,
  longHistoryMap: Map<string, { date: string; price: number }[]>,
  priceDate: string,
  eightDaysAgoStr: string,
  ninetyDaysAgoStr: string,
): RateBorrowResult[] {
  const results: RateBorrowResult[] = [];

  const addSlot = (map: Map<string, { date: string; price: number }[]>, code: string, price: number, minDate?: string) => {
    const hist = map.get(code) || [];
    const withoutToday = hist.filter((h) => h.date !== priceDate);
    withoutToday.push({ date: priceDate, price });
    map.set(code, minDate ? withoutToday.filter((h) => h.date >= minDate) : withoutToday);
  };

  const rateShareByGroup = new Map<number, RateShareMember[]>();
  for (const m of rateShareMembers) {
    if (!rateShareByGroup.has(m.calc_group)) rateShareByGroup.set(m.calc_group, []);
    rateShareByGroup.get(m.calc_group)!.push(m);
  }

  for (const [groupId, rsMembers] of rateShareByGroup) {
    const familyMembers = familyMembersByGroup.get(groupId);
    const normalized = familyNormalizedByGroup.get(groupId);
    if (!familyMembers || familyMembers.length === 0 || !normalized) continue;

    // 가족재산출 이력 오늘/직전 — 가족 멤버 아무나(전원 동일 재산출가) 기준
    let familyToday: number | null = null;
    let familyPrev: number | null = null;
    for (const fm of familyMembers) {
      const hist = normalized.get(fm.product_code);
      if (!hist || hist.length === 0) continue;
      const sorted = [...hist].sort((a, b) => b.date.localeCompare(a.date));
      if (sorted[0]?.date === priceDate) {
        familyToday = sorted[0].price;
        familyPrev = sorted[1]?.price ?? null;
      }
      break;
    }

    // ── 방향 1: 소그룹이 빌림 ──
    if (familyToday != null && familyPrev != null && familyPrev > 0) {
      const rate = (familyToday - familyPrev) / familyPrev;
      const anchorCode = familyMembers[0].product_code;
      for (const rm of rsMembers) {
        const myDates = repIndex.get(rm.product_code);
        const hasToday = myDates?.get(priceDate) != null && myDates.get(priceDate)! > 0;
        if (hasToday) continue; // 자기 실매입 있는 날 — 재산출·차용 없음

        // 자기 마지막 대표가 — repIndex(등락률공유 상품은 90일 윈도우로 조회) 상 가장 최근 실매입일 기준.
        // dailyTodayMap(60일 윈도우 기반)은 매입이 뜸한 등락률공유 상품엔 값이 없을 수 있어 미사용.
        if (!myDates || myDates.size === 0) continue;
        const sortedMyDates = [...myDates.keys()].sort().reverse();
        const lastOwn = myDates.get(sortedMyDates[0]);
        if (lastOwn == null || lastOwn <= 0) continue;
        const borrowed = ceil10(lastOwn * (1 + rate));
        dailyPrevMap.set(rm.product_code, lastOwn);
        dailyTodayMap.set(rm.product_code, borrowed);
        addSlot(shortHistoryMap, rm.product_code, borrowed, eightDaysAgoStr);
        addSlot(longHistoryMap, rm.product_code, borrowed);
        results.push({ code: rm.product_code, anchorCode, direction: "소그룹차용" });
      }
      continue;
    }
    // 가족재산출 이력에 오늘이 없으면(familyToday == null) → 방향 2 시도.

    // ── 방향 2: 중그룹이 빌림 ── 가족 전체 오늘 매입 없음
    // 대장 선정: 등락률공유 상품 중 [90일 매입일수 최다 & 오늘 실매입 있음]. 동점이면 product_code 오름차순.
    let leader: RateShareMember | null = null;
    let leaderDays = -1;
    for (const rm of rsMembers) {
      const myDates = repIndex.get(rm.product_code);
      const hasToday = myDates?.get(priceDate) != null && myDates.get(priceDate)! > 0;
      if (!hasToday) continue;
      let days = 0;
      for (const d of myDates!.keys()) {
        if (d >= ninetyDaysAgoStr && d <= priceDate) days++;
      }
      if (days > leaderDays || (days === leaderDays && (!leader || rm.product_code.localeCompare(leader.product_code) < 0))) {
        leader = rm;
        leaderDays = days;
      }
    }
    if (!leader) continue; // 대장 없으면 불발 — 기존 동작 그대로.

    const leaderDates = repIndex.get(leader.product_code)!;
    const sortedLeaderDates = [...leaderDates.keys()].sort().reverse();
    const leaderToday = leaderDates.get(sortedLeaderDates[0]);
    const leaderPrev = sortedLeaderDates[1] != null ? leaderDates.get(sortedLeaderDates[1]) : null;
    if (leaderToday == null || leaderPrev == null || leaderPrev <= 0) continue;
    const rate = (leaderToday - leaderPrev) / leaderPrev;

    // 가족 마지막 박스원가 — normalized 이력(가족 멤버 아무나) 중 가장 최근 값
    let lastFamilyPrice: number | null = null;
    for (const fm of familyMembers) {
      const hist = normalized.get(fm.product_code);
      if (!hist || hist.length === 0) continue;
      const sorted = [...hist].sort((a, b) => b.date.localeCompare(a.date));
      lastFamilyPrice = sorted[0]?.price ?? null;
      break;
    }
    if (lastFamilyPrice == null || lastFamilyPrice <= 0) continue;

    const newBoxCost = ceil10(lastFamilyPrice * (1 + rate));

    // 박스 원가 → 가족 전 멤버 재산출 (buildFamilyNormalizedHistory 와 동일한 boxToSubdiv 흐름)
    const boxMembers = familyMembers.filter((m) => m.pack_role === "박스" && m.pack_meta);
    const subdivMembers = familyMembers.filter((m) => m.pack_role === "소분" && m.pack_meta);
    const anchorBox = boxMembers[0];
    if (!anchorBox) continue;
    const dateObj = new Date(priceDate);

    // 재산출 전 마지막 대표가를 dailyPrev 로 (자기 값 없으면 가족 마지막 박스원가 환산 기준)
    const setPrevThenToday = (code: string, todayPrice: number) => {
      const lastOwn = dailyTodayMap.get(code);
      if (lastOwn != null) dailyPrevMap.set(code, lastOwn); else dailyPrevMap.delete(code);
      dailyTodayMap.set(code, todayPrice);
    };

    for (const box of boxMembers) {
      setPrevThenToday(box.product_code, newBoxCost);
      addSlot(shortHistoryMap, box.product_code, newBoxCost, eightDaysAgoStr);
      addSlot(longHistoryMap, box.product_code, newBoxCost);
      results.push({ code: box.product_code, anchorCode: leader.product_code, direction: "중그룹차용" });
    }
    for (const sub of subdivMembers) {
      const price = boxToSubdiv(newBoxCost, anchorBox.pack_meta as PackMeta, sub.pack_meta as PackMeta, dateObj);
      if (price == null || price <= 0) continue;
      setPrevThenToday(sub.product_code, price);
      addSlot(shortHistoryMap, sub.product_code, price, eightDaysAgoStr);
      addSlot(longHistoryMap, sub.product_code, price);
      results.push({ code: sub.product_code, anchorCode: leader.product_code, direction: "중그룹차용" });
    }
  }

  return results;
}

export type MonthlySalesRow = {
  product_code: string;
  sale_month: string;
  quantity: number | null;
  source: string | null;
};

// SALES_CHANNELS 4채널만 인정. 채널별 + (code,month) 4채널 합산.
export function aggregateMonthlyByChannel(rows: MonthlySalesRow[]): {
  totalByMonth: Map<string, Map<string, number>>;                       // code → month → 합
  channelData: Map<string, Map<string, Map<string, number>>>;           // code → source → month → qty
} {
  const totalByMonth = new Map<string, Map<string, number>>();
  const channelData = new Map<string, Map<string, Map<string, number>>>();

  for (const ms of rows) {
    const src = ms.source;
    if (!src || !SALES_CHANNELS.includes(src as typeof SALES_CHANNELS[number])) continue;
    const qty = ms.quantity || 0;

    if (!totalByMonth.has(ms.product_code)) totalByMonth.set(ms.product_code, new Map());
    const mm = totalByMonth.get(ms.product_code)!;
    mm.set(ms.sale_month, (mm.get(ms.sale_month) || 0) + qty);

    if (!channelData.has(ms.product_code)) channelData.set(ms.product_code, new Map());
    const sm = channelData.get(ms.product_code)!;
    if (!sm.has(src)) sm.set(src, new Map());
    sm.get(src)!.set(ms.sale_month, qty);
  }

  return { totalByMonth, channelData };
}
