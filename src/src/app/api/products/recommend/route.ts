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

    // 상품 정보 조회 (target_margin_rate 필요)
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("product_code, product_name, target_margin_rate, parent_product_code, is_event_item")
      .eq("product_code", productCode)
      .single();

    if (productError || !product) {
      return Response.json(
        { success: false, error: `상품코드 ${productCode}을(를) 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    // 매입가 조회할 상품코드 결정 (소분상품이면 원물 코드 사용)
    const purchaseCode = product.parent_product_code || productCode;

    // 가장 최근 매입가 조회 (date 이전 또는 전체에서 가장 최근)
    let query = supabase
      .from("daily_purchase_prices")
      .select("purchase_price, price_date")
      .eq("product_code", purchaseCode)
      .order("price_date", { ascending: false })
      .limit(1);

    if (date) {
      query = query.lte("price_date", date);
    }

    const { data: purchaseData, error: purchaseError } = await query;

    if (purchaseError) {
      return Response.json(
        { success: false, error: `매입가 조회 오류: ${purchaseError.message}` },
        { status: 500 }
      );
    }

    if (!purchaseData || purchaseData.length === 0) {
      return Response.json(
        {
          success: false,
          error: `${purchaseCode} 상품의 매입 이력이 없습니다.`,
        },
        { status: 404 }
      );
    }

    const basePurchasePrice = purchaseData[0].purchase_price;
    const targetMarginRate = product.target_margin_rate ?? 20; // 기본 20%

    // 추천가 산출: CEIL(매입가 / (1 - target_margin_rate/100) / 10) * 10
    // = 10원 단위 올림
    const rawPrice = basePurchasePrice / (1 - targetMarginRate / 100);
    const recommendedSikbomPrice = Math.ceil(rawPrice / 10) * 10;

    // 신선행가: MAX(식봄가 * 0.94, 매입가 / 0.9)
    const sinsunOption1 = Math.ceil((recommendedSikbomPrice * 0.94) / 10) * 10;
    const sinsunOption2 = Math.ceil((basePurchasePrice / 0.9) / 10) * 10;
    const recommendedSinsunPrice = Math.max(sinsunOption1, sinsunOption2);

    // 배민가 = 식봄가 (동일)
    const recommendedBaeminPrice = recommendedSikbomPrice;

    return Response.json({
      success: true,
      product_code: productCode,
      product_name: product.product_name,
      purchase_product_code: purchaseCode !== productCode ? purchaseCode : undefined,
      base_purchase_price: basePurchasePrice,
      purchase_date: purchaseData[0].price_date,
      target_margin_rate: targetMarginRate,
      recommended_sikbom_price: recommendedSikbomPrice,
      recommended_sinsun_price: recommendedSinsunPrice,
      recommended_baemin_price: recommendedBaeminPrice,
      is_event_item: product.is_event_item,
      event_normal_price: product.is_event_item
        ? Math.ceil((recommendedSikbomPrice * 1.25) / 10) * 10
        : undefined,
    });
  } catch (err: unknown) {
    console.error("Recommend API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
