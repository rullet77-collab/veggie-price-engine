import { supabase } from "@/lib/supabase";
import { generateAiCommentOnUser } from "@/lib/learnAi";

// POST: 학습 아이템의 사용자 입력 저장
// user_reason 이 변경되면 서버가 ai_comment_on_user 를 자동 생성하여 함께 저장
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { session_date, product_code, user_reason, user_comment_on_ai, ai_comment_on_user } = body;

    if (!session_date || !product_code) {
      return Response.json({ success: false, error: "session_date와 product_code 필요" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    let generatedAiComment: string | null = null;

    // user_reason 이 포함되면 AI 답글 자동 생성
    if (user_reason !== undefined) {
      updateData.user_reason = user_reason;

      if (user_reason && user_reason.trim()) {
        // 현재 학습 아이템 로드
        const { data: itemRow } = await supabase
          .from("learning_items")
          .select(
            "product_name,category_name,purchase_price,prev_purchase_price,prev_selling_price,user_price,ai_price,target_margin_rate,purchase_history,is_key_item"
          )
          .eq("session_date", session_date)
          .eq("product_code", product_code)
          .single();

        if (itemRow) {
          generatedAiComment = generateAiCommentOnUser(
            {
              product_name: itemRow.product_name,
              category_name: itemRow.category_name,
              purchase_price: itemRow.purchase_price || 0,
              prev_purchase_price: itemRow.prev_purchase_price || 0,
              prev_selling_price: itemRow.prev_selling_price || 0,
              user_price: itemRow.user_price || 0,
              ai_price: itemRow.ai_price || 0,
              target_margin_rate: itemRow.target_margin_rate,
              purchase_history: itemRow.purchase_history || [],
              is_key_item: itemRow.is_key_item || false,
            },
            user_reason
          );
          updateData.ai_comment_on_user = generatedAiComment;
        }
      } else {
        // 빈 근거면 AI 답글도 비움
        updateData.ai_comment_on_user = "";
        generatedAiComment = "";
      }
    }

    if (user_comment_on_ai !== undefined) updateData.user_comment_on_ai = user_comment_on_ai;
    // 클라이언트가 직접 ai_comment_on_user 를 보낸 경우 (예: 재생성 버튼) 덮어쓰기
    if (ai_comment_on_user !== undefined) {
      updateData.ai_comment_on_user = ai_comment_on_user;
      generatedAiComment = ai_comment_on_user;
    }

    const { error } = await supabase
      .from("learning_items")
      .update(updateData)
      .eq("session_date", session_date)
      .eq("product_code", product_code);

    if (error) {
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    return Response.json({ success: true, ai_comment_on_user: generatedAiComment });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
