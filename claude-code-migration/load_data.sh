#!/bin/bash
# =============================================================================
# 야채 판매가 자동화 — 2025년 데이터 Supabase 로딩 스크립트
# =============================================================================
#
# 사용법:
#   1. DATABASE_URL 환경변수를 설정하거나 아래에 직접 입력
#   2. chmod +x load_data.sh && ./load_data.sh
#
# Supabase 연결 문자열 확인:
#   Supabase Dashboard → Settings → Database → Connection string (URI)
#   형식: postgresql://postgres.[project-ref]:[password]@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres
#
# 참고: 모든 SQL은 ON CONFLICT DO NOTHING 포함이므로 여러 번 실행해도 안전합니다.
# =============================================================================

# DATABASE_URL이 설정되지 않았으면 입력 요청
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL이 설정되지 않았습니다."
  echo "Supabase Dashboard → Settings → Database → Connection string (URI) 에서 확인하세요."
  echo ""
  read -p "Database URL을 입력하세요: " DATABASE_URL
  export DATABASE_URL
fi

# 연결 테스트
echo "=== 연결 테스트 ==="
psql "$DATABASE_URL" -c "SELECT 'Connection OK' as status;" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "ERROR: 데이터베이스 연결 실패. DATABASE_URL을 확인하세요."
  echo "psql이 설치되어 있지 않다면: brew install postgresql (Mac) 또는 apt install postgresql-client (Linux)"
  exit 1
fi

# 현재 상태 확인
echo ""
echo "=== 로딩 전 현재 상태 ==="
psql "$DATABASE_URL" -c "
SELECT 'products' as table_name, count(*) as rows FROM products
UNION ALL SELECT 'purchases', count(*) FROM daily_purchase_prices
UNION ALL SELECT 'sales', count(*) FROM daily_selling_prices
ORDER BY table_name;
"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 매입 데이터 로딩
echo ""
echo "=== 매입 데이터 로딩 시작 (188 파일) ==="
P_COUNT=0
P_TOTAL=$(ls "$SCRIPT_DIR/p_sql/"*.sql 2>/dev/null | wc -l | tr -d ' ')
for f in "$SCRIPT_DIR/p_sql/"*.sql; do
  P_COUNT=$((P_COUNT + 1))
  psql "$DATABASE_URL" -f "$f" -q 2>/dev/null
  if [ $((P_COUNT % 20)) -eq 0 ]; then
    echo "  매입: $P_COUNT / $P_TOTAL 완료"
  fi
done
echo "  매입: $P_COUNT / $P_TOTAL 완료 (전체 완료)"

# 매출 데이터 로딩
echo ""
echo "=== 매출 데이터 로딩 시작 (173 파일) ==="
S_COUNT=0
S_TOTAL=$(ls "$SCRIPT_DIR/s_sql/"*.sql 2>/dev/null | wc -l | tr -d ' ')
for f in "$SCRIPT_DIR/s_sql/"*.sql; do
  S_COUNT=$((S_COUNT + 1))
  psql "$DATABASE_URL" -f "$f" -q 2>/dev/null
  if [ $((S_COUNT % 20)) -eq 0 ]; then
    echo "  매출: $S_COUNT / $S_TOTAL 완료"
  fi
done
echo "  매출: $S_COUNT / $S_TOTAL 완료 (전체 완료)"

# 결과 검증
echo ""
echo "=== 로딩 완료 — 최종 검증 ==="
psql "$DATABASE_URL" -c "
SELECT 'products' as table_name, count(*) as rows, 838 as expected FROM products
UNION ALL SELECT 'purchases', count(*), 65535 FROM daily_purchase_prices
UNION ALL SELECT 'sales', count(*), 60486 FROM daily_selling_prices
ORDER BY table_name;
"

echo ""
echo "=== 날짜 범위 검증 ==="
psql "$DATABASE_URL" -c "
SELECT 'purchases' as tbl, min(price_date) as min_date, max(price_date) as max_date, count(DISTINCT product_code) as products
FROM daily_purchase_prices
UNION ALL
SELECT 'sales', min(price_date), max(price_date), count(DISTINCT product_code)
FROM daily_selling_prices;
"

echo ""
echo "완료! 위 결과에서 products=838, purchases≈65535, sales≈60486이면 성공입니다."
echo "다음 단계: S00-B 신호 해석층 백테스트"
