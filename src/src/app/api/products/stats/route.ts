// 야채/공산 별 판매중·판매중지 카운트 — 가벼운 endpoint
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("product_type,platform_status,price_fixed");
    if (error) throw error;

    const result = {
      야채: { active: 0, inactive: 0, fixed: 0, total: 0 },
      공산: { active: 0, inactive: 0, fixed: 0, total: 0 },
    } as Record<string, { active: number; inactive: number; fixed: number; total: number }>;

    for (const r of (data || []) as { product_type: string | null; platform_status: string | null; price_fixed: boolean | null }[]) {
      const t = r.product_type === "야채" ? "야채" : "공산";
      result[t].total++;
      if (r.platform_status === "판매중지") {
        result[t].inactive++;
      } else {
        result[t].active++;
        if (r.price_fixed) result[t].fixed++;
      }
    }
    return Response.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
