// 매입 이력·매출 집계 공유 모듈 — rollSellingPrices / api/products / api/dashboard 3경로 공용
import { boxToSubdiv, subdivToBox, type PackMeta } from "./aiRecommendation";

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
