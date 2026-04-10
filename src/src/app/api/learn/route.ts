import { supabase } from "@/lib/supabase";
import { calculateAiRecommendation as calcAi, type AiRecInput } from "@/lib/aiRecommendation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(table: string, select: string, filters?: (q: any) => any): Promise<T[]> {
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

// GET: 세션 로드. ?date=YYYY-MM-DD 지정 시 해당 날짜, 미지정 시 최신 판매가 날짜
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const dateParam = url.searchParams.get("date");

    let priceDate: string;
    if (dateParam) {
      priceDate = dateParam;
    } else {
      const { data: latestDate } = await supabase
        .from("daily_product_management")
        .select("price_date")
        .order("price_date", { ascending: false })
        .limit(1)
        .single();

      if (!latestDate) return Response.json({ items: [], price_date: null, has_session: false });
      priceDate = latestDate.price_date;
    }

    // 오늘 세션 조회
    const { data: items } = await supabase
      .from("learning_items")
      .select("*")
      .eq("session_date", priceDate)
      .order("item_order", { ascending: true });

    if (!items || items.length === 0) {
      return Response.json({ items: [], price_date: priceDate, has_session: false });
    }

    // prev_3month_pct 조회 (product_selling_prices)
    const itemCodes = items.map((i: { product_code: string }) => i.product_code);
    const { data: pspData } = await supabase
      .from("product_selling_prices")
      .select("product_code,prev_3month_pct")
      .in("product_code", itemCodes);
    const pctMap = new Map<string, string | null>();
    for (const r of pspData || []) pctMap.set(r.product_code, r.prev_3month_pct);

    return Response.json({
      items: items.map((item: { product_code: string }) => ({
        ...mapItemToApi(item),
        prev_3month_pct: pctMap.get(item.product_code) || null,
      })),
      price_date: priceDate,
      has_session: true,
    });
  } catch (err: unknown) {
    console.error("Learn GET error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ error: message }, { status: 500 });
  }
}

