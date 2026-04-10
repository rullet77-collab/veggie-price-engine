# 야채 판매가 자동책정 시스템 — Claude Code 프로젝트 가이드

## 프로젝트 개요

식자재 유통업체의 야채 판매가를 4개 플랫폼(식봄, 온일장, 신선행, 배민)에 자동으로 책정하는 시스템.
현재 구글시트 기반 수동 작업을 → Supabase + Next.js 웹 시스템으로 전환하는 프로젝트.

핵심 아키텍처: **3층 의사결정 엔진** (Signal → Strategy → Price)
- 신호 해석층: 시장 상태 판정 (추세, 변곡점, 변동성)
- 전략 선택층: 점수화 → 정책 선택 (마진방어/현상유지/점유율확대/공격적인하)
- 가격 산출층: 구체적 추천가 산출

**3단계 하네스 프로토콜**: 기획자 → 생성자 → 평가자 (GAN 구조)

## 기술 스택

| 구성요소 | 기술 |
|----------|------|
| DB | Supabase (PostgreSQL) — 프로젝트 ID: `sxndahqadpgivvejxjtg`, 리전: ap-northeast-2 |
| 프론트엔드 | Next.js (App Router) + TypeScript + Tailwind CSS |
| 배포 | Vercel |
| 코드관리 | GitHub |

## 현재 진행 상태 (2026-04-01 기준)

### S00-A: 2025년 데이터 Supabase 적재 — 진행 중

| 테이블 | 목표 | 현재 | 진행률 | 비고 |
|--------|------|------|--------|------|
| products | 838 | 838 | **100%** | 완료 |
| daily_purchase_prices | 65,535 | 25,349 | **39%** | SQL 배치 실행 필요 |
| daily_selling_prices | 60,486 | 9,587 | **16%** | SQL 배치 실행 필요 |

### 즉시 해야 할 작업: 데이터 로딩 완료

`claude-code-migration/` 폴더에 준비된 SQL 배치 파일을 실행하면 됨:

```bash
# 1. Supabase 연결 문자열 확인 (Supabase Dashboard → Settings → Database → Connection string)
# 형식: postgresql://postgres.[project-ref]:[password]@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres

# 2. 매입 데이터 로딩 (188 파일, ON CONFLICT DO NOTHING으로 안전)
for f in claude-code-migration/p_sql/*.sql; do
  psql "$DATABASE_URL" -f "$f" 2>/dev/null
  echo "Done: $f"
done

# 3. 매출 데이터 로딩 (173 파일, ON CONFLICT DO NOTHING으로 안전)
for f in claude-code-migration/s_sql/*.sql; do
  psql "$DATABASE_URL" -f "$f" 2>/dev/null
  echo "Done: $f"
done

# 4. 검증
psql "$DATABASE_URL" -c "SELECT 'products' as t, count(*) FROM products UNION ALL SELECT 'purchases', count(*) FROM daily_purchase_prices UNION ALL SELECT 'sales', count(*) FROM daily_selling_prices;"
# 기대값: products=838, purchases=65535, sales=60486
```

> **참고**: SQL 파일들은 모두 ON CONFLICT DO NOTHING 포함이므로 여러 번 실행해도 안전합니다.
> psql이 없으면 `npm install -g supabase` 후 Supabase MCP를 사용하거나,
> load_data.sh 스크립트를 참고하세요.

## 데이터베이스 스키마 (현재 Supabase에 존재)

```sql
-- 상품 마스터 (838행)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  product_code VARCHAR(6) UNIQUE NOT NULL,  -- 천년경영 상품코드
  product_name VARCHAR(200) NOT NULL,
  spec VARCHAR(100),                        -- 규격
  unit VARCHAR(20),                         -- 단위
  category_name VARCHAR(100),               -- 소분류명
  product_group INTEGER,                    -- 상품그룹 번호
  is_key_item BOOLEAN DEFAULT FALSE,        -- 주요 경쟁품목 여부
  is_event_item BOOLEAN DEFAULT FALSE,      -- 행사품목 여부
  target_margin_rate DECIMAL(5,2),          -- 목표수익률
  unit_type VARCHAR(20),
  platform_codes JSONB,                     -- 플랫폼별 상품코드 매핑
  parent_product_code VARCHAR(6),           -- 소분상품의 원물 코드
  has_purchase_history BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 일별 매입가 (목표: 65,535행)
CREATE TABLE daily_purchase_prices (
  id SERIAL PRIMARY KEY,
  product_code VARCHAR(6) NOT NULL REFERENCES products(product_code),
  price_date DATE NOT NULL,
  purchase_price INTEGER NOT NULL,
  quantity DECIMAL(10,2),
  unit VARCHAR(20),
  supply_amount INTEGER,
  UNIQUE(product_code, price_date, purchase_price)
);

-- 일별 매출가 (목표: 60,486행)
CREATE TABLE daily_selling_prices (
  id SERIAL PRIMARY KEY,
  product_code VARCHAR(6) NOT NULL REFERENCES products(product_code),
  price_date DATE NOT NULL,
  selling_price INTEGER NOT NULL,
  quantity DECIMAL(10,2),
  unit VARCHAR(20),
  supply_amount INTEGER,
  CONSTRAINT uq_selling UNIQUE(product_code, price_date, selling_price)
);
```

