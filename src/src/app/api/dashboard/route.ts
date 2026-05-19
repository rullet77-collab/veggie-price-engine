// 대시보드 — 오늘 매입 등락 TOP10 + 이번달 매출 상/하위 (채널별 + 토탈)
// 야채 판매중 상품만 대상. 매입 등락에는 박스소분 89개 상품을 sibling 역산값으로 포함.
import { supabase } from "@/lib/supabase";
import { boxToSubdiv, subdivToBox, ceil10, type PackMeta } from "@/lib/aiRecommendation";

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

type Yacai = {
  product_code: string;
  product_name: string | null;
  spec: string | null;
  platform_status: string | null;
  product_group: number | null;
  pack_role: string | null;
  pack_meta: unknown;
};

type PurchRow = {
  product_code: string;
  price_date: string;
  purchase_price: number;
};

type SalesRow = {
  product_code: string;
  sale_month: string;
  quantity: number | null;
  source: string | null;
};

type VolatileItem = {
  product_code: string;
  product_name: string;
  spec: string | null;
  today_price: number;
  prev_price: number;
  prev_date: string;
  change_rate: number;
  change_amount: number;
  derived: boolean;        // true = 박스소분 sibling 역산값
  anchor_name?: string;    // 역산 anchor 상품명
};

type SalesItem = {
  product_code: string;
  product_name: string;
  spec: string | null;
  quantity: number;
};

const CHANNELS = ["식봄", "신선행", "온일장", "배민"] as const;
type Channel = (typeof CHANNELS)[number];

