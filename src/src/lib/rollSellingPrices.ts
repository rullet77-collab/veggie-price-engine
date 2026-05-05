// ────────────────────────────────────────────────
// 매입 업로드 후 자동 selling_price 라이프사이클 갱신
//
// 동작:
//  1. prev_selling_price ← COALESCE(현재 selling_price, 현재 recommended_price)
//     (어제 최종 적용가 — 사용자 수동 또는 어제 추천가)
//  2. 838개 상품 Phase 1~5-A 추천가 산출 → recommended_price 일괄 갱신
//  3. selling_price 는 그대로 (사용자 수동 입력 보존)
//
// 사용:
//  - /api/upload/purchase route 끝에서 호출
//  - /api/upload/rawdata route 의 매입현황 시트 처리 후 호출
// ────────────────────────────────────────────────

import { calculateAiRecommendation, type AiRecInput, type GroupMember } from "./aiRecommendation";
import { computePrev3MonthPct } from "./salesStats";

// 호출처에서 supabase 클라이언트 직접 주입 (createClient 의 generic 차이 회피)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(supabase: SupabaseClient, table: string, select: string, filters?: (q: any) => any): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export type RollResult = {
  prev_rolled: number;     // prev_selling_price 갱신된 행수
  recommended_set: number; // recommended_price 갱신된 행수
  duration_ms: number;
};

/**
 * 매입 업로드 직후 호출 — selling_price 라이프사이클 자동 갱신
 *
 * 순서:
 *  1. (SQL) prev_selling_price ← COALESCE(selling_price, recommended_price)
 *  2. (TS)  838개 상품 Phase 1~5-A 추천가 산출
 *  3. (SQL) recommended_price 일괄 갱신
 */
