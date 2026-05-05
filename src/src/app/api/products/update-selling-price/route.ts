import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { product_code, selling_price } = body;

    if (!product_code) {
      return Response.json({ success: false, error: "product_code 필요" }, { status: 400 });
    }

    // selling_price === null → 사용자가 수동 가격 비움 (추천가 자동 적용 모드)
    let price: number | null = null;
    if (selling_price !== null && selling_price !== undefined && selling_price !== "") {
      const n = Math.round(Number(selling_price));
      if (isNaN(n) || n < 0) {
        return Response.json({ success: false, error: "유효하지 않은 가격" }, { status: 400 });
      }
      price = n;
    }

    // upsert (prev 는 매입 업로드 hook 에서 자동 롤오버되므로 여기선 건드리지 않음)
    const { error } = await supabase
      .from("product_selling_prices")
      .upsert({
        product_code,
        selling_price: price,
        updated_at: new Date().toISOString(),
      }, { onConflict: "product_code" });

    if (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, product_code, selling_price: price });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