export async function GET() {
  try {
    // 1) priceDate (오늘 = daily_purchase_prices.max)
    const { data: pd } = await supabase
      .from("daily_purchase_prices")
      .select("price_date")
      .order("price_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const priceDate = (pd as { price_date: string } | null)?.price_date ?? null;
    if (!priceDate) {
      return Response.json({
        price_date: null, month: null,
        volatile_top10: [], sales_top: {}, sales_bottom: {},
      });
    }
    const monthStart = priceDate.slice(0, 7) + "-01";

    // 2) 야채 판매중 상품
    const yacai = await fetchAll<Yacai>(
      "products",
      "product_code,product_name,spec,platform_status,product_group,pack_role,pack_meta",
      (q) => q.eq("product_type", "야채")
    );
    const active = yacai.filter((p) => p.platform_status !== "판매중지");
    const activeSet = new Set(active.map((p) => p.product_code));
    const yacaiMap = new Map(active.map((p) => [p.product_code, p]));

    // 그룹별 멤버 인덱스 (박스소분 sibling 역산용)
    const groupMembers = new Map<number, Yacai[]>();
    for (const p of active) {
      if (p.product_group == null) continue;
      if (!groupMembers.has(p.product_group)) groupMembers.set(p.product_group, []);
      groupMembers.get(p.product_group)!.push(p);
    }

    // 3) 매입 등락 — 14일 윈도우 → distinct date 별 MAX → 최신 2개 비교
    const lookback = new Date(priceDate);
    lookback.setDate(lookback.getDate() - 14);
    const lookbackStr = lookback.toISOString().slice(0, 10);
    const purchRows = await fetchAll<PurchRow>(
      "daily_purchase_prices",
      "product_code,price_date,purchase_price",
      (q) => q.gte("price_date", lookbackStr).lte("price_date", priceDate)
    );

    // code → date → max(purchase_price)
    const byCode = new Map<string, Map<string, number>>();
    for (const r of purchRows) {
      if (!activeSet.has(r.product_code)) continue;
      if (!byCode.has(r.product_code)) byCode.set(r.product_code, new Map());
      const m = byCode.get(r.product_code)!;
      m.set(r.price_date, Math.max(m.get(r.price_date) ?? 0, r.purchase_price));
    }

    const volatileAll: VolatileItem[] = [];
    for (const [code, m] of byCode) {
      const dates = [...m.keys()].sort();
      if (dates.length < 2) continue;
      const todayDate = dates[dates.length - 1];
      if (todayDate !== priceDate) continue; // 오늘 매입 없는 상품 제외
      const today = m.get(todayDate)!;
      const prevDate = dates[dates.length - 2];
      const prev = m.get(prevDate)!;
      if (prev <= 0 || today <= 0) continue;
      const rate = (today - prev) / prev;
      if (rate === 0) continue;
      const prod = yacaiMap.get(code)!;
      volatileAll.push({
        product_code: code,
        product_name: prod.product_name || "",
        spec: prod.spec,
        today_price: today,
        prev_price: prev,
        prev_date: prevDate,
        change_rate: rate,
        change_amount: today - prev,
        derived: false,
      });
    }

    // 3.5) 박스소분 89개 — daily 없는 상품은 sibling 매입가에서 역산
    const priceDateObj = new Date(priceDate);
    const convertSibToMine = (sibPrice: number, sib: Yacai, mine: Yacai): number | null => {
      const sm = (mine.pack_meta ?? null) as PackMeta | null;
      const ss = (sib.pack_meta ?? null) as PackMeta | null;
      if (!sm || !ss) return null;
      if (sib.pack_role === "박스" && mine.pack_role === "소분") {
        return boxToSubdiv(sibPrice, ss, sm, priceDateObj);
      }
      if (sib.pack_role === "소분" && mine.pack_role === "박스") {
        return subdivToBox(sibPrice, ss, sm, priceDateObj);
      }
      if (sib.pack_role === "소분" && mine.pack_role === "소분") {
        if ("quantity" in ss && "quantity" in sm && ss.quantity > 0) {
          return ceil10(sibPrice / ss.quantity * sm.quantity);
        }
      }
      if (sib.pack_role === "박스" && mine.pack_role === "박스") return sibPrice;
      return null;
    };

    const inVolatile = new Set(volatileAll.map((v) => v.product_code));
    const packProducts = active.filter(
      (p) => p.pack_role && p.pack_meta && p.product_group != null
    );
    for (const me of packProducts) {
      if (inVolatile.has(me.product_code)) continue;
      const sibs = (groupMembers.get(me.product_group!) || []).filter(
        (s) => s.product_code !== me.product_code && s.pack_role && s.pack_meta
      );
      let best: { sib: Yacai; today: number; prev: number; prevDate: string; cnt: number } | null = null;
      for (const sib of sibs) {
        const sibMap = byCode.get(sib.product_code);
        if (!sibMap) continue;
        const sibDates = [...sibMap.keys()].sort();
        if (sibDates.length < 2) continue;
        if (sibDates[sibDates.length - 1] !== priceDate) continue;
        const sibPrevDate = sibDates[sibDates.length - 2];
        const sibToday = sibMap.get(priceDate)!;
        const sibPrev = sibMap.get(sibPrevDate)!;
        if (sibToday <= 0 || sibPrev <= 0) continue;
        if (!best || sibDates.length > best.cnt) {
          best = { sib, today: sibToday, prev: sibPrev, prevDate: sibPrevDate, cnt: sibDates.length };
        }
      }
      if (!best) continue;
      const myToday = convertSibToMine(best.today, best.sib, me);
      const myPrev = convertSibToMine(best.prev, best.sib, me);
      if (myToday == null || myPrev == null || myToday <= 0 || myPrev <= 0 || myToday === myPrev) continue;
      const rate = (myToday - myPrev) / myPrev;
      volatileAll.push({
        product_code: me.product_code,
        product_name: me.product_name || "",
        spec: me.spec,
        today_price: myToday,
        prev_price: myPrev,
        prev_date: best.prevDate,
        change_rate: rate,
        change_amount: myToday - myPrev,
        derived: true,
        anchor_name: best.sib.product_name || best.sib.product_code,
      });
    }

    volatileAll.sort((a, b) => Math.abs(b.change_rate) - Math.abs(a.change_rate));
    const volatile_top10 = volatileAll.slice(0, 10);

    // 4) 이번달 매출 — 채널별 집계
    const salesRows = await fetchAll<SalesRow>(
      "monthly_sales_quantity",
      "product_code,sale_month,quantity,source",
      (q) => q.eq("sale_month", monthStart)
    );

    const byChannel: Record<Channel, Map<string, number>> = {
      "식봄": new Map(), "신선행": new Map(), "온일장": new Map(), "배민": new Map(),
    };
    const totalAgg = new Map<string, number>();

    for (const r of salesRows) {
      if (!activeSet.has(r.product_code)) continue;
      if (!r.source) continue;
      if (!CHANNELS.includes(r.source as Channel)) continue;
      const qty = r.quantity || 0;
      if (qty <= 0) continue;
      const ch = r.source as Channel;
      byChannel[ch].set(r.product_code, (byChannel[ch].get(r.product_code) || 0) + qty);
      totalAgg.set(r.product_code, (totalAgg.get(r.product_code) || 0) + qty);
    }

    const toRanked = (agg: Map<string, number>, asc: boolean): SalesItem[] => {
      const arr: SalesItem[] = [...agg.entries()].map(([code, qty]) => {
        const p = yacaiMap.get(code)!;
        return {
          product_code: code,
          product_name: p.product_name || "",
          spec: p.spec,
          quantity: qty,
        };
      });
      arr.sort((a, b) => asc ? a.quantity - b.quantity : b.quantity - a.quantity);
      return arr.slice(0, 10);
    };

    const sales_top: Record<string, SalesItem[]> = {};
    const sales_bottom: Record<string, SalesItem[]> = {};
    for (const c of CHANNELS) {
      sales_top[c] = toRanked(byChannel[c], false);
      sales_bottom[c] = toRanked(byChannel[c], true);
    }
    sales_top.total = toRanked(totalAgg, false);
    sales_bottom.total = toRanked(totalAgg, true);

    return Response.json({
      price_date: priceDate,
      month: priceDate.slice(0, 7),
      volatile_top10,
      sales_top,
      sales_bottom,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
