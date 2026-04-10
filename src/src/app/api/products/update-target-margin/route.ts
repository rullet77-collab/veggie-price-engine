import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { product_code, target_margin_rate } = body;

    if (!product_code || target_margin_rate == null) {
      return Response.json({ success: false, error: "product_code와 target_margin_rate 필요" }, { status: 400 });
    }

    const rate = Number(target_margin_rate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return Response.json({ success: false, error: "유효하지 않은 수익률 (0~100)" }, { status: 400 });
    }

    const { error } = await supabase
      .from("products")
      .update({ target_margin_rate: rate, updated_at: new Date().toISOString() })
      .eq("product_code", product_code);

    if (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, product_code, target_margin_rate: rate });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
