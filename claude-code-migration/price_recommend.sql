-- ============================================================
-- price_recommend: 추천 판매가 산출 함수
-- 기획서 섹션 2.1 + 2.3 수식 구현
-- 생성일: 2026-04-01
-- ============================================================

CREATE OR REPLACE FUNCTION price_recommend(
  p_product_code VARCHAR(6),
  p_date DATE,
  p_policy VARCHAR DEFAULT '현상유지',
  p_margin_adjustment NUMERIC DEFAULT NULL
)
RETURNS TABLE(
  base_purchase_price INT,
  current_selling_price INT,
  current_margin_rate NUMERIC,
  target_margin_rate NUMERIC,
  adjusted_margin_rate NUMERIC,
  recommended_sikbom_price INT,
  recommended_baemin_price INT,
  recommended_sinsun_price INT,
  recommended_oniljang_price INT,
  normal_price INT,
  recommendation_reason TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
  v_base_purchase INT;
  v_current_selling INT;
  v_current_margin NUMERIC;
  v_target_margin NUMERIC;
  v_policy_adj NUMERIC;
  v_adjusted_margin NUMERIC;
  v_sikbom INT;
  v_sinsun INT;
  v_normal INT;
  v_is_event BOOLEAN;
  v_reason TEXT;
  v_emergency_price INT;
BEGIN
  -- ============================================================
  -- 1. 기준매입가 선정
  --    변곡점 가격이 있으면 신호해석층에서 p_margin_adjustment로 반영.
  --    여기서는 당일 매입가, 없으면 가장 최근 매입가를 사용.
  -- ============================================================
  SELECT purchase_price INTO v_base_purchase
  FROM daily_purchase_prices
  WHERE product_code = p_product_code AND price_date <= p_date
  ORDER BY price_date DESC LIMIT 1;

  IF v_base_purchase IS NULL THEN RETURN; END IF;

  -- ============================================================
  -- 2. 현재(전일) 판매가 조회
  -- ============================================================
  SELECT selling_price INTO v_current_selling
  FROM daily_selling_prices
  WHERE product_code = p_product_code AND price_date <= p_date
  ORDER BY price_date DESC LIMIT 1;

  -- 현재 수익률 = 1 - (매입가 / 판매가)
  IF v_current_selling IS NOT NULL AND v_current_selling > 0 THEN
    v_current_margin := ROUND((1.0 - v_base_purchase::NUMERIC / v_current_selling) * 100, 2);
  END IF;

  -- ============================================================
  -- 3. 목표수익률 결정
  --    products.target_margin_rate가 NULL이면 기본값 19.5%
  -- ============================================================
  SELECT COALESCE(p.target_margin_rate, 19.5), COALESCE(p.is_event_item, FALSE)
  INTO v_target_margin, v_is_event
  FROM products p WHERE p.product_code = p_product_code;

  IF v_target_margin IS NULL THEN v_target_margin := 19.5; END IF;

  -- ============================================================
  -- 4. 정책별 수익률 조정
  --    p_margin_adjustment가 주어지면 직접 사용, 아니면 정책명으로 매핑
  --    마진상향: +2%p, 소극적상향: +1%p, 현상유지: 0,
  --    소극적인하: -1%p, 점유율확대: -2%p, 공격적인하: -3%p
  -- ============================================================
  IF p_margin_adjustment IS NOT NULL THEN
    v_policy_adj := p_margin_adjustment;
  ELSE
    v_policy_adj := CASE p_policy
      WHEN '마진상향'   THEN  2.0
      WHEN '소극적상향' THEN  1.0
      WHEN '현상유지'   THEN  0.0
      WHEN '소극적인하' THEN -1.0
      WHEN '점유율확대' THEN -2.0
      WHEN '공격적인하' THEN -3.0
      ELSE 0.0
    END;
  END IF;

  -- 최소 수익률 하한선 10% 적용
  v_adjusted_margin := GREATEST(v_target_margin + v_policy_adj, 10.0);

  -- ============================================================
  -- 5. 식봄 추천판매가 = CEIL(매입가 / (1 - 수익률) / 10) * 10
  -- ============================================================
  v_sikbom := (CEIL(v_base_purchase / (1.0 - v_adjusted_margin / 100.0) / 10.0) * 10)::INT;
  v_reason := '정책: ' || p_policy || ' (수익률 조정 ' || v_policy_adj::TEXT || '%p)';

  -- ============================================================
  -- 6. 규칙 1: 긴급 일괄 조정
  --    현재 수익률이 19.5% 미만이면 수익률일괄변경가를 우선 적용
  --    일괄변경가 = CEIL(매입가 / (1 - 목표수익률) / 10) * 10
  -- ============================================================
  IF v_current_margin IS NOT NULL AND v_current_margin < 19.5 THEN
    v_emergency_price := (CEIL(v_base_purchase / (1.0 - v_target_margin / 100.0) / 10.0) * 10)::INT;
    IF v_emergency_price >= v_sikbom THEN
      v_sikbom := v_emergency_price;
      v_adjusted_margin := ROUND((1.0 - v_base_purchase::NUMERIC / v_sikbom) * 100, 2);
      v_reason := '긴급조정: 현재수익률 ' || v_current_margin::TEXT || '% < 19.5%, 일괄변경가 적용 (목표 ' || v_target_margin || '%)';
    END IF;
  END IF;

  -- ============================================================
  -- 7. 플랫폼별 판매가 연동
  --    배민 = 식봄 (동일)
  --    온일장 = 식봄 (동일)
  --    신선행 = MAX(CEIL(식봄*0.94/10)*10, CEIL(매입가/0.9/10)*10)
  -- ============================================================
  v_sinsun := GREATEST(
    (CEIL(v_sikbom * 0.94 / 10.0) * 10)::INT,
    (CEIL(v_base_purchase / 0.9 / 10.0) * 10)::INT
  );

  -- ============================================================
  -- 8. 행사품목: 정상가 = 판매가 * 1.25 (ROUNDUP to 10원)
  -- ============================================================
  IF v_is_event THEN
    v_normal := (CEIL(v_sikbom * 1.25 / 10.0) * 10)::INT;
  END IF;

  -- ============================================================
  -- 결과 반환
  -- ============================================================
  RETURN QUERY SELECT
    v_base_purchase, v_current_selling, v_current_margin,
    v_target_margin, v_adjusted_margin,
    v_sikbom,    -- 식봄
    v_sikbom,    -- 배민 = 식봄
    v_sinsun,    -- 신선행
    v_sikbom,    -- 온일장 = 식봄
    v_normal,    -- 정상가 (행사품목만, 비행사=NULL)
    v_reason;
END;
$$;
