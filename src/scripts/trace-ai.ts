// ────────────────────────────────────────────────
// Phase 1~5-A 전체 로직 트레이스 (CLI)
//
// 사용법:
//   npx tsx scripts/trace-ai.ts 005045 007751
//   npx tsx scripts/trace-ai.ts 005045 --date=2026-04-22
//
// 출력: 각 상품별 입력(매입/판매/PSP/MSQ/그룹멤버) + AI reason 전문 + 최종가/수익률
// ────────────────────────────────────────────────
import { calculateAiRecommendation, type AiRecInput, type GroupMember } from "../src/lib/aiRecommendation";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function getKey(): Promise<string> {
  const fs = await import("fs");
  const path = "C:/Users/y/Videos/판매가변경영상/src/.env.local";
  const env = fs.readFileSync(path, "utf-8");
  const m = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  if (!m) throw new Error(`.env.local 에 NEXT_PUBLIC_SUPABASE_ANON_KEY 없음`);
  return m[1].trim();
}

async function rest<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

type ProdRow = {
  product_code: string; product_name: string; unit: string | null;
  spec: string | null;
  product_group: number | null; is_key_item: boolean;
  target_margin_rate: number | null; price_sensitivity: string | null;
  pack_role: string | null; pack_meta: unknown;
};
type MgmtRow = { purchase_price: number | null; prev_purchase_price: number | null; price_date: string };
type PspRow = { selling_price: number | null; prev_selling_price: number | null;
  month_1_qty: number | null; month_2_qty: number | null; month_3_qty: number | null };
type PurchRow = { product_code: string; price_date: string; purchase_price: number };
type MsqRow = { product_code: string; sale_month: string; quantity: number; source: string | null };

