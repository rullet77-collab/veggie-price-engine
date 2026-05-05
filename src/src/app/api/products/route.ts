import { supabase } from "@/lib/supabase";
import { calculateAiRecommendation, type AiRecInput, tokenizeName, gradeMatchScore, getGradeTier, getUnitConversionRatio, ceil10 } from "@/lib/aiRecommendation";
import { computePrev3MonthPct } from "@/lib/salesStats";

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

    // 1) 최신 날짜의 daily_product_management
    const { data: latestDate } = await supabase
      .from("daily_product_management")
      .select("price_date")
      .order("price_date", { ascending: false })
      .limit(1)
      .single();

    if (!latestDate) return Response.json([]);
    const priceDate = latestDate.price_date;

    // 2) 해당 날짜 전체 상품 (매입가 데이터)
    type MgmtRow = {
      product_code: string; price_date: string;
      purchase_price: number | null; selling_price: number | null;
      prev_purchase_price: number | null; prev_selling_price: number | null;
      product_name: string | null; spec: string | null;
      unit: string | null; category_name: string | null;
      major_category: string | null;
    };
    const mgmtData = await fetchAll<MgmtRow>(
      "daily_product_management",
      "product_code,price_date,purchase_price,selling_price,prev_purchase_price,prev_selling_price,product_name,spec,unit,category_name,major_category",
      (q) => q.eq("price_date", priceDate)
    );

    // 3) products 마스터 (Phase 5-A: pack_role, pack_meta / Layer 4-B: spec / 학습 tier)
    type ProdRow = {
      product_code: string; product_group: number | null;
      is_key_item: boolean; target_margin_rate: number | null;
      is_event_item: boolean; product_type: string | null;
      price_sensitivity: string | null;
      pack_role: string | null; pack_meta: unknown;
      product_name: string | null; unit: string | null;
      spec: string | null;
      learned_tier: number | null;
    };
    const productsData = await fetchAll<ProdRow>(
      "products",
      "product_code,product_group,is_key_item,target_margin_rate,is_event_item,product_type,price_sensitivity,pack_role,pack_meta,product_name,unit,spec,learned_tier"
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

    // 4) 플랫폼 판매가 + 월별 매출 통계
    // current_month_qty, prev_3month_pct 는 DB에 저장하지 않고 매번 계산 (single source of truth: monthly_sales_quantity)
    type SellingRow = {
      product_code: string; selling_price: number; prev_selling_price: number | null;
      month_1_qty: number | null; month_2_qty: number | null; month_3_qty: number | null;
    };
    const sellingData = await fetchAll<SellingRow>(
      "product_selling_prices",
      "product_code,selling_price,prev_selling_price,month_1_qty,month_2_qty,month_3_qty"
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

    const salesQtyMap = new Map<string, number>();  // 현재월 UI용
    const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
    const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
    const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
    const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);

    for (const ms of monthlySales) {
      if (ms.source && ms.source !== "전체") continue;
      const entry = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };

      if (ms.sale_month === monthStr) {
        salesQtyMap.set(ms.product_code, ms.quantity);
      }
      if (ms.sale_month >= recentStartStr) {
        if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
        recentSalesMap.get(ms.product_code)!.push(entry);
      } else if (ms.sale_month >= prevStartStr && ms.sale_month < prevEndStr) {
        if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
        prevSalesMap.get(ms.product_code)!.push(entry);
      }
    }

    // 7) 결과 조합
    let results = mgmtData.map((row) => {
      const prod = productMap.get(row.product_code);
      const selling = sellingMap.get(row.product_code);
      const ph = purchaseMap.get(row.product_code);
      const monthlyQty = salesQtyMap.get(row.product_code) || null;

      const purchasePrice = row.purchase_price || 0;
      const prevPurchase = row.prev_purchase_price || 0;

      // 변동률/변동액
      const changeAmount = prevPurchase > 0 ? purchasePrice - prevPurchase : 0;
      const changeRate = prevPurchase > 0 ? changeAmount / prevPurchase : 0;

      // 플랫폼 판매가 (product_selling_prices에서)
      const platformSellingPrice = selling?.selling_price || 0;
      const prevPlatformSellingPrice = selling?.prev_selling_price || null;

      // 수익률 = 1 - (매입가 / 판매가)
      const marginRate = platformSellingPrice > 0 ? 1 - purchasePrice / platformSellingPrice : 0;

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
      if (myTokens.length > 0 && prod?.product_group) {
        const grpMembers = groupMembersMap.get(prod.product_group) || [];
        for (const m of grpMembers) {
          if (m.product_code === row.product_code) continue;
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

      const purchaseHistory8d = slotDates.map((date) => {
        const actual = priceByDateAndCode.get(date)?.get(row.product_code);
        if (actual != null && actual > 0) {
          return { date, price: actual, source: "actual" as const, anchor: null };
        }
        // 빈 슬롯 → 정렬된 후보 순으로 첫 매칭 anchor 사용
        for (const a of sameGradeAnchors) {
          const anchorPrice = priceByDateAndCode.get(date)?.get(a.code);
          if (anchorPrice == null || anchorPrice <= 0) continue;
          return {
            date,
            price: ceil10(anchorPrice / a.ratio),
            source: "inferred" as const,
            anchor: a.name,
          };
        }
        return { date, price: null, source: "missing" as const, anchor: null };
      });

      // AI Phase 1 입력용 short_history 보강 — 같은 unit + ratio ≤ 2 (박스↔박스, 박스↔반박스)
      // 만 사용해서 cross-unit (1kg봉 같은 ratio=10) 노이즈 제외
      const aiInferAnchors = sameGradeAnchors.filter((a) => a.ratio >= 0.5 && a.ratio <= 2);
      const aiShortHistory: { date: string; price: number }[] = [];
      let inferredCount = 0;
      for (const date of slotDates) {
        const actual = priceByDateAndCode.get(date)?.get(row.product_code);
        if (actual != null && actual > 0) {
          aiShortHistory.push({ date, price: actual });
          continue;
        }
        for (const a of aiInferAnchors) {
          const ap = priceByDateAndCode.get(date)?.get(a.code);
          if (ap != null && ap > 0) {
            aiShortHistory.push({ date, price: ceil10(ap / a.ratio) });
            inferredCount++;
            break;
          }
        }
      }
      // 보강 데이터가 actualHistory 보다 풍부할 때만 사용
      const actualHistoryEntries = shortHistoryMap.get(row.product_code) || [];
      const aiInputShortHistory = aiShortHistory.length > actualHistoryEntries.length
        ? aiShortHistory
        : actualHistoryEntries;
      void inferredCount;  // future: ai_reason 에 표기용

      // 수익률일괄변경용
      const targetMargin = prod?.target_margin_rate ? Number(prod.target_margin_rate) : null;
      // 수익률일괄변경시가격 = ROUNDUP(매입가 ÷ (1 - 목표수익률), -1)
      const targetPrice = targetMargin && targetMargin > 0 && purchasePrice > 0
        ? Math.ceil(purchasePrice / (1 - targetMargin / 100) / 10) * 10
        : null;

      // 신선행판매가 = MAX(식봄판매가 × 0.94, 매입가 ÷ 0.9)
      const sinsunhangPrice = platformSellingPrice > 0
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
      if (platformSellingPrice > 0 || purchasePrice > 0) {
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
                short_history: shortHistoryMap.get(m.product_code) || [],
                long_history: longHistoryMap.get(m.product_code) || [],
              }))
          : [];

        const aiInput: AiRecInput = {
          purchase_price: purchasePrice,
          prev_purchase_price: prevPurchase,
          current_selling_price: platformSellingPrice,
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
        price_date: row.price_date,
        product_type: productType,

        product_group: prod?.product_group || null,
        is_key_item: prod?.is_key_item || false,
        is_event_item: prod?.is_event_item || false,
        target_margin_rate: targetMargin,

        prev_purchase_price: row.prev_purchase_price,
        purchase_price: row.purchase_price,
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

        sinsunhang_price: sinsunhangPrice,
        sinsunhang_margin: sinsunhangMargin,
        baemin_price: baeminPrice,
        baemin_margin: baeminMargin,

        monthly_qty: monthlyQty,
        month_1_qty: selling?.month_1_qty || null,
        month_2_qty: selling?.month_2_qty || null,
        month_3_qty: selling?.month_3_qty || null,
        // 이번달 = monthly_sales_quantity(전체, 현재월) 원본 기준
        current_month_qty: monthlyQty,
        // 3개월대비 = (월말 예상 - avg(1~3월)) / avg(1~3월)
        prev_3month_pct: computePrev3MonthPct(
          selling?.month_1_qty || null,
          selling?.month_2_qty || null,
          selling?.month_3_qty || null,
          monthlyQty,
          priceDate
        ),
      };
    });

    // 필터
    if (category && category !== "전체") {
      results = results.filter((r) => r.category_name === category);
    }
    if (group) {
      results = results.filter((r) => r.product_group === Number(group));
    }

    return Response.json(results);
  } catch (err: unknown) {
    console.error("Products API error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: `처리 중 오류: ${message}` }, { status: 500 });
  }
}