// POST: 새 학습 세션 생성 (무작위 10개 선정 → DB 저장)
export async function POST() {
  try {
    const { data: latestDate } = await supabase
      .from("daily_product_management")
      .select("price_date")
      .order("price_date", { ascending: false })
      .limit(1)
      .single();

    if (!latestDate) return Response.json({ items: [], price_date: null });
    const priceDate = latestDate.price_date;

    // 기존 세션 삭제 (다시 실행하면 덮어쓰기)
    await supabase.from("learning_items").delete().eq("session_date", priceDate);
    await supabase.from("learning_sessions").delete().eq("session_date", priceDate);

    // 2) 해당 날짜 전체 상품
    type MgmtRow = {
      product_code: string; price_date: string;
      purchase_price: number | null; prev_purchase_price: number | null;
      product_name: string | null; spec: string | null;
      unit: string | null; category_name: string | null;
    };
    const mgmtData = await fetchAll<MgmtRow>(
      "daily_product_management",
      "product_code,price_date,purchase_price,prev_purchase_price,product_name,spec,unit,category_name",
      (q) => q.eq("price_date", priceDate)
    );

    // 3) 야채 상품만 필터
    type ProdRow = {
      product_code: string; product_group: number | null;
      is_key_item: boolean; target_margin_rate: number | null;
      product_type: string | null;
    };
    const allProducts = await fetchAll<ProdRow>(
      "products",
      "product_code,product_group,is_key_item,target_margin_rate,product_type"
    );
    const vegeCodes = new Set(allProducts.filter((p) => p.product_type === "야채").map((p) => p.product_code));
    const productMap = new Map<string, ProdRow>();
    for (const p of allProducts) productMap.set(p.product_code, p);

    // 4) 판매가 변경이 있는 야채 상품
    type SellingRow = {
      product_code: string; selling_price: number; prev_selling_price: number | null;
      prev_3month_pct: string | null;
    };
    const sellingData = await fetchAll<SellingRow>(
      "product_selling_prices",
      "product_code,selling_price,prev_selling_price,prev_3month_pct"
    );
    const sellingMap = new Map<string, SellingRow>();
    for (const s of sellingData) sellingMap.set(s.product_code, s);

    const changedVege = mgmtData.filter((r) => {
      if (!vegeCodes.has(r.product_code)) return false;
      const sel = sellingMap.get(r.product_code);
      if (!sel) return false;
      return sel.prev_selling_price != null && sel.selling_price !== sel.prev_selling_price;
    });

    // 무작위 10개 선정
    const shuffled = changedVege.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 10);

    if (selected.length === 0) return Response.json({ items: [], price_date: priceDate });

    const codes = selected.map((s) => s.product_code);

    // 5) 매입가 이력 조회
    //    단기 창 (8일) → 차트 및 단기 추세 판정
    //    장기 창 (60일) → 지지선/저항선 추출
    const eightDaysAgo = new Date(priceDate);
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const sixtyDaysAgo = new Date(priceDate);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    type PurchRow = { product_code: string; price_date: string; purchase_price: number };

    // 장기 (60일) — 모든 단기 데이터 포함
    const longHistory = await fetchAll<PurchRow>(
      "daily_purchase_prices",
      "product_code,price_date,purchase_price",
      (q) => q.in("product_code", codes)
        .gte("price_date", sixtyDaysAgo.toISOString().slice(0, 10))
        .lte("price_date", priceDate)
        .order("price_date", { ascending: true })
    );

    const longMap = new Map<string, { date: string; price: number }[]>();
    const shortMap = new Map<string, { date: string; price: number }[]>();
    const eightDaysAgoStr = eightDaysAgo.toISOString().slice(0, 10);
    for (const ph of longHistory) {
      const entry = { date: ph.price_date, price: ph.purchase_price };
      if (!longMap.has(ph.product_code)) longMap.set(ph.product_code, []);
      longMap.get(ph.product_code)!.push(entry);
      if (ph.price_date >= eightDaysAgoStr) {
        if (!shortMap.has(ph.product_code)) shortMap.set(ph.product_code, []);
        shortMap.get(ph.product_code)!.push(entry);
      }
    }

    // 6) 월별 매출 수량 — 최근 3개월 + 직전 3개월 (매출량 추세 판정용)
    const priceDateObj = new Date(priceDate);
    const recentMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
    const prevMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1);
    const prevMonthEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);

    type MonthlyRow = { product_code: string; sale_month: string; quantity: number; source: string };
    const monthlySales = await fetchAll<MonthlyRow>(
      "monthly_sales_quantity",
      "product_code,sale_month,quantity,source",
      (q) => q.in("product_code", codes)
        .gte("sale_month", prevMonthStart.toISOString().slice(0, 10))
    );

    const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
    const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
    const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);
    for (const ms of monthlySales) {
      // source '전체' 만 사용 (신선행 별도 처리 생략)
      if (ms.source && ms.source !== "전체") continue;
      const entry = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };
      if (ms.sale_month >= recentStartStr) {
        if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
        recentSalesMap.get(ms.product_code)!.push(entry);
      } else if (ms.sale_month >= prevStartStr && ms.sale_month < prevEndStr) {
        if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
        prevSalesMap.get(ms.product_code)!.push(entry);
      }
    }

    // 7) 그룹 추세 — 같은 product_group 의 평균 단기 추세
    //    선택된 상품의 그룹 목록 수집
    const selectedGroups = new Set<number>();
    for (const code of codes) {
      const prod = productMap.get(code);
      if (prod?.product_group) selectedGroups.add(prod.product_group);
    }

    const groupMembers = new Map<number, string[]>(); // group → member codes
    for (const p of allProducts) {
      if (p.product_group && selectedGroups.has(p.product_group)) {
        if (!groupMembers.has(p.product_group)) groupMembers.set(p.product_group, []);
        groupMembers.get(p.product_group)!.push(p.product_code);
      }
    }

    // 그룹 멤버들의 8일 매입가 — 평균 추세 계산용
    const groupMemberCodes = Array.from(new Set(
      Array.from(groupMembers.values()).flat()
    ));
    const groupHistory = groupMemberCodes.length > 0
      ? await fetchAll<PurchRow>(
          "daily_purchase_prices",
          "product_code,price_date,purchase_price",
          (q) => q.in("product_code", groupMemberCodes)
            .gte("price_date", eightDaysAgoStr)
            .lte("price_date", priceDate)
            .order("price_date", { ascending: true })
        )
      : [];
    const groupMemberHistoryMap = new Map<string, number[]>();
    for (const gh of groupHistory) {
      if (!groupMemberHistoryMap.has(gh.product_code)) groupMemberHistoryMap.set(gh.product_code, []);
      groupMemberHistoryMap.get(gh.product_code)!.push(gh.purchase_price);
    }

    // 그룹별 평균 추세 (상승/하락/횡보)
    const groupTrendMap = new Map<number, "상승" | "하락" | "횡보">();
    for (const [gid, members] of groupMembers.entries()) {
      let upCount = 0, downCount = 0, flatCount = 0;
      for (const m of members) {
        const prices = groupMemberHistoryMap.get(m) || [];
        if (prices.length < 2) continue;
        const first = prices[0];
        const last = prices[prices.length - 1];
        if (first <= 0 || last <= 0) continue;
        const delta = (last - first) / first;
        if (delta > 0.02) upCount++;
        else if (delta < -0.02) downCount++;
        else flatCount++;
      }
      if (upCount > downCount && upCount > flatCount) groupTrendMap.set(gid, "상승");
      else if (downCount > upCount && downCount > flatCount) groupTrendMap.set(gid, "하락");
      else groupTrendMap.set(gid, "횡보");
    }

    // 8) 세션 생성 + 아이템 저장
    await supabase.from("learning_sessions").insert({ session_date: priceDate });

    const itemsToInsert = selected.map((row, idx) => {
      const prod = productMap.get(row.product_code);
      const selling = sellingMap.get(row.product_code)!;
      const shortHistory = shortMap.get(row.product_code) || [];
      const longHistArr = longMap.get(row.product_code) || [];

      const purchasePrice = row.purchase_price || 0;
      const prevPurchase = row.prev_purchase_price || 0;
      const userPrice = selling.selling_price;
      const prevPrice = selling.prev_selling_price || 0;
      const targetMargin = prod?.target_margin_rate ? Number(prod.target_margin_rate) : null;

      const aiInput: AiRecInput = {
        purchase_price: purchasePrice,
        prev_purchase_price: prevPurchase,
        current_selling_price: userPrice,
        prev_selling_price: prevPrice,
        target_margin_rate: targetMargin,
        is_key_item: prod?.is_key_item || false,
        short_history: shortHistory,
        long_history: longHistArr,
        monthly_sales: recentSalesMap.get(row.product_code) || [],
        prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
        group_trend: prod?.product_group ? groupTrendMap.get(prod.product_group) || null : null,
      };

      const { ai_price, ai_reason } = calcAi(aiInput);

      return {
        session_date: priceDate,
        product_code: row.product_code,
        item_order: idx,
        product_name: row.product_name,
        spec: row.spec,
        unit: row.unit,
        category_name: row.category_name,
        is_key_item: prod?.is_key_item || false,
        product_group: prod?.product_group || null,
        purchase_price: purchasePrice,
        prev_purchase_price: prevPurchase,
        purchase_history: shortHistory,
        prev_selling_price: prevPrice,
        user_price: userPrice,
        target_margin_rate: targetMargin,
        ai_price,
        ai_reason,
        user_reason: "",
        user_comment_on_ai: "",
        ai_comment_on_user: "",
      };
    });

    const { data: inserted, error: insertError } = await supabase
      .from("learning_items")
      .insert(itemsToInsert)
      .select();

    if (insertError) throw insertError;

    // prev_3month_pct 조회
    const pspCodes = (inserted || []).map((i: { product_code: string }) => i.product_code);
    const { data: pspPost } = await supabase
      .from("product_selling_prices")
      .select("product_code,prev_3month_pct")
      .in("product_code", pspCodes);
    const pctPostMap = new Map<string, string | null>();
    for (const r of pspPost || []) pctPostMap.set(r.product_code, r.prev_3month_pct);

    return Response.json({
      items: (inserted || []).map((item: { product_code: string }) => ({
        ...mapItemToApi(item),
        prev_3month_pct: pctPostMap.get(item.product_code) || null,
      })),
      price_date: priceDate,
      has_session: true,
    });
  } catch (err: unknown) {
    console.error("Learn POST error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ error: message }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapItemToApi(item: any) {
  const purchasePrice = item.purchase_price || 0;
  const userPrice = item.user_price || 0;
  const aiPrice = item.ai_price || 0;
  const userMargin = userPrice > 0 ? 1 - purchasePrice / userPrice : 0;
  const aiMargin = aiPrice > 0 ? 1 - purchasePrice / aiPrice : 0;

  return {
    product_code: item.product_code,
    product_name: item.product_name,
    spec: item.spec,
    unit: item.unit,
    category_name: item.category_name,
    is_key_item: item.is_key_item,
    product_group: item.product_group,
    purchase_price: purchasePrice,
    prev_purchase_price: item.prev_purchase_price || 0,
    purchase_change: purchasePrice - (item.prev_purchase_price || 0),
    purchase_history: item.purchase_history || [],
    target_margin_rate: item.target_margin_rate,
    prev_selling_price: item.prev_selling_price || 0,
    user_price: userPrice,
    user_margin: userMargin,
    ai_price: aiPrice,
    ai_margin: aiMargin,
    ai_reason: item.ai_reason,
    user_reason: item.user_reason || "",
    user_comment_on_ai: item.user_comment_on_ai || "",
    ai_comment_on_user: item.ai_comment_on_user || "",
  };
}

// AI 추천 로직은 @/lib/aiRecommendation 으로 이동
