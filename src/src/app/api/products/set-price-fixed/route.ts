// 판매가 고정 등록/해제
// POST { codes: string[], fixed: boolean }
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const codes: string[] = Array.isArray(body?.codes) ? body.codes : [];
    const fixed: boolean = !!body?.fixed;
    if (codes.length === 0) {
      return Response.json({ success: false, error: "코드가 비어있습니다." }, { status: 400 });
    }
    const BATCH = 100;
    let updated = 0;
    for (let i = 0; i < codes.length; i += BATCH) {
      const batch = codes.slice(i, i + BATCH);
      const { error } = await supabase
        .from("products")
        .update({ price_fixed: fixed })
        .in("product_code", batch);
      if (error) return Response.json({ success: false, error: error.message }, { status: 500 });
      updated += batch.length;
    }
    return Response.json({ success: true, updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
