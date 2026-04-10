import { supabase } from "@/lib/supabase";

interface UpdateItem {
  product_code: string;
  selling_price: number;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { updates, price_date } = body as {
      updates: UpdateItem[];
      price_date: string;
    };

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return Response.json(
        { success: false, error: "updates 배열이 비어있습니다." },
        { status: 400 }
      );
    }

    if (!price_date) {
      return Response.json(
        { success: false, error: "price_date는 필수입니다." },
        { status: 400 }
      );
    }

    const results: { product_code: string; selling_price: number; success: boolean; error?: string }[] = [];

    for (const item of updates) {
      const { product_code, selling_price } = item;

      if (!product_code || selling_price == null) {
        results.push({
          product_code: product_code ?? "unknown",
          selling_price: selling_price ?? 0,
          success: false,
          error: "product_code와 selling_price는 필수입니다.",
        });
        continue;
      }

      // 기존 동일 product_code + price_date 레코드 삭제
      const { error: deleteError } = await supabase
        .from("daily_selling_prices")
        .delete()
        .eq("product_code", product_code)
        .eq("price_date", price_date);

      if (deleteError) {
        results.push({
          product_code,
          selling_price,
          success: false,
          error: `삭제 오류: ${deleteError.message}`,
        });
        continue;
      }

      // 새 레코드 삽입
      const { error: insertError } = await supabase
        .from("daily_selling_prices")
        .insert({
          product_code,
          price_date,
          selling_price,
        });

      if (insertError) {
        results.push({
          product_code,
          selling_price,
          success: false,
          error: `삽입 오류: ${insertError.message}`,
        });
        continue;
      }

      results.push({ product_code, selling_price, success: true });
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return Response.json({
      success: failCount === 0,
      total: updates.length,
      success_count: successCount,
      fail_count: failCount,
      results,
    });
  } catch (err: unknown) {
    console.error("Batch update API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
