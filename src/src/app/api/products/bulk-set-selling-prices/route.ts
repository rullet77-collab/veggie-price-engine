// 다수 상품 selling_price 일괄 set (실행 취소용 — entries 의 prev_selling_price 로 복원)
// POST { entries: [{ product_code, prev_selling_price }] }
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export const dynamic = "force-dynamic";

type Entry = { product_code: string; prev_selling_price: number | null };

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const entries: Entry[] = Array.isArray(body?.entries) ? body.entries : [];
    if (entries.length === 0) {
      return Response.json({ success: false, error: "entries 가 비어있습니다." }, { status: 400 });
    }

    // 코드별로 selling_price 를 prev_selling_price 값으로 복원
    // (null 이면 NULL 로 — 추천가 자동 적용 모드로 회귀)
    let updated = 0;
    for (const e of entries) {
      const { error } = await supabase
        .from("product_selling_prices")
        .update({ selling_price: e.prev_selling_price, updated_at: new Date().toISOString() })
        .eq("product_code", e.product_code);
      if (!error) updated++;
    }
    return Response.json({ success: true, updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
