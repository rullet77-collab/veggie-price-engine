import { supabase } from "@/lib/supabase";
import { calculateAiRecommendation, type AiRecInput } from "@/lib/aiRecommendation";

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

// AI reason 문자열에서 UI용 짧은 태그 추출
function extractShortReason(reason: string): string {
  if (reason.includes("역마진")) return "역마진";
  if (reason.includes("이상치-상승")) return "상승이상";
  if (reason.includes("이상치-하락")) return "하락이상";
  if (reason.includes("매출 급감")) return "매출↓";
  if (reason.includes("공격적 인하")) return "공격인하";
  if (reason.includes("비인기 품목")) return "비인기";
  if (reason.includes("8일간") && reason.includes("상승") && reason.includes("연속")) return "매입↑↑";
  if (reason.includes("8일간") && reason.includes("하락") && reason.includes("연속")) return "매입↓↓";
  if (reason.includes("상승 추세")) return "매입↑";
  if (reason.includes("하락 추세")) return "매입↓";
  if (reason.includes("변곡점")) return "변곡";
  if (reason.includes("매출 ▲") && reason.includes("가격예민")) return "매출↑예민";
  if (reason.includes("매출 ▲") && reason.includes("가격고정")) return "매출↑고정";
  if (reason.includes("매출 ▲")) return "매출↑";
  if (reason.includes("주요 경쟁품목")) return "경쟁가드";
  if (reason.includes("하한선")) return "하한";
  if (reason.includes("보합") || reason.includes("매입 이력 부족")) return "유지";
  return "기본";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const group = url.searchParams.get("group");

    // 1) 최신 날짜의 daily_product_management
    const { data: latestDate } = await supabase
      .from("daily_product_management")
      .select("price_date")
      .order("price_date", { ascending: false })
      .limit(1)
      .single();

    if (!latestDate) return Response.json([]);
    const priceDate = latestDate.price_date;

    // 2) 해당 날짜 전체 상품 (매입가 데이터)
    type MgmtRow = {
      product_code: string; price_date: string;
      purchase_price: number | null; selling_price: number | null;
      prev_purchase_price: number | null; prev_selling_price: number | null;
      product_name: string | null; spec: string | null;
      unit: string | null; category_name: string | null;
      major_category: string | null;
    };
    const mgmtData = await fetchAll<MgmtRow>(
      "daily_product_management",
      "product_code,price_date,purchase_price,selling_price,prev_purchase_price,prev_selling_price,product_name,spec,unit,category_name,major_category",
      (q) => q.eq("price_date", priceDate)
    );

    // 3) products 마스터
    type ProdRow = {
      product_code: string; product_group: number | null;
      is_key_item: boolean; target_margin_rate: number | null;
      is_event_item: boolean; product_type: string | null;
      price_sensitivity: string | null;
    };
    const productsData = await fetchAll<ProdRow>(
      "products",
      "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type,price_sensitivity"
    );
    const productMap = new Map<string, ProdRow>();
    for (const p of productsData) productMap.set(p.product_code, p);

    // 4) 플랫폼 판매가 + 월별 매출 통계
    type SellingRow = {
      product_code: string; selling_price: number; prev_selling_price: number | null;
      month_1_qty: number | null; month_2_qty: number | null; month_3_qty: number | null;
      current_month_qty: number | null; prev_3month_pct: string | null;
    };
    const sellingData = await fetchAll<SellingRow>(
      "product_selling_prices",
      "product_code,selling_price,prev_selling_price,month_1_qty,month_2_qty,month_3_qty,current_month_qty,prev_3month_pct"
    );
    const sellingMap = new Map<string, SellingRow>();
    for (const s of sellingData) sellingMap.set(s.product_code, s);

    // 5) 매입가 이력 — 7일(UI용) + 8일(Layer 1) + 60일(Layer 1 장기)
    const sevenDaysAgo = new Date(priceDate);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const eightDaysAgo = new Date(priceDate);
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const sixtyDaysAgo = new Date(priceDate);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    type PurchRow = { product_code: string; price_date: string; purchase_price: number };
    const purchaseHistory60 = await fetchAll<PurchRow>(
      "daily_purchase_prices",
      "product_code,price_date,purchase_price",
      (q) => q.gte("price_date", sixtyDaysAgo.toISOString().slice(0, 10)).lte("price_date", priceDate).order("price_date", { ascending: true })
    );

    const purchaseMap = new Map<string, { prices: number[]; todayPrice: number | null }>();     // 7일 (UI)
    const shortHistoryMap = new Map<string, { date: string; price: number }[]>();                 // 8일 (Layer 1)
    const longHistoryMap = new Map<string, { date: string; price: number }[]>();                  // 60일 (Layer 1 장기)
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
    const eightDaysAgoStr = eightDaysAgo.toISOString().slice(0, 10);

    for (const ph of purchaseHistory60) {
      const entry = { date: ph.price_date, price: ph.purchase_price };

      if (!longHistoryMap.has(ph.product_code)) longHistoryMap.set(ph.product_code, []);
      longHistoryMap.get(ph.product_code)!.push(entry);

      if (ph.price_date >= eightDaysAgoStr) {
        if (!shortHistoryMap.has(ph.product_code)) shortHistoryMap.set(ph.product_code, []);
        shortHistoryMap.get(ph.product_code)!.push(entry);
      }

      if (ph.price_date >= sevenDaysAgoStr) {
        if (!purchaseMap.has(ph.product_code)) purchaseMap.set(ph.product_code, { prices: [], todayPrice: null });
        const u = purchaseMap.get(ph.product_code)!;
        u.prices.push(ph.purchase_price);
        if (ph.price_date === priceDate) u.todayPrice = ph.purchase_price;
      }
    }

    // 6) 월별 매출 — 현재월(UI) + 최근 3개월(Layer 2) + 직전 3개월(Layer 2)
    const monthStr = priceDate.slice(0, 7) + "-01";
    const priceDateObj = new Date(priceDate);
    const recentMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
    const prevMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1);
    const prevMonthEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);

    type SalesQtyRow = { product_code: string; sale_month: string; quantity: number; source: string | null };
    const monthlySales = await fetchAll<SalesQtyRow>(
      "monthly_sales_quantity", "product_code,sale_month,quantity,source",
      (q) => q.gte("sale_month", prevMonthStart.toISOString().slice(0, 10))
    );

    const salesQtyMap = new Map<string, number>();  // 현재월 UI용
    const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
    const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
    const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);

    for (const ms of monthlySales) {
      if (ms.source && ms.source !== "전체") continue;
      const entry = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };

      if (ms.sale_month === monthStr) {
        salesQtyMap.set(ms.product_code, ms.quantity);
      }
      if (ms.sale_month >= recentStartStr) {
        if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
        recentSalesMap.get(ms.product_code)!.push(entry);
      } else if (ms.sale_month >= prevStartStr && ms.sale_month < prevEndStr) {
        if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
        prevSalesMap.get(ms.product_code)!.push(entry);
      }
    }

    // 7) 결과 조합
    let results = mgmtData.map((row) => {
      const prod = productMap.get(row.product_code);
      const selling = sellingMap.get(row.product_code);
      const ph = purchaseMap.get(row.product_code);
      const monthlyQty = salesQtyMap.get(row.product_code) || null;

      const purchasePrice = row.purchase_price || 0;
      const prevPurchase = row.prev_purchase_price || 0;

      // 변동률/변동액
      const changeAmount = prevPurchase > 0 ? purchasePrice - prevPurchase : 0;
      const changeRate = prevPurchase > 0 ? changeAmount / prevPurchase : 0;

      // 플랫폼 판매가 (product_selling_prices에서)
      const platformSellingPrice = selling?.selling_price || 0;
      const prevPlatformSellingPrice = selling?.prev_selling_price || null;

      // 수익률 = 1 - (매입가 / 판매가)
      const marginRate = platformSellingPrice > 0 ? 1 - purchasePrice / platformSellingPrice : 0;

      // 7일 매입가
      const prices7d = ph?.prices || [];
      const maxPrice7d = prices7d.length > 0 ? Math.max(...prices7d) : null;
      const todayPurchase = ph?.todayPrice || null;

      // 수익률일괄변경용
      const targetMargin = prod?.target_margin_rate ? Number(prod.target_margin_rate) : null;
      // 수익률일괄변경시가격 = ROUNDUP(매입가 ÷ (1 - 목표수익률), -1)
      const targetPrice = targetMargin && targetMargin > 0 && purchasePrice > 0
        ? Math.ceil(purchasePrice / (1 - targetMargin / 100) / 10) * 10
        : null;

      // 신선행판매가 = MAX(식봄판매가 × 0.94, 매입가 ÷ 0.9)
      const sinsunhangPrice = platformSellingPrice > 0
        ? Math.ceil(Math.max(platformSellingPrice * 0.94, purchasePrice / 0.9) / 10) * 10
        : null;
      const sinsunhangMargin = sinsunhangPrice && sinsunhangPrice > 0
        ? 1 - purchasePrice / sinsunhangPrice : null;

      // 배민판매가 = 식봄판매가
      const baeminPrice = platformSellingPrice || null;
      const baeminMargin = baeminPrice && baeminPrice > 0
        ? 1 - purchasePrice / baeminPrice : null;

      // 야채/공산 구분
      const productType = prod?.product_type || "공산";

      // Claude 추천판매가 — Phase 1~4 통합 로직 사용 (학습 세션과 동일)
      let recommendedPrice: number | null = null;
      let recommendReason = "";
      if (purchasePrice > 0 && platformSellingPrice > 0) {
        const aiInput: AiRecInput = {
          purchase_price: purchasePrice,
          prev_purchase_price: prevPurchase,
          current_selling_price: platformSellingPrice,
          prev_selling_price: prevPlatformSellingPrice || 0,
          target_margin_rate: targetMargin,
          is_key_item: prod?.is_key_item || false,
          price_sensitivity: (prod?.price_sensitivity as "예민" | "고정" | "일반" | null) || "일반",
          short_history: shortHistoryMap.get(row.product_code) || [],
          long_history: longHistoryMap.get(row.product_code) || [],
          monthly_sales: recentSalesMap.get(row.product_code) || [],
          prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
          group_trend: null, // Phase 5에서 구현
        };
        const ai = calculateAiRecommendation(aiInput);
        recommendedPrice = ai.ai_price;
        recommendReason = extractShortReason(ai.ai_reason);
      }
      const recommendedMargin = recommendedPrice && purchasePrice > 0
        ? 1 - purchasePrice / recommendedPrice : null;

      return {
        product_code: row.product_code,
        product_name: row.product_name,
        spec: row.spec,
        unit: row.unit,
        category_name: row.category_name,
        price_date: row.price_date,
        product_type: productType,

        product_group: prod?.product_group || null,
        is_key_item: prod?.is_key_item || false,
        is_event_item: prod?.is_event_item || false,
        target_margin_rate: targetMargin,

        prev_purchase_price: row.prev_purchase_price,
        purchase_price: row.purchase_price,
        change_amount: changeAmount,
        change_rate: changeRate,

        purchase_prices_7d: prices7d,
        max_price_7d: maxPrice7d,
        today_purchase: todayPurchase,

        prev_selling_price: prevPlatformSellingPrice,
        selling_price: platformSellingPrice,
        margin_rate: marginRate,

        target_price: targetPrice,

        recommended_price: recommendedPrice,
        recommended_margin: recommendedMargin,
        recommend_reason: recommendReason,

        sinsunhang_price: sinsunhangPrice,
        sinsunhang_margin: sinsunhangMargin,
        baemin_price: baeminPrice,
        baemin_margin: baeminMargin,

        monthly_qty: monthlyQty,
        month_1_qty: selling?.month_1_qty || null,
        month_2_qty: selling?.month_2_qty || null,
        month_3_qty: selling?.month_3_qty || null,
        current_month_qty: selling?.current_month_qty || null,
        prev_3month_pct: selling?.prev_3month_pct || null,
      };
    });

    // 필터
    if (category && category !== "전체") {
      results = results.filter((r) => r.category_name === category);
    }
    if (group) {
      results = results.filter((r) => r.product_group === Number(group));
    }

    return Response.json(results);
  } catch (err: unknown) {
    console.error("Products API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: `처리 중 오류: ${message}` }, { status: 500 });
  }
}
