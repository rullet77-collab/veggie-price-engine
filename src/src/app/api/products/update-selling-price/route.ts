import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { product_code, selling_price } = body;

    if (!product_code || selling_price == null) {
      return Response.json({ success: false, error: "product_code와 selling_price 필요" }, { status: 400 });
    }

    const price = Math.round(Number(selling_price));
    if (isNaN(price) || price < 0) {
      return Response.json({ success: false, error: "유효하지 않은 가격" }, { status: 400 });
    }

    // 기존 가격 조회
    const { data: existing } = await supabase
      .from("product_selling_prices")
      .select("selling_price")
      .eq("product_code", product_code)
      .single();

    const prevPrice = existing?.selling_price || null;

    // upsert
    const { error } = await supabase
      .from("product_selling_prices")
      .upsert({
        product_code,
        selling_price: price,
        prev_selling_price: prevPrice,
        updated_at: new Date().toISOString(),
      }, { onConflict: "product_code" });

    if (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, product_code, selling_price: price, prev_selling_price: prevPrice });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
