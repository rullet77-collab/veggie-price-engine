// 현재 판매가 vs AI 추천가 일치율 분석
// 전체 야채 상품에 대해 AI 추천을 계산하고 사용자 설정가와 비교

import { calculateAiRecommendation, type AiRecInput } from "../src/lib/aiRecommendation";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function fetchKey(): Promise<string> {
  const fs = await import("fs");
  const envPath = "C:/Users/y/Videos/판매가변경영상/src/.env.local";
  const envContent = fs.readFileSync(envPath, "utf-8");
  const match = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  return match ? match[1].trim() : "";
}

async function query<T>(path: string, key: string): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${SUPABASE_URL}/rest/v1/${path}${sep}offset=${from}&limit=${PAGE}`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const data: T[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  const key = await fetchKey();
  if (!key) throw new Error("Supabase key not found");

  console.log("📦 데이터 조회 중...\n");

  // 최신 날짜 찾기
  const latestRes = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_product_management?select=price_date&order=price_date.desc&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const latest = await latestRes.json();
  const priceDate = latest[0]?.price_date;
  console.log(`기준일: ${priceDate}\n`);

  // 1) 오늘자 매입 데이터
  type MgmtRow = {
    product_code: string; price_date: string;
    purchase_price: number | null; prev_purchase_price: number | null;
    product_name: string | null; category_name: string | null;
  };
  const mgmtData = await query<MgmtRow>(
    `daily_product_management?price_date=eq.${priceDate}&select=product_code,price_date,purchase_price,prev_purchase_price,product_name,category_name`,
    key
  );

  // 2) 상품 마스터
  type ProdRow = {
    product_code: string; product_group: number | null;
    is_key_item: boolean; target_margin_rate: number | null;
    product_type: string | null; price_sensitivity: string | null;
  };
  const allProducts = await query<ProdRow>(
    `products?select=product_code,product_group,is_key_item,target_margin_rate,product_type,price_sensitivity`,
    key
  );
  const prodMap = new Map<string, ProdRow>();
  for (const p of allProducts) prodMap.set(p.product_code, p);
  const vegeCodes = new Set(allProducts.filter((p) => p.product_type === "야채").map((p) => p.product_code));

  // 3) 판매가
  type SellingRow = {
    product_code: string; selling_price: number; prev_selling_price: number | null;
  };
  const sellingData = await query<SellingRow>(
    `product_selling_prices?select=product_code,selling_price,prev_selling_price`,
    key
  );
  const sellingMap = new Map<string, SellingRow>();
  for (const s of sellingData) sellingMap.set(s.product_code, s);

  // 4) 8일 매입이력
  const eightDaysAgo = new Date(priceDate);
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  const sixtyDaysAgo = new Date(priceDate);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  type PurchRow = { product_code: string; price_date: string; purchase_price: number };
  const longHistory = await query<PurchRow>(
    `daily_purchase_prices?price_date=gte.${sixtyDaysAgo.toISOString().slice(0, 10)}&price_date=lte.${priceDate}&order=price_date.asc&select=product_code,price_date,purchase_price`,
    key
  );

  const longMap = new Map<string, { date: string; price: number }[]>();
  const shortMap = new Map<string, { date: string; price: number }[]>();
  const eightDaysAgoStr = eightDaysAgo.toISOString().slice(0, 10);
  for (const ph of longHistory) {
    const entry = { date: ph.price_date, price: ph.purchase_price };
    if (!longMap.has(ph.product_code)) longMap.set(ph.product_code, []);
    longMap.get(ph.product_code)!.push(entry);
    if (ph.price_date >= eightDaysAgoStr) {
      if (!shortMap.has(ph.product_code)) shortMap.set(ph.product_code, []);
      shortMap.get(ph.product_code)!.push(entry);
    }
  }

  // 5) 월별 매출 수량
  const priceDateObj = new Date(priceDate);
  const recentMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);
  const prevMonthStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1);
  const prevMonthEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1);

  type MonthlyRow = { product_code: string; sale_month: string; quantity: number; source: string };
  const monthlySales = await query<MonthlyRow>(
    `monthly_sales_quantity?sale_month=gte.${prevMonthStart.toISOString().slice(0, 10)}&select=product_code,sale_month,quantity,source`,
    key
  );

  const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const recentStartStr = recentMonthStart.toISOString().slice(0, 10);
  const prevStartStr = prevMonthStart.toISOString().slice(0, 10);
  const prevEndStr = prevMonthEnd.toISOString().slice(0, 10);
  for (const ms of monthlySales) {
    if (ms.source && ms.source !== "전체") continue;
    const entry = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };
    if (ms.sale_month >= recentStartStr) {
      if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
      recentSalesMap.get(ms.product_code)!.push(entry);
    } else if (ms.sale_month >= prevStartStr && ms.sale_month < prevEndStr) {
      if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
      prevSalesMap.get(ms.product_code)!.push(entry);
    }
  }

  // AI 추천 계산 & 비교
  type Result = {
    code: string; name: string; purchase: number; user: number; ai: number;
    diff: number; diffPct: number; userMargin: number; aiMargin: number;
    category: string; sensitivity: string;
    historyDays: number;  // 8일 이력 일수
  };
  const results: Result[] = [];

  for (const row of mgmtData) {
    if (!vegeCodes.has(row.product_code)) continue;
    const prod = prodMap.get(row.product_code);
    const selling = sellingMap.get(row.product_code);
    if (!selling || !row.purchase_price) continue;

    const priceSensitivity = (prod?.price_sensitivity as "예민" | "고정" | "일반" | null) || "일반";

    const aiInput: AiRecInput = {
      purchase_price: row.purchase_price,
      prev_purchase_price: row.prev_purchase_price || 0,
      current_selling_price: selling.selling_price,
      prev_selling_price: selling.prev_selling_price || 0,
      target_margin_rate: prod?.target_margin_rate ? Number(prod.target_margin_rate) : null,
      is_key_item: prod?.is_key_item || false,
      price_sensitivity: priceSensitivity,
      short_history: shortMap.get(row.product_code) || [],
      long_history: longMap.get(row.product_code) || [],
      monthly_sales: recentSalesMap.get(row.product_code) || [],
      prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
      group_trend: null,
    };

    const { ai_price } = calculateAiRecommendation(aiInput);
    const userPrice = selling.selling_price;
    const diff = ai_price - userPrice;
    const diffPct = userPrice > 0 ? (diff / userPrice) * 100 : 0;
    const userMargin = userPrice > 0 ? (1 - row.purchase_price / userPrice) * 100 : 0;
    const aiMargin = ai_price > 0 ? (1 - row.purchase_price / ai_price) * 100 : 0;

    results.push({
      code: row.product_code,
      name: row.product_name || "",
      purchase: row.purchase_price,
      user: userPrice,
      ai: ai_price,
      diff,
      diffPct,
      userMargin,
      aiMargin,
      category: row.category_name || "",
      sensitivity: priceSensitivity,
      historyDays: aiInput.short_history.length,
    });
  }

  // 분석 출력
  console.log(`📊 총 ${results.length}개 야채 상품 분석`);

  // 8일 중 이력 일수 분포
  const histDist = new Map<number, number>();
  for (const r of results) histDist.set(r.historyDays, (histDist.get(r.historyDays) || 0) + 1);
  console.log(`\n=== 매입 이력 분포 (8일 중) ===`);
  for (let d = 0; d <= 8; d++) {
    const c = histDist.get(d) || 0;
    if (c > 0) console.log(`  ${d}일: ${c}건 (${((c / results.length) * 100).toFixed(1)}%)`);
  }

  // 5일 이상 이력 있는 품목만 (적정매입가 판단 가능)
  const reliable = results.filter((r) => r.historyDays >= 5);
  console.log(`\n=== 🎯 이력 5일+ (적정매입가 판단 가능) — ${reliable.length}건 ===`);
  printStats(reliable);

  // 전체
  console.log(`\n\n=== 전체 ${results.length}건 ===`);
  printStats(results);

  function printStats(arr: Result[]) {
    if (arr.length === 0) { console.log("  없음"); return; }
    const exact = arr.filter((r) => r.user === r.ai).length;
    const within100 = arr.filter((r) => Math.abs(r.diff) <= 100).length;
    const within500 = arr.filter((r) => Math.abs(r.diff) <= 500).length;
    const within1000 = arr.filter((r) => Math.abs(r.diff) <= 1000).length;
    const within3pct = arr.filter((r) => Math.abs(r.diffPct) <= 3).length;
    const within5pct = arr.filter((r) => Math.abs(r.diffPct) <= 5).length;
    const within10pct = arr.filter((r) => Math.abs(r.diffPct) <= 10).length;
    const aiHigher = arr.filter((r) => r.ai > r.user).length;
    const aiLower = arr.filter((r) => r.ai < r.user).length;

    console.log(`  정확히 일치:  ${exact}건 (${((exact / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±100원:     ${within100}건 (${((within100 / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±500원:     ${within500}건 (${((within500 / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±1,000원:   ${within1000}건 (${((within1000 / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±3%:       ${within3pct}건 (${((within3pct / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±5%:       ${within5pct}건 (${((within5pct / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  ±10%:      ${within10pct}건 (${((within10pct / arr.length) * 100).toFixed(1)}%)`);
    console.log(`  AI 더 높음: ${aiHigher}건 (${((aiHigher / arr.length) * 100).toFixed(1)}%) / 더 낮음: ${aiLower}건 (${((aiLower / arr.length) * 100).toFixed(1)}%)`);

    // 민감도별
    for (const ps of ["예민", "고정", "일반"]) {
      const subset = arr.filter((r) => r.sensitivity === ps);
      if (subset.length === 0) continue;
      const matched = subset.filter((r) => Math.abs(r.diffPct) <= 5).length;
      console.log(`  ${ps}: ${matched}/${subset.length}건 ±5% 일치 (${((matched / subset.length) * 100).toFixed(1)}%)`);
    }

    const avgUserM = arr.reduce((s, r) => s + r.userMargin, 0) / arr.length;
    const avgAiM = arr.reduce((s, r) => s + r.aiMargin, 0) / arr.length;
    console.log(`  사용자 평균 수익률 ${avgUserM.toFixed(1)}% / AI 평균 수익률 ${avgAiM.toFixed(1)}%`);
  }

  // 이력 5일+ 품목 중 차이 큰 케이스 TOP 20
  const sortedByDiff = [...reliable].sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));
  console.log("\n=== 🎯 이력 5일+ 중 차이 큰 케이스 TOP 20 ===");
  console.log("코드   | 상품명                               | 이력 | 매입    | 사용자  | AI      | 차이     | 사용자% | AI%");
  for (const r of sortedByDiff.slice(0, 20)) {
    const name = r.name.slice(0, 30).padEnd(30);
    console.log(
      `${r.code} | ${name} | ${r.historyDays}일  | ${r.purchase.toLocaleString().padStart(7)} | ${r.user.toLocaleString().padStart(7)} | ${r.ai.toLocaleString().padStart(7)} | ${(r.diff > 0 ? "+" : "") + r.diff.toLocaleString().padStart(6)} | ${r.userMargin.toFixed(1).padStart(6)}% | ${r.aiMargin.toFixed(1).padStart(6)}%`
    );
  }
}

main().catch(console.error);
