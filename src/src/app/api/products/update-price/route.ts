import { supabase } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { product_code, price_date, selling_price, adjustment_reason } = body;

    if (!product_code || !price_date || selling_price == null) {
      return Response.json(
        { success: false, error: "product_code, price_date, selling_price는 필수입니다." },
        { status: 400 }
      );
    }

    // 유효한 상품코드인지 확인
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("product_code, product_name")
      .eq("product_code", product_code)
      .single();

    if (productError || !product) {
      return Response.json(
        { success: false, error: `상품코드 ${product_code}을(를) 찾을 수 없습니다.` },
        { status: 404 }
      );
    }

    // 기존 동일 product_code + price_date 레코드 삭제 후 새로 삽입
    // (unique constraint가 product_code, price_date, selling_price 3개 컬럼이라
    //  같은 날짜에 다른 가격이 있을 수 있으므로 삭제 후 삽입)
    const { error: deleteError } = await supabase
      .from("daily_selling_prices")
      .delete()
      .eq("product_code", product_code)
      .eq("price_date", price_date);

    if (deleteError) {
      console.error("Delete error:", deleteError);
      return Response.json(
        { success: false, error: `기존 데이터 삭제 오류: ${deleteError.message}` },
        { status: 500 }
      );
    }

    const { error: insertError } = await supabase
      .from("daily_selling_prices")
      .insert({
        product_code,
        price_date,
        selling_price,
      });

    if (insertError) {
      console.error("Insert error:", insertError);
      return Response.json(
        { success: false, error: `판매가 저장 오류: ${insertError.message}` },
        { status: 500 }
      );
    }

    console.log(
      `판매가 확정: ${product_code} (${product.product_name}) = ${selling_price}원 [${price_date}] 사유: ${adjustment_reason ?? "없음"}`
    );

    return Response.json({
      success: true,
      product_code,
      selling_price,
    });
  } catch (err: unknown) {
    console.error("Update price API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
