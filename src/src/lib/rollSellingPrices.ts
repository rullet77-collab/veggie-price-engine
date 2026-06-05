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
  // priceDate = daily_purchase_prices.max — 엔진은 현재 폴더 매입/매출 raw 만 사용.
  // 천년경영 "기존/변경"(mgmt) 미사용.
  const dailyMaxRes = await supabase
    .from("daily_purchase_prices")
    .select("price_date")
    .order("price_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const priceDate = (dailyMaxRes.data as { price_date: string } | null)?.price_date ?? null;

  if (!priceDate) {
    return { prev_rolled: prevRolled, recommended_set: 0, duration_ms: Date.now() - start };
  }

  type ProdRow = {
    product_code: string; product_group: number | null;
    is_key_item: boolean; target_margin_rate: number | null;
    is_event_item: boolean; product_type: string | null;
    price_sensitivity: string | null;
    pack_role: string | null; pack_meta: unknown;
    product_name: string | null; unit: string | null; spec: string | null;
    learned_tier: number | null;
    price_fixed: boolean | null;
    purchase_source: string | null;
  };
  const productsData = await fetchAll<ProdRow>(
    supabase, "products",
    "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type,price_sensitivity,pack_role,pack_meta,product_name,unit,spec,learned_tier,price_fixed,purchase_source"
  );

  // group_tier_ratios 로드 (B-3) — Map<"groupId-tierA-tierB", ratio>
  type TierRatioRow = { product_group: number; tier_a: number; tier_b: number; ratio: number };
  const tierRatioRows = await fetchAll<TierRatioRow>(
    supabase, "group_tier_ratios", "product_group,tier_a,tier_b,ratio"
  );
  const tierRatios = new Map<string, number>();
  for (const r of tierRatioRows) {
    tierRatios.set(`${r.product_group}-${r.tier_a}-${r.tier_b}`, Number(r.ratio));
  }
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
  // KST 안전: 'YYYY-MM-DD' 문자열 직접 산술 (UTC 변환 회피)
  const addDays = (yyyymmdd: string, days: number): string => {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    // 로컬 timezone 영향 없이 UTC 시점에서 산술 후 같은 형식으로 반환
    const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
    const dt = new Date(t);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  };
  const eightDaysAgoStr = addDays(priceDate, -8);
  const sixtyDaysAgoStr = addDays(priceDate, -60);
  type PurchRow = { product_code: string; price_date: string; purchase_price: number; quantity: number | null };
  const purchaseHistory60 = await fetchAll<PurchRow>(
    supabase, "daily_purchase_prices",
    "product_code,price_date,purchase_price,quantity",
    (q) => q.gte("price_date", sixtyDaysAgoStr)
      .lte("price_date", priceDate)
      .order("price_date", { ascending: true })
  );
  // 같은 (상품, 날짜) 에 매입가 여러 건이면 (매입처 상이 / 재고소분변경 등)
  // 거래수량(quantity) 이 가장 많은 가격을 그날 대표 매입가로 쓴다. 동량이면 더 비싼 가격.
  const repByCodeDate = new Map<string, Map<string, { price: number; qty: number }>>();
  for (const ph of purchaseHistory60) {
    if (!repByCodeDate.has(ph.product_code)) repByCodeDate.set(ph.product_code, new Map());
    const dm = repByCodeDate.get(ph.product_code)!;
    const qty = ph.quantity ?? 0;
    const cur = dm.get(ph.price_date);
    if (!cur || qty > cur.qty || (qty === cur.qty && ph.purchase_price > cur.price)) {
      dm.set(ph.price_date, { price: ph.purchase_price, qty });
    }
  }
  // 대표가로 이력 맵 구성 (날짜 오름차순, 날짜당 1건)
  const shortHistoryMap = new Map<string, { date: string; price: number }[]>();
  const longHistoryMap = new Map<string, { date: string; price: number }[]>();
  const datePriceByCode = new Map<string, Map<string, number>>();
  for (const [code, dm] of repByCodeDate.entries()) {
    const dateMap = new Map<string, number>();
    const dates = [...dm.keys()].sort();
    for (const date of dates) {
      const price = dm.get(date)!.price;
      const e = { date, price };
      if (!longHistoryMap.has(code)) longHistoryMap.set(code, []);
      longHistoryMap.get(code)!.push(e);
      if (date >= eightDaysAgoStr) {
        if (!shortHistoryMap.has(code)) shortHistoryMap.set(code, []);
        shortHistoryMap.get(code)!.push(e);
      }
      dateMap.set(date, price);
    }
    datePriceByCode.set(code, dateMap);
  }
  const dailyTodayMap = new Map<string, number>();
  const dailyPrevMap = new Map<string, number>();
  for (const [code, dp] of datePriceByCode.entries()) {
    const sd = [...dp.keys()].sort().reverse();
    if (sd[0]) dailyTodayMap.set(code, dp.get(sd[0])!);
    if (sd[1]) dailyPrevMap.set(code, dp.get(sd[1])!);
  }

  // 월별 매출 — 월 단위 산술도 KST 안전 (priceDate.slice(0,7) 기준)
  const monthStart = (yyyymm: string, deltaMonths: number): string => {
    const [y, m] = yyyymm.split("-").map(Number);
    let nm = m + deltaMonths;
    let ny = y;
    while (nm <= 0) { nm += 12; ny -= 1; }
    while (nm > 12) { nm -= 12; ny += 1; }
    return `${ny}-${String(nm).padStart(2, "0")}-01`;
  };
  const yyyymm = priceDate.slice(0, 7);
  const recentStartStr = monthStart(yyyymm, -2);
  const prevStartStr = monthStart(yyyymm, -5);
  const prevEndStr = monthStart(yyyymm, -2);
  type SalesQtyRow = { product_code: string; sale_month: string; quantity: number; source: string | null };
  const monthlySales = await fetchAll<SalesQtyRow>(
    supabase, "monthly_sales_quantity", "product_code,sale_month,quantity,source",
    (q) => q.gte("sale_month", prevStartStr)
  );
  const monthStr = yyyymm + "-01";
  const salesQtyMap = new Map<string, number>();
  const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  // 매출 = 식봄/신선행/온일장/배민 4채널 합산.
  // monthly_sales_quantity 에는 "전체" source 가 없고 채널별로만 적재되므로
  // api/products(route.ts) 와 동일하게 (code, month) 별로 4채널을 합산해 쓴다.
  const CHANNELS = ["식봄", "신선행", "온일장", "배민"];
  const totalByMonth = new Map<string, Map<string, number>>(); // code → month → 4채널 합
  for (const ms of monthlySales) {
    if (!ms.source || !CHANNELS.includes(ms.source)) continue;
    if (!totalByMonth.has(ms.product_code)) totalByMonth.set(ms.product_code, new Map());
    const mm = totalByMonth.get(ms.product_code)!;
    mm.set(ms.sale_month, (mm.get(ms.sale_month) || 0) + (ms.quantity || 0));
  }
  for (const [code, monthMap] of totalByMonth.entries()) {
    for (const [sm, qty] of monthMap.entries()) {
      if (sm === monthStr) salesQtyMap.set(code, qty);
      const e = { sale_month: sm, quantity: qty };
      if (sm >= recentStartStr) {
        if (!recentSalesMap.has(code)) recentSalesMap.set(code, []);
        recentSalesMap.get(code)!.push(e);
      } else if (sm >= prevStartStr && sm < prevEndStr) {
        if (!prevSalesMap.has(code)) prevSalesMap.set(code, []);
        prevSalesMap.get(code)!.push(e);
      }
    }
  }
  void computePrev3MonthPct; // 사용안함 (api/products와 동일 흐름 보존용)

  // ── Step 3: 838개 전 상품 추천가 산출 (products 기준)
  const recUpdates: { product_code: string; recommended_price: number }[] = [];
  for (const prod of productsData) {
    const code = prod.product_code;
    const selling = sellingMap.get(code);
    const monthlyQty = salesQtyMap.get(code) || null;

    // 매입가 = daily_purchase_prices 만 (mgmt fallback 제거).
    // daily 없으면 0 → AI 엔진이 박스소분 역산/그룹 변동률 추정.
    const dailyToday = dailyTodayMap.get(code);
    const dailyPrev = dailyPrevMap.get(code);
    const purchasePrice = (dailyToday != null && dailyToday > 0) ? dailyToday : 0;
    const prevPurchase = (dailyPrev != null && dailyPrev > 0) ? dailyPrev : 0;

    const platformSellingPrice = (selling?.selling_price ?? selling?.recommended_price ?? 0);
    const prevPlatformSellingPrice = selling?.prev_selling_price || null;
    const targetMargin = prod.target_margin_rate != null ? Number(prod.target_margin_rate) : null;

    if (purchasePrice <= 0 && platformSellingPrice <= 0 && !prod.product_group) continue;

    // 판매가 고정 — 자동 추천 산출 skip, selling_price 를 recommended 로 유지
    if (prod.price_fixed) {
      if (selling?.selling_price != null && selling.selling_price > 0) {
        recUpdates.push({ product_code: code, recommended_price: selling.selling_price });
      }
      continue;
    }

    const groupMembers: GroupMember[] = prod.product_group
      ? (groupMembersMap.get(prod.product_group) || [])
          .filter((m) => m.product_code !== code)
          .map((m) => ({
            product_code: m.product_code,
            product_name: m.product_name || "",
            pack_role: (m.pack_role as "박스" | "소분" | null),
            pack_meta: m.pack_meta as never,
            unit: m.unit, spec: m.spec, learned_tier: m.learned_tier,
            purchase_source: m.purchase_source,
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
      is_key_item: prod.is_key_item || false,
      price_sensitivity: (prod.price_sensitivity as "예민" | "고정" | "일반" | null) || "일반",
      pack_role: (prod.pack_role as "박스" | "소분" | null) || null,
      pack_meta: prod.pack_meta as never,
      group_members: groupMembers,
      price_date: priceDate,
      unit: prod.unit || undefined,
      product_name: prod.product_name,
      spec: prod.spec,
      learned_tier: prod.learned_tier ?? null,
      short_history: shortHistoryMap.get(code) || [],
      long_history: longHistoryMap.get(code) || [],
      monthly_sales: recentSalesMap.get(code) || [],
      prev_monthly_sales: prevSalesMap.get(code) || [],
      month_1_qty: selling?.month_1_qty || null,
      month_2_qty: selling?.month_2_qty || null,
      month_3_qty: selling?.month_3_qty || null,
      current_month_qty: monthlyQty,
      group_trend: null,
      product_group: prod.product_group ?? null,
      tier_ratios: tierRatios,
      purchase_source: prod.purchase_source ?? null,
    };

    const ai = calculateAiRecommendation(aiInput);
    if (ai.ai_price > 0) {
      recUpdates.push({ product_code: code, recommended_price: ai.ai_price });
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
