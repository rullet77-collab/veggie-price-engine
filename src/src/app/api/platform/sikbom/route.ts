import { supabase } from "@/lib/supabase";
import * as XLSX from "xlsx";

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

    // 식봄 엑셀 데이터 구성
    const rows = data
      .filter(
        (p: Record<string, unknown>) => p.latest_selling_price != null
      )
      .map((p: Record<string, unknown>) => {
        const sellingPrice = Number(p.latest_selling_price);
        const isEvent = Boolean(p.is_event_item);
        const normalPrice = isEvent
          ? Math.ceil((sellingPrice * 1.25) / 10) * 10
          : sellingPrice;

        return {
          상품코드: p.product_code,
          상품명: p.product_name,
          규격: p.spec ?? "",
          판매가: sellingPrice,
          정상가: normalPrice,
          행사여부: isEvent ? "Y" : "N",
          대분류: p.category_name ?? "",
        };
      });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    // 컬럼 너비 설정
    ws["!cols"] = [
      { wch: 10 }, // 상품코드
      { wch: 30 }, // 상품명
      { wch: 15 }, // 규격
      { wch: 12 }, // 판매가
      { wch: 12 }, // 정상가
      { wch: 8 },  // 행사여부
      { wch: 15 }, // 대분류
    ];

    XLSX.utils.book_append_sheet(wb, ws, "식봄");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const today = new Date().toISOString().slice(0, 10);
    return new Response(buffer, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="sikbom_upload_${today}.xlsx"`,
      },
    });
  } catch (err: unknown) {
    console.error("Sikbom Excel API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
