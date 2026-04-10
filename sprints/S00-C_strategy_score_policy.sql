-- ============================================================
-- S00-C: 전략 선택층 (점수화 시스템) SQL 함수들
-- 생성일: 2026-04-01
-- Supabase 프로젝트: sxndahqadpgivvejxjtg
-- ============================================================

-- ============================================================
-- Part 1: signal_sales_trend — 매출 추이 분석
-- ============================================================
-- 직전 3개월 중 매출 있는 월만 계산
-- 각 월의 일평균 판매량 → 평균 → 당월 진행일수 기준 기대치
-- 당월 실제 판매량과 비교하여 등락률(%) 반환
-- ============================================================

CREATE OR REPLACE FUNCTION signal_sales_trend(
  p_product_code VARCHAR(6),
  p_date DATE
)
RETURNS TABLE(
  expected_qty NUMERIC,
  actual_qty NUMERIC,
  change_rate NUMERIC,
  label VARCHAR
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_current_month_start DATE;
  v_day_of_month INT;
  v_days_in_month INT;
  v_actual_qty NUMERIC;
  v_prev_months_data RECORD;
  v_total_daily_avg NUMERIC := 0;
  v_month_count INT := 0;
  v_expected_qty NUMERIC;
  v_change_rate NUMERIC;
  v_m DATE;
BEGIN
  v_current_month_start := DATE_TRUNC('month', p_date)::DATE;
  v_day_of_month := EXTRACT(DAY FROM p_date)::INT;
  v_days_in_month := (EXTRACT(DAY FROM (DATE_TRUNC('month', p_date) + INTERVAL '1 month - 1 day')))::INT;

  -- Actual sales quantity in current month up to p_date
  SELECT COALESCE(SUM(s.quantity), 0)
  INTO v_actual_qty
  FROM daily_selling_prices s
  WHERE s.product_code = p_product_code
    AND s.price_date >= v_current_month_start
    AND s.price_date <= p_date;

  -- Check previous 3 months
  FOR i IN 1..3 LOOP
    v_m := (v_current_month_start - (i || ' months')::INTERVAL)::DATE;

    SELECT
      SUM(s.quantity) as total_qty,
      (EXTRACT(DAY FROM (v_m + INTERVAL '1 month - 1 day')))::INT as days_in_month
    INTO v_prev_months_data
    FROM daily_selling_prices s
    WHERE s.product_code = p_product_code
      AND s.price_date >= v_m
      AND s.price_date < (v_m + INTERVAL '1 month')::DATE;

    IF v_prev_months_data.total_qty IS NOT NULL AND v_prev_months_data.total_qty > 0 THEN
      v_total_daily_avg := v_total_daily_avg + (v_prev_months_data.total_qty / v_prev_months_data.days_in_month);
      v_month_count := v_month_count + 1;
    END IF;
  END LOOP;

  IF v_month_count = 0 THEN
    IF v_actual_qty > 0 THEN
      RETURN QUERY SELECT 0::NUMERIC, v_actual_qty, NULL::NUMERIC, '신규매출'::VARCHAR;
    ELSE
      RETURN QUERY SELECT 0::NUMERIC, 0::NUMERIC, NULL::NUMERIC, NULL::VARCHAR;
    END IF;
    RETURN;
  END IF;

  -- Scale expected by day progress in current month
  v_expected_qty := (v_total_daily_avg / v_month_count) * v_day_of_month;

  IF v_expected_qty = 0 THEN
    v_change_rate := NULL;
  ELSE
    v_change_rate := ROUND(((v_actual_qty - v_expected_qty) / v_expected_qty) * 100, 1);
  END IF;

  RETURN QUERY SELECT
    ROUND(v_expected_qty, 1),
    v_actual_qty,
    v_change_rate,
    CASE
      WHEN v_change_rate IS NULL THEN NULL
      WHEN v_change_rate > 0 THEN ('▲' || ABS(v_change_rate) || '%')::VARCHAR
      WHEN v_change_rate < 0 THEN ('▼' || ABS(v_change_rate) || '%')::VARCHAR
      ELSE '동일'::VARCHAR
    END;
END;
$function$;


-- ============================================================
-- Part 2: strategy_score_policy — 점수화 + 정책 선택
-- ============================================================
-- 신호 해석층(S00-B) 함수들의 결과를 점수로 변환
-- 점수 합계로 6단계 정책 선택
--
-- 하락(인하) 방향 → 양수 점수:
--   추세하락(+2), 급락(+2), 매출둔화(+2), 판매량감소(+1),
--   박스권이탈-하방(+1), 변곡점확인(+1), 주요경쟁품목(+1)
-- 상승(인상) 방향 → 음수 점수:
--   추세상승(-2), 급등(-2), 매출호조(-1), 판매량증가(-1),
--   박스권이탈-상방(-1)
--
-- 점수 → 정책:
--   <= -3: 마진상향 (+1.5%p)
--   -2~-1: 소극적상향 (+0.75%p)
--   0~1:   현상유지 (0)
--   2~3:   소극적인하 (-1%p)
--   4~5:   점유율확대 (-2%p)
--   >= 6:  공격적인하 (-3%p)
-- ============================================================

CREATE OR REPLACE FUNCTION strategy_score_policy(
  p_product_code VARCHAR(6),
  p_date DATE
)
RETURNS TABLE(
  total_score INT,
  policy VARCHAR,
  margin_adjustment NUMERIC,
  score_details JSONB
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_score INT := 0;
  v_details JSONB := '[]'::JSONB;

  -- Signal results
  v_trend RECORD;
  v_consec RECORD;
  v_inflec RECORD;
  v_volatility RECORD;
  v_sales RECORD;
  v_is_key_item BOOLEAN;

  -- Latest price vs box
  v_latest_price INT;
  v_latest_gap_rate NUMERIC;
  v_effective_inflection_dir VARCHAR;

  v_policy VARCHAR;
  v_margin_adj NUMERIC;
BEGIN
  -- Gather all signals
  SELECT * INTO v_trend FROM signal_trimmed_mean_trend(p_product_code, p_date);
  SELECT * INTO v_consec FROM signal_consecutive_trend(p_product_code, p_date);
  SELECT * INTO v_inflec FROM signal_inflection_point(p_product_code, p_date);
  SELECT * INTO v_volatility FROM signal_volatility(p_product_code, p_date);
  SELECT * INTO v_sales FROM signal_sales_trend(p_product_code, p_date);

  SELECT p.is_key_item INTO v_is_key_item
  FROM products p WHERE p.product_code = p_product_code;

  -- Get the latest purchase price on or before p_date
  SELECT purchase_price INTO v_latest_price
  FROM daily_purchase_prices
  WHERE product_code = p_product_code AND price_date <= p_date
  ORDER BY price_date DESC LIMIT 1;

  -- Determine effective inflection direction based on LATEST price vs box
  -- This corrects cases where first breakout was down but latest price surged up
  IF v_inflec.box_avg IS NOT NULL AND v_inflec.box_avg > 0 AND v_latest_price IS NOT NULL THEN
    v_latest_gap_rate := (v_latest_price - v_inflec.box_avg) / v_inflec.box_avg;
    IF v_latest_gap_rate > 0.05 THEN
      v_effective_inflection_dir := '상방이탈';
    ELSIF v_latest_gap_rate < -0.05 THEN
      v_effective_inflection_dir := '하방이탈';
    ELSE
      v_effective_inflection_dir := NULL;
    END IF;
  ELSE
    v_effective_inflection_dir := v_inflec.inflection_direction;
  END IF;

  -- ===== DOWNWARD (price cut) signals = positive scores =====

  -- 1. 추세 하락: consecutive_trend = '하락' AND consecutive_days >= 3 -> +2
  IF v_consec.direction = '하락' AND v_consec.consecutive_days >= 3 THEN
    v_score := v_score + 2;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '추세하락', 'score', 2,
      'detail', v_consec.direction || ' ' || v_consec.consecutive_days || '일 연속'
    ));
  END IF;

  -- 2. 급락: trimmed_mean_trend = '급락' -> +2
  IF v_trend.trend = '급락' THEN
    v_score := v_score + 2;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '급락', 'score', 2,
      'detail', '절사평균 변동률 ' || ROUND(v_trend.change_rate * 100, 1) || '%'
    ));
  END IF;

  -- 3. 매출 둔화: sales change_rate > 0 AND <= 10 -> +2
  IF v_sales.change_rate IS NOT NULL AND v_sales.change_rate > 0 AND v_sales.change_rate <= 10 THEN
    v_score := v_score + 2;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '매출둔화', 'score', 2,
      'detail', '매출 증가율 ' || v_sales.change_rate || '% (둔화)'
    ));
  END IF;

  -- 4. 판매량 감소: sales change_rate < 0 -> +1
  IF v_sales.change_rate IS NOT NULL AND v_sales.change_rate < 0 THEN
    v_score := v_score + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '판매량감소', 'score', 1,
      'detail', '매출 변화율 ' || v_sales.change_rate || '%'
    ));
  END IF;

  -- 5. 박스권 이탈(하방) -> +1
  IF v_effective_inflection_dir = '하방이탈' THEN
    v_score := v_score + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '박스권이탈(하방)', 'score', 1,
      'detail', '최근가 ' || v_latest_price || '원 vs 박스평균 ' || v_inflec.box_avg || '원 (갭률 ' || ROUND(v_latest_gap_rate * 100, 1) || '%)'
    ));
  END IF;

  -- 6. 변곡점 확인: inflection_price IS NOT NULL -> +1
  IF v_inflec.inflection_price IS NOT NULL THEN
    v_score := v_score + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '변곡점확인', 'score', 1,
      'detail', '변곡일 ' || v_inflec.inflection_date || ', 방향 ' || COALESCE(v_inflec.inflection_direction, 'N/A')
    ));
  END IF;

  -- 7. 주요 경쟁 품목 -> +1
  IF v_is_key_item = TRUE THEN
    v_score := v_score + 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '주요경쟁품목', 'score', 1,
      'detail', '경쟁 우선 품목'
    ));
  END IF;

  -- ===== UPWARD (price raise) signals = negative scores =====

  -- 8. 추세 상승: consecutive >= 3일 -> -2
  IF v_consec.direction = '상승' AND v_consec.consecutive_days >= 3 THEN
    v_score := v_score - 2;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '추세상승', 'score', -2,
      'detail', v_consec.direction || ' ' || v_consec.consecutive_days || '일 연속'
    ));
  END IF;

  -- 9. 급등: trimmed_mean_trend = '급등' -> -2
  IF v_trend.trend = '급등' THEN
    v_score := v_score - 2;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '급등', 'score', -2,
      'detail', '절사평균 변동률 ' || ROUND(v_trend.change_rate * 100, 1) || '%'
    ));
  END IF;

  -- 10. 매출 호조: sales change_rate >= 20 -> -1
  IF v_sales.change_rate IS NOT NULL AND v_sales.change_rate >= 20 THEN
    v_score := v_score - 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '매출호조', 'score', -1,
      'detail', '매출 증가율 ' || v_sales.change_rate || '%'
    ));
  END IF;

  -- 11. 판매량 증가: sales change_rate > 0 -> -1
  IF v_sales.change_rate IS NOT NULL AND v_sales.change_rate > 0 THEN
    v_score := v_score - 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '판매량증가', 'score', -1,
      'detail', '매출 변화율 +' || v_sales.change_rate || '%'
    ));
  END IF;

  -- 12. 박스권 이탈(상방) -> -1
  IF v_effective_inflection_dir = '상방이탈' THEN
    v_score := v_score - 1;
    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'signal', '박스권이탈(상방)', 'score', -1,
      'detail', '최근가 ' || v_latest_price || '원 vs 박스평균 ' || v_inflec.box_avg || '원 (갭률 +' || ROUND(v_latest_gap_rate * 100, 1) || '%)'
    ));
  END IF;

  -- ===== Score -> Policy mapping =====
  IF v_score <= -3 THEN
    v_policy := '마진상향';
    v_margin_adj := 1.5;
  ELSIF v_score <= -1 THEN
    v_policy := '소극적상향';
    v_margin_adj := 0.75;
  ELSIF v_score <= 1 THEN
    v_policy := '현상유지';
    v_margin_adj := 0;
  ELSIF v_score <= 3 THEN
    v_policy := '소극적인하';
    v_margin_adj := -1;
  ELSIF v_score <= 5 THEN
    v_policy := '점유율확대';
    v_margin_adj := -2;
  ELSE
    v_policy := '공격적인하';
    v_margin_adj := -3;
  END IF;

  RETURN QUERY SELECT v_score, v_policy, v_margin_adj, v_details;
END;
$function$;
