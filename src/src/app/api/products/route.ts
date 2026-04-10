import { supabase } from "@/lib/supabase";

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
    };
    const productsData = await fetchAll<ProdRow>(
      "products",
      "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type"
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

    // 5) 7일 매입가
    const sevenDaysAgo = new Date(priceDate);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    type PurchRow = { product_code: string; price_date: string; purchase_price: number };
    const purchaseHistory = await fetchAll<PurchRow>(
      "daily_purchase_prices",
      "product_code,price_date,purchase_price",
      (q) => q.gte("price_date", sevenDaysAgo.toISOString().slice(0, 10)).lte("price_date", priceDate).order("price_date", { ascending: true })
    );
    const purchaseMap = new Map<string, { prices: number[]; todayPrice: number | null }>();
    for (const ph of purchaseHistory) {
      if (!purchaseMap.has(ph.product_code)) purchaseMap.set(ph.product_code, { prices: [], todayPrice: null });
      const entry = purchaseMap.get(ph.product_code)!;
      entry.prices.push(ph.purchase_price);
      if (ph.price_date === priceDate) entry.todayPrice = ph.purchase_price;
    }

    // 6) 월별매출수량
    const monthStr = priceDate.slice(0, 7) + "-01";
    type SalesQtyRow = { product_code: string; quantity: number };
    const monthlySales = await fetchAll<SalesQtyRow>(
      "monthly_sales_quantity", "product_code,quantity",
      (q) => q.eq("sale_month", monthStr)
    );
    const salesQtyMap = new Map<string, number>();
    for (const ms of monthlySales) salesQtyMap.set(ms.product_code, ms.quantity);

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

      // Claude 추천판매가
      let recommendedPrice: number | null = null;
      let recommendReason = "";
      if (purchasePrice > 0 && platformSellingPrice > 0) {
        const effMargin = targetMargin ? targetMargin / 100 : 0.20;
        const basePrice = Math.ceil(purchasePrice / (1 - effMargin) / 10) * 10;

        if (changeAmount > 0) {
          const adjusted = Math.ceil((platformSellingPrice + changeAmount) / 10) * 10;
          recommendedPrice = Math.max(adjusted, basePrice);
          recommendReason = "매입↑";
        } else if (changeAmount < 0 && prices7d.length >= 3) {
          const recent3 = prices7d.slice(-3);
          if (recent3[recent3.length - 1] - recent3[0] < 0) {
            const adjusted = Math.ceil((platformSellingPrice + Math.floor(changeAmount * 0.5)) / 10) * 10;
            recommendedPrice = Math.max(adjusted, basePrice);
            recommendReason = "하락추세";
          } else {
            recommendedPrice = platformSellingPrice;
            recommendReason = "관망";
          }
        } else if (changeAmount < 0) {
          recommendedPrice = platformSellingPrice;
          recommendReason = "유지";
        } else {
          if (marginRate < 0.10 && marginRate > 0) {
            recommendedPrice = basePrice;
            recommendReason = "저수익";
          } else {
            recommendedPrice = platformSellingPrice;
            recommendReason = "유지";
          }
        }
        const minPrice = Math.ceil(purchasePrice * 1.05 / 10) * 10;
        if (recommendedPrice && recommendedPrice < minPrice) {
          recommendedPrice = minPrice;
          recommendReason = "최소마진";
        }
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
