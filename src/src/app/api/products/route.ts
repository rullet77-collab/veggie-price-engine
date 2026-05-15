import { supabase } from "@/lib/supabase";
import { calculateAiRecommendation, type AiRecInput, tokenizeName, gradeMatchScore, getGradeTier, getUnitConversionRatio, ceil10 } from "@/lib/aiRecommendation";
import { computePrev3MonthPct } from "@/lib/salesStats";

// Next.js 가 GET 응답을 캐시하지 않도록 강제 dynamic
export const dynamic = "force-dynamic";
export const revalidate = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(table: string, select: string, filters?: (q: any) => any): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// AI reason 문자열에서 UI용 짧은 태그 추출
function extractShortReason(reason: string): string {
  // 보조 성격의 [그룹 참조 보조] 구문은 태그 판정에서 제외
  const main = reason.replace(/\[그룹 참조 보조\][^.]*\./g, "");

  if (main.includes("역마진")) return "역마진";
  // 그룹 참조가 실제 가격 계산에 쓰인 경우 (pp 대체)
  if (main.includes("[그룹 참조]") && main.includes("박스→소분 관계식")) return "박스→소분";
  if (main.includes("[그룹 참조]") && main.includes("소분→박스 관계식")) return "소분→박스";
  if (main.includes("[그룹 참조]") && main.includes("소분→소분 관계식")) return "소분간환산";
  if (main.includes("[그룹 참조]") && main.includes("변동률 교차참조")) return "그룹추정";
  if (main.includes("이상치-상승")) return "상승이상";
  if (main.includes("이상치-하락")) return "하락이상";
  if (main.includes("매출 급감")) return "매출↓";
  if (main.includes("공격적 인하")) return "공격인하";
  if (main.includes("비인기 품목")) return "비인기";
  if (main.includes("8일간") && main.includes("상승") && main.includes("연속")) return "매입↑↑";
  if (main.includes("8일간") && main.includes("하락") && main.includes("연속")) return "매입↓↓";
  if (main.includes("상승 추세")) return "매입↑";
  if (main.includes("하락 추세")) return "매입↓";
  if (main.includes("변곡점")) return "변곡";
  if (main.includes("매출 ▲") && main.includes("가격예민")) return "매출↑예민";
  if (main.includes("매출 ▲") && main.includes("가격고정")) return "매출↑고정";
  if (main.includes("매출 ▲")) return "매출↑";
  if (main.includes("주요 경쟁품목")) return "경쟁가드";
  if (main.includes("하한선")) return "하한";
  if (main.includes("보합") || main.includes("매입 이력 부족")) return "유지";
  return "기본";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get("category");
    const group = url.searchParams.get("group");

    // 1) priceDate 결정 — daily_purchase_prices 의 max 와 mgmt 의 max 중 더 최근값
    //    (mgmt 가 갱신 안되더라도 매입 이력이 들어오면 그 날짜를 기준으로 사용)
    const [{ data: latestMgmt }, { data: latestDaily }] = await Promise.all([
      supabase.from("daily_product_management").select("price_date").order("price_date", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("daily_purchase_prices").select("price_date").order("price_date", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const mgmtMax = (latestMgmt as { price_date: string } | null)?.price_date ?? null;
    const dailyMax = (latestDaily as { price_date: string } | null)?.price_date ?? null;
    const priceDate = (mgmtMax && dailyMax) ? (mgmtMax >= dailyMax ? mgmtMax : dailyMax) : (mgmtMax || dailyMax);
    if (!priceDate) return Response.json([]);

    // 2) 해당 날짜 (또는 가장 최근 날짜) mgmt 데이터 — outdated 일 수 있음 (fallback 으로만)
    type MgmtRow = {
      product_code: string; price_date: string;
      purchase_price: number | null; selling_price: number | null;
      prev_purchase_price: number | null; prev_selling_price: number | null;
      product_name: string | null; spec: string | null;
      unit: string | null; category_name: string | null;
      major_category: string | null;
    };
    // mgmt 의 max 날짜 데이터 (priceDate 가 daily 라 mgmt 와 다를 수 있음)
    const mgmtData = mgmtMax ? await fetchAll<MgmtRow>(
      "daily_product_management",
      "product_code,price_date,purchase_price,selling_price,prev_purchase_price,prev_selling_price,product_name,spec,unit,category_name,major_category",
      (q) => q.eq("price_date", mgmtMax)
    ) : [];

    // 3) products 마스터 (Phase 5-A: pack_role, pack_meta / Layer 4-B: spec / 학습 tier)
    type ProdRow = {
      product_code: string; product_group: number | null;
      is_key_item: boolean; target_margin_rate: number | null;
      is_event_item: boolean; product_type: string | null;
      price_sensitivity: string | null;
      pack_role: string | null; pack_meta: unknown;
      product_name: string | null; unit: string | null;
      spec: string | null;
      category_name: string | null;
      learned_tier: number | null;
      platform_status: string | null;
      price_fixed: boolean | null;
      purchase_source: string | null;
    };
    const productsData = await fetchAll<ProdRow>(
      "products",
      "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type,price_sensitivity,pack_role,pack_meta,product_name,unit,spec,category_name,learned_tier,platform_status,price_fixed,purchase_source"
    );
    const productMap = new Map<string, ProdRow>();
    for (const p of productsData) productMap.set(p.product_code, p);

    // Phase 5-A: 그룹별 멤버 목록 인덱싱
    const groupMembersMap = new Map<number, ProdRow[]>();
    for (const p of productsData) {
      if (p.product_group) {
        if (!groupMembersMap.has(p.product_group)) groupMembersMap.set(p.product_group, []);
        groupMembersMap.get(p.product_group)!.push(p);
      }
    }

    // B-3: group_tier_ratios 로드 (등급 페어별 가격비)
    type TierRatioRow = { product_group: number; tier_a: number; tier_b: number; ratio: number };
    const tierRatioRows = await fetchAll<TierRatioRow>(
      "group_tier_ratios", "product_group,tier_a,tier_b,ratio"
    );
    const tierRatios = new Map<string, number>();
    for (const r of tierRatioRows) {
      tierRatios.set(`${r.product_group}-${r.tier_a}-${r.tier_b}`, Number(r.ratio));
    }

    // 그룹별 reference 상품 — 60일 매입 카운트 최다 (안정된 변동률 시그널 제공)
    // (purchaseHistory60 은 아래에서 조회되므로 빈 Map 으로 시작하고 매입 이력 적재 후 산출)
    const groupReferenceCode = new Map<number, string>();

    // 4) 플랫폼 판매가 + 월별 매출 통계
    // current_month_qty, prev_3month_pct 는 DB에 저장하지 않고 매번 계산 (single source of truth: monthly_sales_quantity)
    type SellingRow = {
      product_code: string;
      selling_price: number | null;
      prev_selling_price: number | null;
      recommended_price: number | null;
      month_1_qty: number | null; month_2_qty: number | null; month_3_qty: number | null;
    };
    const sellingData = await fetchAll<SellingRow>(
      "product_selling_prices",
      "product_code,selling_price,prev_selling_price,recommended_price,month_1_qty,month_2_qty,month_3_qty"
    );
    const sellingMap = new Map<string, SellingRow>();
    for (const s of sellingData) sellingMap.set(s.product_code, s);

    // 5) 매입가 이력 — 7일(UI용) + 8일(Layer 1) + 60일(Layer 1 장기)
    const sevenDaysAgo = new Date(priceDate);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const eightDaysAgo = new Date(priceDate);
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const sixtyDaysAgo = new Date(priceDate);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    type PurchRow = { product_code: string; price_date: string; purchase_price: number };
    const purchaseHistory60 = await fetchAll<PurchRow>(
      "daily_purchase_prices",
      "product_code,price_date,purchase_price",
      (q) => q.gte("price_date", sixtyDaysAgo.toISOString().slice(0, 10)).lte("price_date", priceDate).order("price_date", { ascending: true })
    );

    const purchaseMap = new Map<string, { prices: number[]; todayPrice: number | null }>();     // 7일 (UI)
    const shortHistoryMap = new Map<string, { date: string; price: number }[]>();                 // 8일 (Layer 1)
    const longHistoryMap = new Map<string, { date: string; price: number }[]>();                  // 60일 (Layer 1 장기)
    // 날짜별 코드별 가격 인덱스 (UI 7일 동향 빈 슬롯 그룹 환산용)
    const priceByDateAndCode = new Map<string, Map<string, number>>();
    // daily 기반 today/prev 자동 도출용 — distinct date 별 마지막 매입가
    const datePriceByCode = new Map<string, Map<string, number>>();
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
    const eightDaysAgoStr = eightDaysAgo.toISOString().slice(0, 10);

    for (const ph of purchaseHistory60) {
      const entry = { date: ph.price_date, price: ph.purchase_price };

      if (!longHistoryMap.has(ph.product_code)) longHistoryMap.set(ph.product_code, []);
      longHistoryMap.get(ph.product_code)!.push(entry);

      if (ph.price_date >= eightDaysAgoStr) {
        if (!shortHistoryMap.has(ph.product_code)) shortHistoryMap.set(ph.product_code, []);
        shortHistoryMap.get(ph.product_code)!.push(entry);
      }

      if (ph.price_date >= sevenDaysAgoStr) {
        if (!purchaseMap.has(ph.product_code)) purchaseMap.set(ph.product_code, { prices: [], todayPrice: null });
        const u = purchaseMap.get(ph.product_code)!;
        u.prices.push(ph.purchase_price);
        if (ph.price_date === priceDate) u.todayPrice = ph.purchase_price;

        // 날짜별 코드별 인덱스 (그룹 환산용)
        if (!priceByDateAndCode.has(ph.price_date)) priceByDateAndCode.set(ph.price_date, new Map());
        priceByDateAndCode.get(ph.price_date)!.set(ph.product_code, ph.purchase_price);
      }

      // distinct date 별 마지막 매입가 (60일 윈도우 전체)
      if (!datePriceByCode.has(ph.product_code)) datePriceByCode.set(ph.product_code, new Map());
      datePriceByCode.get(ph.product_code)!.set(ph.price_date, ph.purchase_price);
    }

    // daily 기반 today / prev 자동 도출 (가장 최근 distinct date + 그 직전)
    const dailyTodayMap = new Map<string, number>();
    const dailyPrevMap = new Map<string, number>();
    for (const [code, dPrices] of datePriceByCode.entries()) {
      const sortedDates = [...dPrices.keys()].sort().reverse();  // desc
      if (sortedDates[0]) dailyTodayMap.set(code, dPrices.get(sortedDates[0])!);
      if (sortedDates[1]) dailyPrevMap.set(code, dPrices.get(sortedDates[1])!);
    }

    // 그룹별 reference 상품 산출 — 60일 distinct 매입일 수가 가장 많은 멤버
    // (조림용 같이 매입 띄엄띄엄한 상품의 변동률 추정 anchor 로 사용)
    {
      const byGroup = new Map<number, { code: string; cnt: number }>();
      for (const [code, dates] of datePriceByCode.entries()) {
        const p = productMap.get(code);
        if (!p?.product_group) continue;
        const cur = byGroup.get(p.product_group);
        if (!cur || dates.size > cur.cnt) byGroup.set(p.product_group, { code, cnt: dates.size });
      }
      for (const [groupId, info] of byGroup) groupReferenceCode.set(groupId, info.code);
    }

    // 7일 동향 슬롯 날짜 배열 (sevenDaysAgo ~ priceDate, 8일 inclusive)
    const slotDates: string[] = [];
    {
      const d = new Date(sevenDaysAgo);
      const end = new Date(priceDate);
      while (d <= end) {
        slotDates.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
      }
    }

    // 6) 월별 매출 — 현재월(UI) + 최근 3개월(Layer 2) + 직전 3개월(Layer 2)
    const monthStr = priceDate.slice(0, 7) + "-01";
    const priceDateObj = new Date(priceDate);
    const recentMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
    const prevMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1);
    const prevMonthEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);

    type SalesQtyRow = { product_code: string; sale_month: string; quantity: number; source: string | null };
    const monthlySales = await fetchAll<SalesQtyRow>(
      "monthly_sales_quantity", "product_code,sale_month,quantity,source",
      (q) => q.gte("sale_month", prevMonthStart.toISOString().slice(0, 10))
    );

    // 채널별 데이터 인덱싱 — (code, source) → Map<sale_month, qty>
    type ChannelMap = Map<string, Map<string, Map<string, number>>>;  // code → source → month → qty
    const channelData: ChannelMap = new Map();
    const totalData = new Map<string, Map<string, number>>();          // code → month → total qty (4채널 합)

    const CHANNELS = ["식봄", "신선행", "온일장", "배민"] as const;

    for (const ms of monthlySales) {
      const src = ms.source;
      if (!src) continue;
      if (!CHANNELS.includes(src as typeof CHANNELS[number])) continue;
      const qty = ms.quantity || 0;
      // 채널별
      if (!channelData.has(ms.product_code)) channelData.set(ms.product_code, new Map());
      const sm = channelData.get(ms.product_code)!;
      if (!sm.has(src)) sm.set(src, new Map());
      sm.get(src)!.set(ms.sale_month, qty);
      // total 합산
      if (!totalData.has(ms.product_code)) totalData.set(ms.product_code, new Map());
      const tm = totalData.get(ms.product_code)!;
      tm.set(ms.sale_month, (tm.get(ms.sale_month) || 0) + qty);
    }

    // 기존 total 기반 호환용 (Phase 3 매출 판정 / UI 1/2/3월 양수)
    const salesQtyMap = new Map<string, number>();  // 이번달 total
    const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
    const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
    const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);

    for (const [code, monthMap] of totalData.entries()) {
      for (const [sm, qty] of monthMap.entries()) {
        if (sm === monthStr) salesQtyMap.set(code, qty);
        const entry = { sale_month: sm, quantity: qty };
        if (sm >= recentStartStr) {
          if (!recentSalesMap.has(code)) recentSalesMap.set(code, []);
          recentSalesMap.get(code)!.push(entry);
        } else if (sm >= prevStartStr && sm < prevEndStr) {
          if (!prevSalesMap.has(code)) prevSalesMap.set(code, []);
          prevSalesMap.get(code)!.push(entry);
        }
      }
    }

    // priceDate 기반 m1/m2/m3 month 키 산출 (priceDate 기준 -3, -2, -1 개월)
    // 시간대 무관 — 직접 문자열 합성 (toISOString 은 UTC 변환되어 1일 밀릴 수 있음)
    const monthDate = (offset: number): string => {
      const y = priceDateObj.getFullYear();
      const m0 = priceDateObj.getMonth() - offset;
      const targetY = y + Math.floor(m0 / 12);
      const targetM = ((m0 % 12) + 12) % 12;
      return `${targetY}-${String(targetM + 1).padStart(2, "0")}-01`;
    };
    const m1Month = monthDate(3);  // 3개월 전
    const m2Month = monthDate(2);  // 2개월 전
    const m3Month = monthDate(1);  // 1개월 전
    const curMonth = monthStr;     // 이번달

    // 채널별 prev_3month_pct 산출 helper
    const computePct = (m1: number | null, m2: number | null, m3: number | null, cur: number | null): string | null => {
      const v1 = m1 || 0, v2 = m2 || 0, v3 = m3 || 0;
      const valCur = cur || 0;
      const months = [
        { value: v1, days: new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 0).getDate() },
        { value: v2, days: new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 1, 0).getDate() },
        { value: v3, days: new Date(priceDateObj.getFullYear(), priceDateObj.getMonth(), 0).getDate() },
      ];
      const nMo = months.filter((m) => m.value > 0).length;
      if (nMo === 0) return valCur > 0 ? "신규매출" : null;
      let sumDaily = 0;
      for (const m of months) if (m.value > 0) sumDaily += m.value / m.days;
      const aDaily = sumDaily / nMo;
      const dayOfMonth = priceDateObj.getDate();
      const eBase = aDaily * dayOfMonth;
      if (eBase < 0.1) return valCur > 0 ? "▲기준치미달" : "0.00%";
      const dRate = (valCur - eBase) / eBase;
      if (dRate > 0) return `▲${(dRate * 100).toFixed(2)}%`;
      if (dRate < 0) return `▼${(Math.abs(dRate) * 100).toFixed(2)}%`;
      return "0.00%";
    };

    // 7) 결과 조합 — 소스: products 마스터 (mgmt 가 outdated/누락이어도 모든 상품 노출)
    const mgmtMap = new Map<string, MgmtRow>();
    for (const m of mgmtData) mgmtMap.set(m.product_code, m);

    let results = productsData.map((prod) => {
      const row = mgmtMap.get(prod.product_code) || {
        product_code: prod.product_code,
        price_date: priceDate,
        purchase_price: null, selling_price: null,
        prev_purchase_price: null, prev_selling_price: null,
        product_name: prod.product_name, spec: prod.spec, unit: prod.unit,
        category_name: prod.category_name, major_category: null,
      } as MgmtRow;
      const selling = sellingMap.get(row.product_code);
      const ph = purchaseMap.get(row.product_code);
      const monthlyQty = salesQtyMap.get(row.product_code) || null;

      // daily_purchase_prices 우선 (매일 매입 이력 누적이 source of truth),
      // mgmt 의 기존/변경 컬럼은 fallback (daily 데이터 없을 때만)
      const dailyToday = dailyTodayMap.get(row.product_code);
      const dailyPrev = dailyPrevMap.get(row.product_code);
      const purchasePrice = (dailyToday != null && dailyToday > 0) ? dailyToday : (row.purchase_price || 0);
      const prevPurchase = (dailyPrev != null && dailyPrev > 0) ? dailyPrev : (row.prev_purchase_price || 0);

      // 변동률/변동액
      const changeAmount = prevPurchase > 0 ? purchasePrice - prevPurchase : 0;
      const changeRate = prevPurchase > 0 ? changeAmount / prevPurchase : 0;

      // 플랫폼 판매가 (product_selling_prices에서)
      // 사용자 수동 입력값 (NULL = 추천가 자동 적용 모드). AI 입력에서는 0 처리.
      const platformSellingPrice: number | null = (selling?.selling_price != null && selling.selling_price > 0) ? selling.selling_price : null;
      const prevPlatformSellingPrice = selling?.prev_selling_price || null;

      // 수익률 = 1 - (매입가 / 판매가) — selling_price NULL 시 0
      const marginRate = (platformSellingPrice && platformSellingPrice > 0) ? 1 - purchasePrice / platformSellingPrice : 0;

      // 7일 매입가
      const prices7d = ph?.prices || [];
      const maxPrice7d = prices7d.length > 0 ? Math.max(...prices7d) : null;
      const todayPurchase = ph?.todayPrice || null;

      // 7일 동향 슬롯 (8개 날짜) — 실제 매입(actual) + 토큰 매칭 단위환산(inferred) 병합
      type GradeAnchor = {
        code: string;
        name: string;
        ratio: number;
        score: number;
        latestPrice: number;
        unitMatch: number;
        keyTierDiff: number;
        learnedTier: number | null;
      };
      const myTokens = tokenizeName(row.product_name);
      const myKeyTier = getGradeTier(row.product_name);
      const myLearnedTier = prod?.learned_tier ?? null;
      const sameGradeAnchors: GradeAnchor[] = [];
      const myPurchaseSource = prod?.purchase_source ?? null;
      if (myTokens.length > 0 && prod?.product_group) {
        const grpMembers = groupMembersMap.get(prod.product_group) || [];
        for (const m of grpMembers) {
          if (m.product_code === row.product_code) continue;
          // 매입처 풀 분리 — 다른 source 멤버는 1차 anchor 제외 (변동률은 2차에서 처리)
          if ((m.purchase_source ?? null) !== myPurchaseSource) continue;
          const conv = getUnitConversionRatio(m.unit, m.spec, row.unit, row.spec);
          if (!conv) continue;
          const score = gradeMatchScore(myTokens, tokenizeName(m.product_name));
          if (score === 0) continue;
          const memDates = (priceByDateAndCode.size > 0)
            ? slotDates.filter((d) => priceByDateAndCode.get(d)?.get(m.product_code) != null)
            : [];
          const latestDate = memDates.length > 0 ? memDates[memDates.length - 1] : null;
          const latestPrice = latestDate ? (priceByDateAndCode.get(latestDate)?.get(m.product_code) ?? 0) : 0;
          sameGradeAnchors.push({
            code: m.product_code,
            name: m.product_name || "",
            ratio: conv.ratio,
            score,
            latestPrice,
            unitMatch: m.unit === row.unit ? 0 : 1,
            keyTierDiff: Math.abs(getGradeTier(m.product_name) - myKeyTier),
            learnedTier: m.learned_tier ?? null,
          });
        }
      }

      // 정렬: 토큰 점수 ↓ → 같은 unit 우선 → 학습 tier diff ↑ → 키워드 tier diff ↑ → 가격 유사도 ↑ → product_code ↑
      const myRefPrice = purchasePrice > 0 ? purchasePrice : prevPurchase > 0 ? prevPurchase : 0;
      sameGradeAnchors.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.unitMatch !== b.unitMatch) return a.unitMatch - b.unitMatch;
        // 학습 tier diff (양쪽 다 있을 때 우선)
        if (myLearnedTier != null && a.learnedTier != null && b.learnedTier != null) {
          const aLD = Math.abs(a.learnedTier - myLearnedTier);
          const bLD = Math.abs(b.learnedTier - myLearnedTier);
          if (aLD !== bLD) return aLD - bLD;
        }
        // 키워드 tier diff fallback
        if (a.keyTierDiff !== b.keyTierDiff) return a.keyTierDiff - b.keyTierDiff;
        if (myRefPrice > 0 && a.latestPrice > 0 && b.latestPrice > 0) {
          const aDiff = Math.abs(a.latestPrice / a.ratio - myRefPrice);
          const bDiff = Math.abs(b.latestPrice / b.ratio - myRefPrice);
          if (aDiff !== bDiff) return aDiff - bDiff;
        }
        if (a.latestPrice > 0 && b.latestPrice <= 0) return -1;
        if (a.latestPrice <= 0 && b.latestPrice > 0) return 1;
        return a.code.localeCompare(b.code);
      });

      // 7일동향 빈 슬롯 보강 — 2단계
      //   1차: 동일 등급 anchor (score == myTokens.length) → 단위환산
      //   2차: 그룹 reference 의 (인접 known date → slot date) 변동률을 내 known price 에 적용
      //
      // 의도: 다른 등급(1점) anchor 의 매입가를 그대로 가져오지 않음 → basePP 부풀림 방지
      type SlotEntry = {
        date: string;
        price: number | null;
        source: "actual" | "inferred" | "ref_change" | "missing";
        anchor: string | null;
      };
      const exactGradeAnchors = sameGradeAnchors.filter((a) => a.score === myTokens.length);

      // 1차 패스 — actual + 동일 등급 anchor
      const slots: SlotEntry[] = slotDates.map((date) => {
        const actual = priceByDateAndCode.get(date)?.get(row.product_code);
        if (actual != null && actual > 0) {
          return { date, price: actual, source: "actual", anchor: null };
        }
        for (const a of exactGradeAnchors) {
          const ap = priceByDateAndCode.get(date)?.get(a.code);
          if (ap == null || ap <= 0) continue;
          return { date, price: ceil10(ap / a.ratio), source: "inferred", anchor: a.name };
        }
        return { date, price: null, source: "missing", anchor: null };
      });

      // 2차 패스 — reference 변동률 (1차 후 여전히 빈 슬롯)
      const refCode = prod?.product_group ? groupReferenceCode.get(prod.product_group) ?? null : null;
      if (refCode && refCode !== row.product_code) {
        const refName = productMap.get(refCode)?.product_name || refCode;
        const knownIdx: { idx: number; price: number }[] = [];
        slots.forEach((s, i) => {
          if (s.price != null) knownIdx.push({ idx: i, price: s.price });
        });
        if (knownIdx.length > 0) {
          for (let i = 0; i < slots.length; i++) {
            if (slots[i].price != null) continue;
            // 가장 가까운 known slot (인덱스 거리 최소)
            let nearest = knownIdx[0];
            let dist = Math.abs(nearest.idx - i);
            for (const k of knownIdx) {
              const d = Math.abs(k.idx - i);
              if (d < dist) { nearest = k; dist = d; }
            }
            const refAtNearest = priceByDateAndCode.get(slots[nearest.idx].date)?.get(refCode);
            const refAtSlot = priceByDateAndCode.get(slots[i].date)?.get(refCode);
            if (refAtNearest != null && refAtNearest > 0 && refAtSlot != null && refAtSlot > 0) {
              const changeRate = refAtSlot / refAtNearest;
              slots[i] = {
                date: slots[i].date,
                price: ceil10(nearest.price * changeRate),
                source: "ref_change",
                anchor: refName,
              };
            }
          }
        }
      }

      const purchaseHistory8d = slots;

      // AI Phase 1 입력용 short_history — slots 의 actual+inferred+ref_change 모두 사용
      const aiShortHistory: { date: string; price: number }[] = [];
      for (const s of slots) {
        if (s.price != null && s.price > 0) aiShortHistory.push({ date: s.date, price: s.price });
      }
      const actualHistoryEntries = shortHistoryMap.get(row.product_code) || [];
      const aiInputShortHistory = aiShortHistory.length > actualHistoryEntries.length
        ? aiShortHistory
        : actualHistoryEntries;

      // 수익률일괄변경용
      const targetMargin = prod?.target_margin_rate ? Number(prod.target_margin_rate) : null;
      // 수익률일괄변경시가격 = ROUNDUP(매입가 ÷ (1 - 목표수익률), -1)
      const targetPrice = targetMargin && targetMargin > 0 && purchasePrice > 0
        ? Math.ceil(purchasePrice / (1 - targetMargin / 100) / 10) * 10
        : null;

      // 신선행판매가 = MAX(식봄판매가 × 0.94, 매입가 ÷ 0.9)
      const sinsunhangPrice = (platformSellingPrice && platformSellingPrice > 0)
        ? Math.ceil(Math.max(platformSellingPrice * 0.94, purchasePrice / 0.9) / 10) * 10
        : null;
      const sinsunhangMargin = sinsunhangPrice && sinsunhangPrice > 0
        ? 1 - purchasePrice / sinsunhangPrice : null;

      // 배민판매가 = 식봄판매가
      const baeminPrice = platformSellingPrice || null;
      const baeminMargin = baeminPrice && baeminPrice > 0
        ? 1 - purchasePrice / baeminPrice : null;

      // 야채/공산 구분
      const productType = prod?.product_type || "공산";

      // Claude 추천판매가 — Phase 1~5 통합 로직 사용 (학습 세션과 동일)
      let recommendedPrice: number | null = null;
      let recommendReason = "";

      // 판매가 고정 — 자동 산출 skip, selling_price 를 추천가로 표시
      if (prod?.price_fixed) {
        recommendedPrice = selling?.selling_price ?? null;
        recommendReason = "판매가고정";
      } else if ((platformSellingPrice && platformSellingPrice > 0) || purchasePrice > 0) {
        // Phase 5-A / Layer 4-B: 같은 그룹 멤버 데이터 구성 (나 제외, spec/learned_tier 포함)
        const groupMembers = prod?.product_group
          ? (groupMembersMap.get(prod.product_group) || [])
              .filter((m) => m.product_code !== row.product_code)
              .map((m) => ({
                product_code: m.product_code,
                product_name: m.product_name || "",
                pack_role: (m.pack_role as "박스" | "소분" | null),
                pack_meta: m.pack_meta as never,
                unit: m.unit,
                spec: m.spec,
                learned_tier: m.learned_tier,
                purchase_source: m.purchase_source,
                short_history: shortHistoryMap.get(m.product_code) || [],
                long_history: longHistoryMap.get(m.product_code) || [],
              }))
          : [];

        const aiInput: AiRecInput = {
          purchase_price: purchasePrice,
          prev_purchase_price: prevPurchase,
          current_selling_price: platformSellingPrice ?? 0,
          prev_selling_price: prevPlatformSellingPrice || 0,
          target_margin_rate: targetMargin,
          is_key_item: prod?.is_key_item || false,
          price_sensitivity: (prod?.price_sensitivity as "예민" | "고정" | "일반" | null) || "일반",
          pack_role: (prod?.pack_role as "박스" | "소분" | null) || null,
          pack_meta: prod?.pack_meta as never,
          group_members: groupMembers,
          price_date: priceDate,
          unit: row.unit || undefined,
          product_name: row.product_name,
          spec: row.spec,
          learned_tier: prod?.learned_tier ?? null,
          short_history: aiInputShortHistory,
          long_history: longHistoryMap.get(row.product_code) || [],
          monthly_sales: recentSalesMap.get(row.product_code) || [],
          prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
          // PSP 과거 3개월 + MSQ 이번달 (시트 공식 기반 매출 판정)
          month_1_qty: selling?.month_1_qty || null,
          month_2_qty: selling?.month_2_qty || null,
          month_3_qty: selling?.month_3_qty || null,
          current_month_qty: monthlyQty,
          group_trend: null,
          product_group: prod?.product_group ?? null,
          tier_ratios: tierRatios,
          purchase_source: prod?.purchase_source ?? null,
        };
        const ai = calculateAiRecommendation(aiInput);
        recommendedPrice = ai.ai_price;
        recommendReason = extractShortReason(ai.ai_reason);
      }
      const recommendedMargin = recommendedPrice && purchasePrice > 0
        ? 1 - purchasePrice / recommendedPrice : null;

      return {
        product_code: row.product_code,
        product_name: row.product_name,
        spec: row.spec,
        unit: row.unit,
        category_name: row.category_name,
        price_date: priceDate,
        product_type: productType,
        platform_status: prod?.platform_status || null,
        price_fixed: !!prod?.price_fixed,

        product_group: prod?.product_group || null,
        is_key_item: prod?.is_key_item || false,
        is_event_item: prod?.is_event_item || false,
        target_margin_rate: targetMargin,

        prev_purchase_price: prevPurchase,
        purchase_price: purchasePrice,
        change_amount: changeAmount,
        change_rate: changeRate,

        purchase_prices_7d: prices7d,
        max_price_7d: maxPrice7d,
        today_purchase: todayPurchase,
        purchase_history_8d: purchaseHistory8d,

        prev_selling_price: prevPlatformSellingPrice,
        selling_price: platformSellingPrice,
        margin_rate: marginRate,

        target_price: targetPrice,

        recommended_price: recommendedPrice,
        recommended_margin: recommendedMargin,
        recommend_reason: recommendReason,

        learned_tier: prod?.learned_tier ?? null,
        pack_role: prod?.pack_role ?? null,
        pack_meta: prod?.pack_meta ?? null,

        sinsunhang_price: sinsunhangPrice,
        sinsunhang_margin: sinsunhangMargin,
        baemin_price: baeminPrice,
        baemin_margin: baeminMargin,

        monthly_qty: monthlyQty,
        // m1/m2/m3 = monthly_sales_quantity 동적 산출 (4채널 합계 기준) — priceDate 기준 -3/-2/-1 월
        month_1_qty: (() => {
          const t = totalData.get(row.product_code);
          return (t?.get(m1Month) ?? null) as number | null;
        })(),
        month_2_qty: (() => {
          const t = totalData.get(row.product_code);
          return (t?.get(m2Month) ?? null) as number | null;
        })(),
        month_3_qty: (() => {
          const t = totalData.get(row.product_code);
          return (t?.get(m3Month) ?? null) as number | null;
        })(),
        // 이번달 = total 4채널 합산 현재월
        current_month_qty: monthlyQty,
        // 3개월대비 — total 합계 기준 (기존 호환)
        prev_3month_pct: computePrev3MonthPct(
          (totalData.get(row.product_code)?.get(m1Month) ?? null),
          (totalData.get(row.product_code)?.get(m2Month) ?? null),
          (totalData.get(row.product_code)?.get(m3Month) ?? null),
          monthlyQty,
          priceDate
        ),
        // 채널별 3개월대비 — 5개 (식봄/신선행/온일장/배민/total)
        prev_3month_pct_sikbom: (() => {
          const c = channelData.get(row.product_code)?.get("식봄");
          return computePct(c?.get(m1Month) ?? null, c?.get(m2Month) ?? null, c?.get(m3Month) ?? null, c?.get(curMonth) ?? null);
        })(),
        prev_3month_pct_sinsunhang: (() => {
          const c = channelData.get(row.product_code)?.get("신선행");
          return computePct(c?.get(m1Month) ?? null, c?.get(m2Month) ?? null, c?.get(m3Month) ?? null, c?.get(curMonth) ?? null);
        })(),
        prev_3month_pct_oniljang: (() => {
          const c = channelData.get(row.product_code)?.get("온일장");
          return computePct(c?.get(m1Month) ?? null, c?.get(m2Month) ?? null, c?.get(m3Month) ?? null, c?.get(curMonth) ?? null);
        })(),
        prev_3month_pct_baemin: (() => {
          const c = channelData.get(row.product_code)?.get("배민");
          return computePct(c?.get(m1Month) ?? null, c?.get(m2Month) ?? null, c?.get(m3Month) ?? null, c?.get(curMonth) ?? null);
        })(),
        prev_3month_pct_total: computePct(
          totalData.get(row.product_code)?.get(m1Month) ?? null,
          totalData.get(row.product_code)?.get(m2Month) ?? null,
          totalData.get(row.product_code)?.get(m3Month) ?? null,
          monthlyQty,
        ),
        // 월 라벨 (UI 동적 표시용) — "2월", "3월" 형태 (앞 0 제거)
        month_1_label: parseInt(m1Month.slice(5, 7)) + "월",
        month_2_label: parseInt(m2Month.slice(5, 7)) + "월",
        month_3_label: parseInt(m3Month.slice(5, 7)) + "월",
      };
    });

    // 필터
    if (category && category !== "전체") {
      results = results.filter((r) => r.category_name === category);
    }
    if (group) {
      results = results.filter((r) => r.product_group === Number(group));
    }
    // 기본: 판매중만 / ?onlyInactive=1: 판매중지만 / ?fixedOnly=1: 판매가고정만
    const onlyInactive = url.searchParams.get("onlyInactive") === "1";
    const fixedOnly = url.searchParams.get("fixedOnly") === "1";
    if (onlyInactive) {
      results = results.filter((r) => r.platform_status === "판매중지");
    } else if (fixedOnly) {
      results = results.filter((r) => r.platform_status !== "판매중지" && r.price_fixed);
    } else {
      results = results.filter((r) => r.platform_status !== "판매중지");
    }

    return Response.json(results);
  } catch (err: unknown) {
    console.error("Products API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: `처리 중 오류: ${message}` }, { status: 500 });
  }
}
