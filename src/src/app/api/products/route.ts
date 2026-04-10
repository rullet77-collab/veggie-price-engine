import { supabase } from "@/lib/supabase";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const search = url.searchParams.get("search");
    const group = url.searchParams.get("group");

    // Supabase RPC: 단일 SQL 함수로 상품 + 최근 매입가/판매가 한번에 조회
    const { data, error } = await supabase.rpc(
      "get_products_with_latest_prices"
    );

    if (error) {
      console.error("Supabase RPC error:", error);
      return Response.json(
        { success: false, error: `DB 조회 오류: ${error.message}` },
        { status: 500 }
      );
    }

    let results = data ?? [];

    // 카테고리 필터
    if (category) {
      results = results.filter(
        (row: Record<string, unknown>) => row.category_name === category
      );
    }

    // 상품명/코드 검색
    if (search) {
      const keyword = search.toLowerCase();
      results = results.filter((row: Record<string, unknown>) => {
        const name = String(row.product_name ?? "").toLowerCase();
        const code = String(row.product_code ?? "").toLowerCase();
        return name.includes(keyword) || code.includes(keyword);
      });
    }

    // 상품그룹 필터
    if (group) {
      const groupNum = Number(group);
      results = results.filter(
        (row: Record<string, unknown>) => row.product_group === groupNum
      );
    }

    return Response.json(results);
  } catch (err: unknown) {
    console.error("Products API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