export async function rollSellingPrices(supabase: SupabaseClient): Promise<RollResult> {
  const start = Date.now();

  // ── Step 1: prev_selling_price 롤오버 (SQL upsert 로 일괄)
  // PostgREST 는 expression update 미지원 → RPC 또는 raw RPC 함수 필요
  // 여기서는 모든 행을 fetch 해서 클라이언트단 계산 후 batch update
  type SellingRow = {
    product_code: string;
    selling_price: number | null;
    prev_selling_price: number | null;
    recommended_price: number | null;
    month_1_qty: number | null; month_2_qty: number | null; month_3_qty: number | null;
  };
  const sellingRows = await fetchAll<SellingRow>(
    supabase, "product_selling_prices",
    "product_code,selling_price,prev_selling_price,recommended_price,month_1_qty,month_2_qty,month_3_qty"
  );
  const sellingMap = new Map<string, SellingRow>();
  for (const s of sellingRows) sellingMap.set(s.product_code, s);

  // prev = COALESCE(selling, recommended)  — 어제 최종 적용가
  const prevRollUpdates = sellingRows
    .map((s) => ({
      product_code: s.product_code,
      prev_selling_price: s.selling_price ?? s.recommended_price ?? null,
    }))
    .filter((u) => u.prev_selling_price != null);

  let prevRolled = 0;
  for (let i = 0; i < prevRollUpdates.length; i += 500) {
    const batch = prevRollUpdates.slice(i, i + 500);
    const { error } = await supabase
      .from("product_selling_prices")
      .upsert(batch, { onConflict: "product_code" });
    if (error) throw error;
    prevRolled += batch.length;
  }

  // ── Step 2: 추천가 일괄 산출
  // 추천가 산출에 필요한 데이터 (api/products/route.ts 와 동일하게 모음)

  const { data: latestDate } = await supabase
    .from("daily_product_management")
    .select("price_date")
    .order("price_date", { ascending: false })
    .limit(1)
    .single();

  if (!latestDate) {
    return { prev_rolled: prevRolled, recommended_set: 0, duration_ms: Date.now() - start };
  }
  const priceDate = (latestDate as { price_date: string }).price_date;

  type MgmtRow = {
    product_code: string; price_date: string;
    purchase_price: number | null; selling_price: number | null;
    prev_purchase_price: number | null;
    product_name: string | null; spec: string | null;
    unit: string | null; category_name: string | null;
  };
  const mgmtData = await fetchAll<MgmtRow>(
    supabase, "daily_product_management",
    "product_code,price_date,purchase_price,prev_purchase_price,product_name,spec,unit,category_name",
    (q) => q.eq("price_date", priceDate)
  );

  type ProdRow = {
    product_code: string; product_group: number | null;
    is_key_item: boolean; target_margin_rate: number | null;
    is_event_item: boolean; product_type: string | null;
    price_sensitivity: string | null;
    pack_role: string | null; pack_meta: unknown;
    product_name: string | null; unit: string | null; spec: string | null;
    learned_tier: number | null;
  };
  const productsData = await fetchAll<ProdRow>(
    supabase, "products",
    "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type,price_sensitivity,pack_role,pack_meta,product_name,unit,spec,learned_tier"
  );
  const productMap = new Map<string, ProdRow>();
  for (const p of productsData) productMap.set(p.product_code, p);
  const groupMembersMap = new Map<number, ProdRow[]>();
  for (const p of productsData) {
    if (p.product_group) {
      if (!groupMembersMap.has(p.product_group)) groupMembersMap.set(p.product_group, []);
      groupMembersMap.get(p.product_group)!.push(p);
    }
  }

  // 매입 이력 60일
  const sevenDaysAgo = new Date(priceDate); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const eightDaysAgo = new Date(priceDate); eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  const sixtyDaysAgo = new Date(priceDate); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  type PurchRow = { product_code: string; price_date: string; purchase_price: number };
  const purchaseHistory60 = await fetchAll<PurchRow>(
    supabase, "daily_purchase_prices",
    "product_code,price_date,purchase_price",
    (q) => q.gte("price_date", sixtyDaysAgo.toISOString().slice(0, 10))
      .lte("price_date", priceDate)
      .order("price_date", { ascending: true })
  );
  const shortHistoryMap = new Map<string, { date: string; price: number }[]>();
  const longHistoryMap = new Map<string, { date: string; price: number }[]>();
  const datePriceByCode = new Map<string, Map<string, number>>();
  const eightDaysAgoStr = eightDaysAgo.toISOString().slice(0, 10);
  for (const ph of purchaseHistory60) {
    const e = { date: ph.price_date, price: ph.purchase_price };
    if (!longHistoryMap.has(ph.product_code)) longHistoryMap.set(ph.product_code, []);
    longHistoryMap.get(ph.product_code)!.push(e);
    if (ph.price_date >= eightDaysAgoStr) {
      if (!shortHistoryMap.has(ph.product_code)) shortHistoryMap.set(ph.product_code, []);
      shortHistoryMap.get(ph.product_code)!.push(e);
    }
    if (!datePriceByCode.has(ph.product_code)) datePriceByCode.set(ph.product_code, new Map());
    datePriceByCode.get(ph.product_code)!.set(ph.price_date, ph.purchase_price);
  }
  const dailyTodayMap = new Map<string, number>();
  const dailyPrevMap = new Map<string, number>();
  for (const [code, dp] of datePriceByCode.entries()) {
    const sd = [...dp.keys()].sort().reverse();
    if (sd[0]) dailyTodayMap.set(code, dp.get(sd[0])!);
    if (sd[1]) dailyPrevMap.set(code, dp.get(sd[1])!);
  }

  // 월별 매출
  const priceDateObj = new Date(priceDate);
  const recentMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
  const prevMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1);
  const prevMonthEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
  type SalesQtyRow = { product_code: string; sale_month: string; quantity: number; source: string | null };
  const monthlySales = await fetchAll<SalesQtyRow>(
    supabase, "monthly_sales_quantity", "product_code,sale_month,quantity,source",
    (q) => q.gte("sale_month", prevMonthStart.toISOString().slice(0, 10))
  );
  const monthStr = priceDate.slice(0, 7) + "-01";
  const salesQtyMap = new Map<string, number>();
  const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
  const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
  const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);
  for (const ms of monthlySales) {
    if (ms.source && ms.source !== "전체") continue;
    const e = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };
    if (ms.sale_month === monthStr) salesQtyMap.set(ms.product_code, ms.quantity);
    if (ms.sale_month >= recentStartStr) {
      if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
      recentSalesMap.get(ms.product_code)!.push(e);
    } else if (ms.sale_month >= prevStartStr && ms.sale_month < prevEndStr) {
      if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
      prevSalesMap.get(ms.product_code)!.push(e);
    }
  }
  void computePrev3MonthPct; // 사용안함 (api/products와 동일 흐름 보존용)

  // ── Step 3: 838개 상품 추천가 산출
  const recUpdates: { product_code: string; recommended_price: number }[] = [];
  for (const row of mgmtData) {
    const prod = productMap.get(row.product_code);
    const selling = sellingMap.get(row.product_code);
    const monthlyQty = salesQtyMap.get(row.product_code) || null;

    const dailyToday = dailyTodayMap.get(row.product_code);
    const dailyPrev = dailyPrevMap.get(row.product_code);
    const purchasePrice = (dailyToday != null && dailyToday > 0) ? dailyToday : (row.purchase_price || 0);
    const prevPurchase = (dailyPrev != null && dailyPrev > 0) ? dailyPrev : (row.prev_purchase_price || 0);

    const platformSellingPrice = (selling?.selling_price ?? selling?.recommended_price ?? 0);
    const prevPlatformSellingPrice = selling?.prev_selling_price || null;
    const targetMargin = prod?.target_margin_rate ? Number(prod.target_margin_rate) : null;

    if (purchasePrice <= 0 && platformSellingPrice <= 0) continue;

    const groupMembers: GroupMember[] = prod?.product_group
      ? (groupMembersMap.get(prod.product_group) || [])
          .filter((m) => m.product_code !== row.product_code)
          .map((m) => ({
            product_code: m.product_code,
            product_name: m.product_name || "",
            pack_role: (m.pack_role as "박스" | "소분" | null),
            pack_meta: m.pack_meta as never,
            unit: m.unit, spec: m.spec, learned_tier: m.learned_tier,
            short_history: shortHistoryMap.get(m.product_code) || [],
            long_history: longHistoryMap.get(m.product_code) || [],
          }))
      : [];

    const aiInput: AiRecInput = {
      purchase_price: purchasePrice,
      prev_purchase_price: prevPurchase,
      current_selling_price: platformSellingPrice,
      prev_selling_price: prevPlatformSellingPrice || 0,
      target_margin_rate: targetMargin,
      is_key_item: prod?.is_key_item || false,
      price_sensitivity: (prod?.price_sensitivity as "예민" | "고정" | "일반" | null) || "일반",
      pack_role: (prod?.pack_role as "박스" | "소분" | null) || null,
      pack_meta: prod?.pack_meta as never,
      group_members: groupMembers,
      price_date: priceDate,
      unit: row.unit || undefined,
      product_name: row.product_name,
      spec: row.spec,
      learned_tier: prod?.learned_tier ?? null,
      short_history: shortHistoryMap.get(row.product_code) || [],
      long_history: longHistoryMap.get(row.product_code) || [],
      monthly_sales: recentSalesMap.get(row.product_code) || [],
      prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
      month_1_qty: selling?.month_1_qty || null,
      month_2_qty: selling?.month_2_qty || null,
      month_3_qty: selling?.month_3_qty || null,
      current_month_qty: monthlyQty,
      group_trend: null,
    };

    const ai = calculateAiRecommendation(aiInput);
    if (ai.ai_price > 0) {
      recUpdates.push({ product_code: row.product_code, recommended_price: ai.ai_price });
    }
  }

  // ── Step 4: recommended_price 일괄 update
  let recSet = 0;
  for (let i = 0; i < recUpdates.length; i += 500) {
    const batch = recUpdates.slice(i, i + 500);
    const { error } = await supabase
      .from("product_selling_prices")
      .upsert(batch, { onConflict: "product_code" });
    if (error) throw error;
    recSet += batch.length;
  }

  return {
    prev_rolled: prevRolled,
    recommended_set: recSet,
    duration_ms: Date.now() - start,
  };
}
