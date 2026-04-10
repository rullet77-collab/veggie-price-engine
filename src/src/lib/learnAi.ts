// 학습 AI 로직: 사용자 판단 근거에 대한 AI 답글 생성
// 서버(API Route)에서 호출하여 learning_items.ai_comment_on_user 에 저장

type LearnItemForComment = {
  product_name: string | null;
  category_name: string | null;
  purchase_price: number;
  prev_purchase_price: number;
  prev_selling_price: number;
  user_price: number;
  ai_price: number;
  target_margin_rate: number | null;
  purchase_history: { date: string; price: number }[];
  is_key_item: boolean;
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * 사용자의 판단 근거 (user_reason) 를 읽고
 * AI 관점에서 수긍/반박/보완 코멘트를 생성한다.
 *
 * 규칙:
 * 1. 가격 차이 분석 → 어느 쪽이 높은지, 수익률 적정성
 * 2. 사용자 키워드 감지 → 지지선/매출량/경쟁/관망 등
 * 3. 사용자 근거에 빠진 요소 지적 (매출량 미언급, 지지선 미언급 등)
 * 4. 공손하되 구체적으로: "~한 부분도 함께 보시면 좋겠습니다" 식
 */
export function generateAiCommentOnUser(
  item: LearnItemForComment,
  userReason: string
): string {
  const reason = userReason.trim();
  if (!reason) return "";

  const reasonLower = reason.toLowerCase();
  const comments: string[] = [];

  // ── 1) 가격 차이 ──
  const diff = item.user_price - item.ai_price;
  const absDiff = Math.abs(diff);
  const diffPct = item.ai_price > 0 ? absDiff / item.ai_price : 0;

  if (diff === 0 || diffPct < 0.01) {
    comments.push("AI 추천가와 거의 일치합니다. 판단 방향이 같습니다.");
  } else if (diff > 0) {
    comments.push(`AI보다 ${fmt(diff)}원 높게 책정하셨습니다.`);
    if (item.user_price > 0 && item.purchase_price > 0) {
      const userMargin = 1 - item.purchase_price / item.user_price;
      if (userMargin > 0.3) {
        comments.push(
          `수익률 ${(userMargin * 100).toFixed(1)}%로 넉넉한 마진이지만, 경쟁사 대비 가격 경쟁력을 확인해보세요.`
        );
      }
    }
  } else {
    comments.push(`AI보다 ${fmt(absDiff)}원 낮게 책정하셨습니다.`);
    if (item.user_price > 0 && item.purchase_price > 0) {
      const userMargin = 1 - item.purchase_price / item.user_price;
      if (userMargin < 0.15) {
        comments.push(
          `수익률 ${(userMargin * 100).toFixed(1)}%로 15% 미만입니다. 매입가 추가 하락이 없으면 마진 압박이 우려됩니다.`
        );
      } else if (userMargin < 0.2 && item.is_key_item) {
        comments.push(
          `주요 경쟁품목이라 판매량 확대 목적의 인하는 합리적입니다. 다만 수익률 ${(userMargin * 100).toFixed(1)}%는 목표(${item.target_margin_rate ?? 20}%)보다 낮으니 경쟁 상황이 완화되면 복귀를 검토하세요.`
        );
      }
    }
  }

  // ── 2) 매입 추세 재확인 ──
  const purchChange =
    item.prev_purchase_price > 0
      ? (item.purchase_price - item.prev_purchase_price) / item.prev_purchase_price
      : 0;

  // ── 3) 사용자 키워드 감지 ──
  const hasMentioned = {
    support: /지지선|지지|저항선|저항/.test(reason),
    salesVolume: /매출량|매출수량|판매량|매출증감|증감률/.test(reason),
    trend: /상승|하락|횡보|추세|상향|하향|보합/.test(reason),
    inflection: /변곡|반등|전환|이탈|돌파/.test(reason),
    competition: /경쟁|시장|타업체|타판매/.test(reason),
    margin: /수익률|마진|목표/.test(reason),
    group: /원물|그룹|동조|소분/.test(reason),
    wait: /관망|지켜|대기|보류/.test(reason),
    box: /박스권|박스|횡보/.test(reason),
  };

  // 사용자가 관망했는데 매입이 오르고 있으면 경고
  if (hasMentioned.wait && purchChange > 0.03) {
    comments.push(
      `매입가가 ${(purchChange * 100).toFixed(1)}% 상승 중입니다. 관망이 길어지면 마진 축소 위험이 있으니 상승이 이어지면 선제 대응을 권합니다.`
    );
  }

  // 매출량 언급 — 좋음
  if (hasMentioned.salesVolume) {
    comments.push(
      "매출량 기반 판단은 핵심 신호입니다. 가격 변경과 매출량 변화의 시차(1~2일)도 함께 관찰하세요."
    );
  } else {
    // 매출량 미언급 — 지적
    comments.push(
      "근거에 매출량 변화가 빠져 있습니다. 가격 인하/인상의 탄력성을 판단하려면 직전 기간 대비 매출량 증감을 함께 보시는 게 좋습니다."
    );
  }

  // 지지선 언급 — 좋음
  if (hasMentioned.support) {
    comments.push("지지선 기반 판단은 장기 가격대 고정에 유리합니다.");
  }

  // 박스권 언급
  if (hasMentioned.box) {
    comments.push("박스권 인식은 횡보 시장에서 안정적인 접근입니다.");
  }

  // 경쟁사 언급 — 주요 품목이면 특히 강조
  if (hasMentioned.competition && item.is_key_item) {
    comments.push("주요 경쟁품목이라 경쟁사 가격 고려가 중요합니다. 정확한 판단입니다.");
  }

  // 원물/그룹 언급
  if (hasMentioned.group) {
    comments.push("원물 추세를 참고한 판단은 소분상품 가격 설정의 모범 사례입니다.");
  }

  // 목표 수익률 언급
  if (hasMentioned.margin) {
    comments.push("목표수익률 기준은 일관성 있는 가격 정책에 도움이 됩니다.");
  }

  // ── 4) 8일 데이터에서 단순 관찰 ──
  if (item.purchase_history && item.purchase_history.length >= 3) {
    const prices = item.purchase_history.map((h) => h.price).filter((p) => p > 0);
    if (prices.length >= 3) {
      const max = Math.max(...prices);
      const min = Math.min(...prices);
      const range = max > 0 ? (max - min) / max : 0;

      // 사용자가 박스권 언급 없이 가격 크게 조정 → 지적
      if (range < 0.05 && !hasMentioned.box && absDiff > item.ai_price * 0.03) {
        comments.push(
          `최근 8일 매입가 변동폭이 ${(range * 100).toFixed(1)}%로 좁은 박스권입니다. 큰 폭의 가격 조정은 신중해야 합니다.`
        );
      }
    }
  }

  if (comments.length === 0) {
    comments.push("판단 근거를 좀 더 구체적으로 작성하면, 향후 유사 상황에서 참고하기 좋습니다.");
  }

  return comments.join(" ");
}
