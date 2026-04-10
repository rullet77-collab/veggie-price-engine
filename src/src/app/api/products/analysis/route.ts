import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const productCode = url.searchParams.get("product_code");
    const date = url.searchParams.get("date");

    if (!productCode) {
      return Response.json(
        { success: false, error: "product_code 파라미터는 필수입니다." },
        { status: 400 }
      );
    }

    // 매입가 조회할 상품코드 결정 (소분상품이면 원물 코드 사용)
    const { data: product } = await supabase
      .from("products")
      .select("product_code, product_name, parent_product_code, target_margin_rate, is_event_item, category_name, product_group")
      .eq("product_code", productCode)
      .single();

    if (!product) {
      return Response.json(
        { success: false, error: `상품코드 ${productCode}을(를) 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    const purchaseCode = product.parent_product_code || productCode;

    // 분석 기준일 결정: date 파라미터 또는 최근 매입일
    let analysisDate = date;
    if (!analysisDate) {
      const { data: latestPurchase } = await supabase
        .from("daily_purchase_prices")
        .select("price_date")
        .eq("product_code", purchaseCode)
        .order("price_date", { ascending: false })
        .limit(1);

      if (latestPurchase && latestPurchase.length > 0) {
        analysisDate = latestPurchase[0].price_date;
      }
    }

    if (!analysisDate) {
      return Response.json({
        success: true,
        product_code: productCode,
        product_name: product.product_name,
        analysis: null,
        message: "매입 이력이 없어 분석할 수 없습니다.",
      });
    }

    // 5개 분석 함수를 병렬 호출
    const [trendResult, volatilityResult, weekStatsResult, strategyResult, salesResult] =
      await Promise.all([
        supabase.rpc("signal_trimmed_mean_trend", {
          p_product_code: purchaseCode,
          p_date: analysisDate,
        }),
        supabase.rpc("signal_volatility", {
          p_product_code: purchaseCode,
          p_date: analysisDate,
        }),
        supabase.rpc("signal_week_stats", {
          p_product_code: purchaseCode,
          p_date: analysisDate,
        }),
        supabase.rpc("strategy_score_policy", {
          p_product_code: purchaseCode,
          p_date: analysisDate,
        }),
        supabase.rpc("signal_sales_trend", {
          p_product_code: productCode,
          p_date: analysisDate,
        }),
      ]);

    // 최근 7일 매입가 조회
    const { data: recentPrices } = await supabase
      .from("daily_purchase_prices")
      .select("price_date, purchase_price")
      .eq("product_code", purchaseCode)
      .lte("price_date", analysisDate)
      .order("price_date", { ascending: false })
      .limit(8);

    const trend = trendResult.data?.[0] ?? trendResult.data ?? null;
    const volatility = volatilityResult.data?.[0] ?? volatilityResult.data ?? null;
    const weekStats = weekStatsResult.data?.[0] ?? weekStatsResult.data ?? null;
    const strategy = strategyResult.data?.[0] ?? strategyResult.data ?? null;
    const salesTrend = salesResult.data?.[0] ?? salesResult.data ?? null;

    return Response.json({
      success: true,
      product_code: productCode,
      product_name: product.product_name,
      purchase_code: purchaseCode !== productCode ? purchaseCode : undefined,
      category_name: product.category_name,
      target_margin_rate: product.target_margin_rate,
      analysis_date: analysisDate,
      analysis: {
        trend: {
          direction: trend?.trend ?? null,
          change_rate: trend?.change_rate != null ? Number(trend.change_rate) : null,
          base_price: trend?.base_price ?? null,
          trimmed_avg: trend?.trimmed_avg != null ? Number(trend.trimmed_avg) : null,
        },
        volatility: {
          level: volatility?.volatility_level ?? null,
          cv: volatility?.cv != null ? Number(volatility.cv) : null,
          data_days: volatility?.data_days ?? 0,
        },
        week_stats: {
          max: weekStats?.week_max ?? null,
          min: weekStats?.week_min ?? null,
          median: weekStats?.week_median != null ? Number(weekStats.week_median) : null,
          weighted_avg: weekStats?.week_weighted_avg != null ? Number(weekStats.week_weighted_avg) : null,
          range_rate: weekStats?.price_range_rate != null ? Number(weekStats.price_range_rate) : null,
        },
        strategy: {
          policy: strategy?.policy ?? null,
          total_score: strategy?.total_score ?? 0,
          margin_adjustment: strategy?.margin_adjustment != null ? Number(strategy.margin_adjustment) : 0,
          score_details: strategy?.score_details ?? [],
        },
        sales_trend: salesTrend,
        recent_prices: (recentPrices ?? []).reverse(),
      },
    });
  } catch (err: unknown) {
    console.error("Analysis API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
