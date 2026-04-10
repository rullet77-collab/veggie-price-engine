import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    const { data, error } = await supabase.rpc(
      "get_products_with_latest_prices"
    );

    if (error) {
      return Response.json(
        { success: false, error: `DB 조회 오류: ${error.message}` },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      return Response.json(
        { success: false, error: "상품 데이터가 없습니다." },
        { status: 404 }
      );
    }

    // 신선행 판매가 = MAX(식봄가 × 0.94, 매입가 ÷ 0.9)
    const items = data
      .filter(
        (p: Record<string, unknown>) => p.latest_selling_price != null
      )
      .map((p: Record<string, unknown>) => {
        const sikbomPrice = Number(p.latest_selling_price);
        const purchasePrice = p.latest_purchase_price
          ? Number(p.latest_purchase_price)
          : null;

        const fromSikbom = Math.ceil((sikbomPrice * 0.94) / 10) * 10;
        const fromPurchase =
          purchasePrice != null
            ? Math.ceil(purchasePrice / 0.9 / 10) * 10
            : 0;
        const sinsunPrice = Math.max(fromSikbom, fromPurchase);

        const sinsunMargin =
          purchasePrice != null && sinsunPrice > 0
            ? ((1 - purchasePrice / sinsunPrice) * 100).toFixed(1)
            : null;

        return {
          product_code: p.product_code,
          product_name: p.product_name,
          sikbom_price: sikbomPrice,
          purchase_price: purchasePrice,
          sinsun_price: sinsunPrice,
          sinsun_margin_rate: sinsunMargin,
          price_source:
            fromPurchase > fromSikbom ? "매입가기준(10%하한)" : "식봄할인(6%)",
        };
      });

    return Response.json({
      success: true,
      date: new Date().toISOString().slice(0, 10),
      total_count: items.length,
      items,
    });
  } catch (err: unknown) {
    console.error("Sinsunhang API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