## 스프린트 로드맵

### 0단계: 백테스트 (현재)
- **S00-A**: 2025 데이터 Supabase 적재 ← **현재 여기**
- **S00-B**: 신호 해석층 백테스트 (추세/변곡점/변동성 계산)
- **S00-C**: 점수화 + 추천가 백테스트 (실제 판매가와 비교)
- **S00-D**: 품목군별 파라미터 튜닝

### 1단계: 기반 구축
- S01: Supabase DB 테이블 + Next.js 프로젝트
- S02: 엑셀 업로드 API (천년경영 → DB)
- S03: 기존 데이터 마이그레이션

### 2단계: 분석 엔진
- S05~S08: 매입가 변동, 7일 동향, 판매량 추이, 추천 판매가 산출

### 3단계: 웹 대시보드
- S09~S12: 전체상품 뷰, 인라인 수정, 추천가 UI, 상품그룹 동조화

### 4단계: 플랫폼 업로드
- S13~S16: 식봄/온일장/배민/신선행 업로드 파일 생성

## 핵심 비즈니스 규칙

### 판매가 계산 공식
- **수익률** = 1 - (매입가 ÷ 판매가)
- **수익률일괄변경가** = ROUNDUP(매입가 ÷ (1 - 목표수익률), -1)  ← 10원 단위 올림
- **신선행판매가** = MAX(식봄판매가 × 0.94, 매입가 ÷ 0.9)
- **배민판매가** = 식봄판매가 (동일)
- **행사품목**: 판매가 × 1.25 = 정상가

### 상품그룹 동조화
- 같은 그룹 내 매입빈도 최다 상품 = 대표상품
- 소분상품(매출만 있음)은 원물의 매입가 추세를 따라감
- parent_product_code로 원물↔소분 매핑

### 주요 경쟁 품목
무, 대파, 양배추, 쪽파, 양파, 양상추, 미나리, 버섯, 알배기

## 기본 원칙
- 판매가 계산 수식은 기획서(판매가_자동화_기획서.md) 섹션 2.1과 정확히 일치해야 한다
- 판단 기반 규칙(섹션 2.2)은 "추천"으로만 표시, 자동 확정 불가
- 형민님이 확정 버튼을 누르기 전까지 판매가 변경 없음
- 금액은 모두 정수(원 단위), ROUNDUP(-1)은 10원 단위 올림

## 하지 말 것
- .env 파일에 직접 시크릿 하드코딩 금지
- 판매가를 자동으로 플랫폼에 전송하지 않기 (반드시 사람 확인 후)
- 스프린트 계약서에 없는 기능 추가하지 않기

## 파일 구조

```
판매가변경영상/
├── 판매가_자동화_기획서.md              ← 전체 설계 문서 (필독)
├── CLAUDE.md                           ← 이 파일
├── claude-code-migration/
│   ├── CLAUDE.md                       ← 이 파일 사본
│   ├── p_sql/                          ← 매입 INSERT SQL (188 파일, 350행/파일)
│   ├── s_sql/                          ← 매출 INSERT SQL (173 파일, 350행/파일)
│   ├── load_data.sh                    ← 데이터 로딩 bash 스크립트
│   └── .mcp.json                       ← Supabase MCP 설정 (참고용)
├── sprints/                            ← 스프린트 계약서/평가서 (향후 생성)
└── src/                                ← Next.js 소스 (향후 생성)
```

## 데이터 원본

2025년 천년경영 엑셀:
- 매입상세: 65,535건, 497개 고유 상품코드
- 매출상세: 60,486건, 672개 고유 상품코드
- 양쪽 모두 있는 코드: 331개
- 매출만 있는 코드 (소분/재고판매): 341개
- 기간: 2025-01-02 ~ 2025-12-31
