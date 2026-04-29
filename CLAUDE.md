# 야채 판매가 자동책정 시스템 — Claude Code 프로젝트 가이드

## 프로젝트 개요

식자재 유통업체의 야채 판매가를 4개 플랫폼(식봄, 온일장, 신선행, 배민)에 자동으로 책정하는 시스템.
현재 구글시트 기반 수동 작업을 → Supabase + Next.js 웹 시스템으로 전환하는 프로젝트.

핵심 아키텍처: **3층 의사결정 엔진** (Signal → Strategy → Price)
- 신호 해석층: 시장 상태 판정 (추세, 변곡점, 변동성)
- 전략 선택층: 점수화 → 정책 선택 (마진방어/현상유지/점유율확대/공격적인하)
- 가격 산출층: 구체적 추천가 산출

**3단계 하네스 프로토콜**: 기획자 → 생성자 → 평가자 (GAN 구조)
- 스킬 체인: `clarification` → `plan-crafting` / `milestone-planning` → `run-plan` → `review-work`
- 모든 구현 작업은 반드시 스프린트 계약서(sprints/sprint-XX-contract.md)를 먼저 읽고 시작한다

## 기술 스택

| 구성요소 | 기술 |
|----------|------|
| DB | Supabase (PostgreSQL) — 프로젝트 ID: `sxndahqadpgivvejxjtg`, 리전: ap-northeast-2 |
| 프론트엔드 | Next.js (App Router) + TypeScript + Tailwind CSS |
| 배포 | Vercel |
| 코드관리 | GitHub |

## 현재 진행 상태 (2026-04-10 기준)

### 일일 운영 모드 — 가동 중

매일 반복되는 워크플로:
1. `/upload` — 오늘자 로우데이터 업로드 (매입상세 + 매출상세 + ★ 플랫폼시트)
2. `/products` — 전체상품 대시보드에서 판매가 확인·조정·확정
3. `/platform` — 플랫폼별 업로드 파일 다운로드

| 테이블 | 현재 상태 | 비고 |
|--------|-----------|------|
| products | 838행 | 상품 마스터 (고정) |
| daily_purchase_prices | 2026년~ 데이터만 | 일일 업로드로 누적 |
| daily_selling_prices | 2026년~ 데이터만 | 일일 업로드로 누적 |
| product_selling_prices | 현재 판매가 | 판매가 조정 시 upsert |
| learning_sessions / learning_items | 학습 이력 (보존) | 학습 기능 제거됨, 데이터만 보관 |

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

-- 일별 매입가 (2026년~ 일일 누적)
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

-- 일별 매출가 (2026년~ 일일 누적)
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

## 로드맵

### ✅ 완료
- DB 스키마 구축 (products, daily_purchase_prices, daily_selling_prices, product_selling_prices 등)
- 엑셀 업로드 API (매입상세 + 매출상세 + ★ 플랫폼시트 → DB)
- 전체상품 대시보드 (/products) — 필터, 인라인 수정, 수익률일괄변경 실행
- AI 추천 엔진 (3층 구조: 신호 해석 → 전략 선택 → 가격 산출)
- 2025년 데이터 정리 완료 (Supabase에서 삭제, 2026년~ 데이터만 유지)

### 🗑️ 제거됨
- 학습 시스템 (/learn, /learn/history) — 코드 삭제, DB 테이블(learning_sessions/items)은 보존

### 🔄 현재 — 일일 운영 + 개선
- 매일 로우데이터 업로드 → 판매가 조정
- 품목별 패턴이 보이면 aiRecommendation.ts 로직 분기 추가

### 📋 다음 단계
- 플랫폼 업로드 파일 자동 생성 (식봄/온일장/배민/신선행)
- 상품그룹 동조화 UI (대표상품 ↔ 소분상품 연동)

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
판매가변경영상/                          ← Git 루트 (main / dev 브랜치)
├── CLAUDE.md                           ← 이 파일
├── 판매가_자동화_기획서.md              ← 전체 설계 문서 (필독)
├── .gitignore
├── claude-code-migration/              ← 마이그레이션 참고자료 (gitignored)
│   └── load_data.sh
└── src/                                ← Next.js 프로젝트
    ├── package.json
    ├── next.config.ts
    ├── src/app/                         ← App Router 페이지
    │   ├── page.tsx                     ← / (대시보드)
    │   ├── products/page.tsx            ← /products (전체상품)
    │   ├── upload/page.tsx              ← /upload (데이터 업로드)
    │   ├── platform/page.tsx            ← /platform (플랫폼 업로드)
    │   └── api/                         ← API 라우트
    └── src/lib/
        ├── supabase.ts                  ← Supabase 클라이언트
        └── aiRecommendation.ts          ← AI 추천 엔진
```

## 데이터 현황

- **상품 마스터**: 838개 (products 테이블, 고정)
- **매입/매출 데이터**: 2026년~ 일일 업로드로 누적 (2025년 데이터는 정리 완료)
- **데이터 소스**: 천년경영 엑셀 (매입상세 + 매출상세) + ★ 플랫폼시트 (구글시트)

---

## 하네스 프로토콜 — 모든 작업의 필수 워크플로

> **이 프로토콜은 자연어 지시로 인해 작업 범위가 흐트러지는 것을 방지한다.**
> 형민님의 의도가 구현으로 정확히 전달되려면, 아래 흐름을 반드시 따른다.

### 스킬 체인 (자동 라우팅)

```
자연어 요청
    │
    ▼
[clarification]  ← 범위가 불명확할 때 항상 먼저
    │
    ├── 단순 (S00~S04 수준)
    │       ▼
    │   [plan-crafting] → [run-plan] → [review-work]
    │
    └── 복잡 (여러 스프린트, 큰 범위)
            ▼
        [milestone-planning] → [long-run]
            └─ 각 마일스톤: plan-crafting → run-plan → review-work
```

### 역할 매핑

| 하네스 역할 | 스킬 | 이 프로젝트에서의 의미 |
|-------------|------|----------------------|
| 기획자 (Planner) | `clarification` + `plan-crafting` | 스프린트 계약서 작성 |
| 생성자 (Generator) | `run-plan` | 계약서 범위 내 코드 구현 |
| 평가자 (Evaluator) | `review-work` | 합격 조건 기준 검증 |

### 강제 규칙

1. **계약서 없이 코드 작성 금지** — `sprints/sprint-XX-contract.md` 없으면 먼저 plan-crafting으로 계약서 작성
2. **범위 초과 작업 금지** — 계약서 밖의 요청이 들어오면 "다음 스프린트에 포함할까요?" 물어보기
3. **평가자 생략 금지** — run-plan 완료 후 반드시 review-work 실행
4. **판단 필요 비즈니스 규칙** — 구현하지 않고 형민님에게 질문

### 트리거 예시

| 형민님이 말할 때 | 자동으로 실행되는 스킬 |
|----------------|----------------------|
| "S00-B 백테스트 시작하자" | clarification → plan-crafting → run-plan → review-work |
| "마일스톤으로 나눠줘" | milestone-planning |
| "스프린트 실행해" / "long run" | long-run |
| "코드 검토해줘" | review-work |
| "버그가 있어" / "에러" | systematic-debugging |
| "정리해줘" / "simplify" | simplify / clean-ai-slop |