async function traceCode(code: string, key: string, priceDate: string) {
  // 1) products 마스터
  const prods = await rest<ProdRow[]>(
    `products?product_code=eq.${code}&select=product_code,product_name,unit,spec,product_group,is_key_item,target_margin_rate,price_sensitivity,pack_role,pack_meta`, key);
  const prod = prods[0];
  if (!prod) { console.log(`${code}: products 없음`); return; }

  // 2) 오늘 매입
  const mgmts = await rest<MgmtRow[]>(
    `daily_product_management?product_code=eq.${code}&price_date=eq.${priceDate}&select=purchase_price,prev_purchase_price,price_date`, key);
  const mgmt = mgmts[0];
  if (!mgmt) { console.log(`${code}: ${priceDate} daily_product_management 없음`); return; }

  // 3) PSP
  const psps = await rest<PspRow[]>(
    `product_selling_prices?product_code=eq.${code}&select=selling_price,prev_selling_price,month_1_qty,month_2_qty,month_3_qty`, key);
  const psp = psps[0];

  // 4) 매입 이력 60일 (장기/단기)
  const sixtyAgo = new Date(priceDate); sixtyAgo.setDate(sixtyAgo.getDate() - 60);
  const eightAgo = new Date(priceDate); eightAgo.setDate(eightAgo.getDate() - 8);
  const sixtyStr = sixtyAgo.toISOString().slice(0, 10);
  const eightStr = eightAgo.toISOString().slice(0, 10);
  const ph = await rest<PurchRow[]>(
    `daily_purchase_prices?product_code=eq.${code}&price_date=gte.${sixtyStr}&price_date=lte.${priceDate}&order=price_date.asc&select=product_code,price_date,purchase_price`, key);
  const shortHistory = ph.filter((h) => h.price_date >= eightStr).map((h) => ({ date: h.price_date, price: h.purchase_price }));
  const longHistory = ph.map((h) => ({ date: h.price_date, price: h.purchase_price }));

  // 5) MSQ 이번달 (시트 공식용)
  const curMonthStart = priceDate.slice(0, 7) + "-01";
  const msq = await rest<MsqRow[]>(
    `monthly_sales_quantity?product_code=eq.${code}&sale_month=eq.${curMonthStart}&select=product_code,sale_month,quantity,source`, key);
  const curMonthQty = msq.find((m) => !m.source || m.source === "전체")?.quantity ?? null;

  // 6) 그룹 멤버 (Phase 5-A)
  let groupMembers: GroupMember[] = [];
  if (prod.product_group) {
    const mems = await rest<ProdRow[]>(
      `products?product_group=eq.${prod.product_group}&product_code=neq.${code}&select=product_code,product_name,unit,spec,pack_role,pack_meta`, key);
    if (mems.length > 0) {
      const memCodes = mems.map((m) => m.product_code).join(",");
      const memPh = await rest<PurchRow[]>(
        `daily_purchase_prices?product_code=in.(${memCodes})&price_date=gte.${sixtyStr}&price_date=lte.${priceDate}&order=price_date.asc&select=product_code,price_date,purchase_price`, key);
      const byCode = new Map<string, PurchRow[]>();
      for (const p of memPh) {
        if (!byCode.has(p.product_code)) byCode.set(p.product_code, []);
        byCode.get(p.product_code)!.push(p);
      }
      groupMembers = mems.map((m) => {
        const hist = byCode.get(m.product_code) || [];
        return {
          product_code: m.product_code, product_name: m.product_name,
          pack_role: m.pack_role as "박스" | "소분" | null,
          pack_meta: m.pack_meta as never, unit: m.unit, spec: m.spec,
          short_history: hist.filter((h) => h.price_date >= eightStr).map((h) => ({ date: h.price_date, price: h.purchase_price })),
          long_history: hist.map((h) => ({ date: h.price_date, price: h.purchase_price })),
        };
      });
    }
  }

  // 7) 계산
  const input: AiRecInput = {
    purchase_price: mgmt.purchase_price || 0,
    prev_purchase_price: mgmt.prev_purchase_price || 0,
    current_selling_price: psp?.selling_price || 0,
    prev_selling_price: psp?.prev_selling_price || 0,
    target_margin_rate: prod.target_margin_rate ? Number(prod.target_margin_rate) : null,
    is_key_item: prod.is_key_item,
    price_sensitivity: (prod.price_sensitivity as "예민" | "고정" | "일반") || "일반",
    pack_role: (prod.pack_role as "박스" | "소분" | null) || null,
    pack_meta: prod.pack_meta as never,
    group_members: groupMembers,
    price_date: priceDate,
    unit: prod.unit || undefined,
    product_name: prod.product_name,
    spec: prod.spec,
    short_history: shortHistory,
    long_history: longHistory,
    monthly_sales: [],
    prev_monthly_sales: [],
    month_1_qty: psp?.month_1_qty ?? null,
    month_2_qty: psp?.month_2_qty ?? null,
    month_3_qty: psp?.month_3_qty ?? null,
    current_month_qty: curMonthQty,
    group_trend: null,
  };

  const out = calculateAiRecommendation(input);
  const recMargin = out.ai_price > 0 ? (1 - input.purchase_price / out.ai_price) * 100 : 0;
  const curMargin = input.current_selling_price > 0 ? (1 - input.purchase_price / input.current_selling_price) * 100 : 0;

  console.log("\n" + "═".repeat(80));
  console.log(`[${code}] ${prod.product_name} / ${prod.unit || "-"} / ${priceDate}`);
  console.log("═".repeat(80));
  console.log(`[입력 요약]`);
  console.log(`  매입:  오늘 ${input.purchase_price.toLocaleString()}원 (전일 ${input.prev_purchase_price.toLocaleString()}원)`);
  console.log(`  판매:  현재 ${input.current_selling_price.toLocaleString()}원 (전 ${input.prev_selling_price.toLocaleString()}원)  수익률 ${curMargin.toFixed(1)}%`);
  console.log(`  기준:  수익률 ${input.target_margin_rate}% / 민감도 ${input.price_sensitivity} / 경쟁 ${input.is_key_item}`);
  console.log(`  pack:  ${input.pack_role ?? "-"} ${JSON.stringify(input.pack_meta) || ""}`);
  console.log(`  그룹:  group=${prod.product_group ?? "-"}  멤버 ${groupMembers.length}개 (${groupMembers.map(m=>m.product_code).join(",") || "-"})`);
  console.log(`  매입이력: 8일 ${shortHistory.length}건  /  60일 ${longHistory.length}건`);
  console.log(`    ${shortHistory.map(h => `${h.date.slice(5)}=${h.price.toLocaleString()}`).join(", ")}`);
  console.log(`  매출:  m1(3개월전)=${input.month_1_qty} / m2(2개월전)=${input.month_2_qty} / m3(1개월전)=${input.month_3_qty} / 이번달=${input.current_month_qty}`);

  console.log(`\n[AI 판정]`);
  console.log(`  추천가:  ${out.ai_price.toLocaleString()}원   (수익률 ${recMargin.toFixed(1)}%, 기준 대비 ${(recMargin - Number(input.target_margin_rate || 0)).toFixed(1)}%p)`);
  console.log(`  신호:    short=${out.signals.short_trend} / sales=${out.signals.sales_trend} (${out.signals.sales_change_pct != null ? (out.signals.sales_change_pct * 100).toFixed(2) + "%" : "-"}) / support=${out.signals.long_support ?? "-"} / resist=${out.signals.long_resistance ?? "-"}`);
  console.log(`  purchase_change: ${(out.signals.purchase_change_pct * 100).toFixed(2)}%  current_margin: ${(out.signals.current_margin * 100).toFixed(1)}%`);
  console.log(`\n[AI reason 전문]`);
  out.ai_reason.split(". ").forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
}

async function main() {
  const argv = process.argv.slice(2);
  const dateArg = argv.find((a) => a.startsWith("--date="))?.split("=")[1];
  const codes = argv.filter((a) => !a.startsWith("--"));
  if (codes.length === 0) {
    console.error("사용법: npx tsx scripts/trace-ai.ts <product_code> [<product_code>...] [--date=YYYY-MM-DD]");
    process.exit(1);
  }

  const key = await getKey();

  let priceDate = dateArg;
  if (!priceDate) {
    const latest = await rest<{ price_date: string }[]>(
      `daily_product_management?select=price_date&order=price_date.desc&limit=1`, key);
    priceDate = latest[0]?.price_date;
    if (!priceDate) throw new Error("daily_product_management 비어있음");
  }
  console.log(`priceDate = ${priceDate}`);

  for (const code of codes) {
    try { await traceCode(code, key, priceDate); }
    catch (e) { console.error(`${code}: ${(e as Error).message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
