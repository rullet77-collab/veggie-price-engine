import { supabase } from "@/lib/supabase";

// GET /api/learn/history
// 모든 학습 세션 목록 + 세션별 요약 통계
export async function GET() {
  try {
    // 모든 세션 조회
    const { data: sessions, error: sErr } = await supabase
      .from("learning_sessions")
      .select("session_date, created_at, updated_at")
      .order("session_date", { ascending: false });

    if (sErr) throw sErr;
    if (!sessions || sessions.length === 0) {
      return Response.json({ sessions: [], stats: emptyStats() });
    }

    // 모든 아이템 조회
    const { data: items, error: iErr } = await supabase
      .from("learning_items")
      .select("session_date, product_code, product_name, category_name, user_price, ai_price, user_reason, user_comment_on_ai, ai_comment_on_user");

    if (iErr) throw iErr;

    // 세션별 집계
    const byDate = new Map<string, typeof items>();
    for (const it of items || []) {
      if (!byDate.has(it.session_date)) byDate.set(it.session_date, []);
      byDate.get(it.session_date)!.push(it);
    }

    const sessionSummaries = sessions.map((s) => {
      const its = byDate.get(s.session_date) || [];
      const total = its.length;
      const matched = its.filter((i) => i.user_price === i.ai_price).length;
      const userHigher = its.filter((i) => i.user_price > i.ai_price).length;
      const aiHigher = its.filter((i) => i.ai_price > i.user_price).length;
      const userReasonFilled = its.filter((i) => i.user_reason && i.user_reason.trim()).length;
      const aiCommentFilled = its.filter((i) => i.ai_comment_on_user && i.ai_comment_on_user.trim()).length;
      const matchRate = total > 0 ? matched / total : 0;
      return {
        session_date: s.session_date,
        total,
        matched,
        user_higher: userHigher,
        ai_higher: aiHigher,
        user_reason_filled: userReasonFilled,
        ai_comment_filled: aiCommentFilled,
        match_rate: matchRate,
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    });

    // 전체 누적 통계
    const allItems = items || [];
    const totalItems = allItems.length;
    const totalMatched = allItems.filter((i) => i.user_price === i.ai_price).length;
    const totalUserHigher = allItems.filter((i) => i.user_price > i.ai_price).length;
    const totalAiHigher = allItems.filter((i) => i.ai_price > i.user_price).length;

    // 사용자 판단 근거 키워드 집계
    const userKeywords = extractKeywords(allItems.map((i) => i.user_reason || ""));

    const stats = {
      total_sessions: sessions.length,
      total_items: totalItems,
      total_matched: totalMatched,
      total_user_higher: totalUserHigher,
      total_ai_higher: totalAiHigher,
      overall_match_rate: totalItems > 0 ? totalMatched / totalItems : 0,
      top_user_keywords: userKeywords,
    };

    return Response.json({ sessions: sessionSummaries, stats });
  } catch (err: unknown) {
    console.error("Learn history error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ error: message }, { status: 500 });
  }
}

function emptyStats() {
  return {
    total_sessions: 0,
    total_items: 0,
    total_matched: 0,
    total_user_higher: 0,
    total_ai_higher: 0,
    overall_match_rate: 0,
    top_user_keywords: [],
  };
}

// 사용자 판단 근거에서 의미있는 키워드 추출 (빈도 상위 N개)
function extractKeywords(texts: string[]): { keyword: string; count: number }[] {
  const keywords = [
    "지지선", "저항선", "박스권", "매출량", "매출수량", "판매량",
    "변곡점", "관망", "추세", "상승", "하락", "횡보", "소폭",
    "경쟁", "마진", "수익률", "목표", "원물", "그룹", "동조",
    "반등", "이탈", "유지", "인상", "인하", "조정", "보합",
    "행사", "재고", "소진", "계절",
  ];
  const counts = new Map<string, number>();
  for (const t of texts) {
    for (const kw of keywords) {
      if (t.includes(kw)) {
        counts.set(kw, (counts.get(kw) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
