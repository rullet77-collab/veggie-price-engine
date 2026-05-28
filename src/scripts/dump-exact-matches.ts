// 정확히 일치하는 80건 찾아서 덤프
import { calculateAiRecommendation, type AiRecInput } from "../src/lib/aiRecommendation";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function fetchKey(): Promise<string> {
  const fs = await import("fs");
  const envContent = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
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
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
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
  const priceDate = "2026-04-17";

  type MgmtRow = { product_code: string; purchase_price: number | null; prev_purchase_price: number | null; product_name: string | null; };
  const mgmtData = await query<MgmtRow>(`daily_product_management?price_date=eq.${priceDate}&select=product_code,purchase_price,prev_purchase_price,product_name`, key);

  type ProdRow = { product_code: string; product_group: number | null; is_key_item: boolean; target_margin_rate: number | null; product_type: string | null; price_sensitivity: string | null; };
  const allProducts = await query<ProdRow>(`products?select=product_code,product_group,is_key_item,target_margin_rate,product_type,price_sensitivity`, key);
  const prodMap = new Map<string, ProdRow>();
  for (const p of allProducts) prodMap.set(p.product_code, p);
  const vegeCodes = new Set(allProducts.filter((p) => p.product_type === "야채").map((p) => p.product_code));

  type SellingRow = { product_code: string; selling_price: number; prev_selling_price: number | null; };
  const sellingData = await query<SellingRow>(`product_selling_prices?select=product_code,selling_price,prev_selling_price`, key);
  const sellingMap = new Map<string, SellingRow>();
  for (const s of sellingData) sellingMap.set(s.product_code, s);

  const eightDaysAgo = new Date(priceDate);
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  const sixtyDaysAgo = new Date(priceDate);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  type PurchRow = { product_code: string; price_date: string; purchase_price: number };
  const longHistory = await query<PurchRow>(`daily_purchase_prices?price_date=gte.${sixtyDaysAgo.toISOString().slice(0, 10)}&price_date=lte.${priceDate}&order=price_date.asc&select=product_code,price_date,purchase_price`, key);

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

  const priceDateObj = new Date(priceDate);
  const recentStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1).toISOString().slice(0, 10);
  const prevStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1).toISOString().slice(0, 10);
  const prevEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1).toISOString().slice(0, 10);

  type MonthlyRow = { product_code: string; sale_month: string; quantity: number; source: string };
  const monthlySales = await query<MonthlyRow>(`monthly_sales_quantity?sale_month=gte.${prevStart}&select=product_code,sale_month,quantity,source`, key);
  const recentSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  const prevSalesMap = new Map<string, { sale_month: string; quantity: number }[]>();
  for (const ms of monthlySales) {
    if (ms.source && ms.source !== "전체") continue;
    const entry = { sale_month: ms.sale_month, quantity: ms.quantity || 0 };
    if (ms.sale_month >= recentStart) {
      if (!recentSalesMap.has(ms.product_code)) recentSalesMap.set(ms.product_code, []);
      recentSalesMap.get(ms.product_code)!.push(entry);
    } else if (ms.sale_month >= prevStart && ms.sale_month < prevEnd) {
      if (!prevSalesMap.has(ms.product_code)) prevSalesMap.set(ms.product_code, []);
      prevSalesMap.get(ms.product_code)!.push(entry);
    }
  }

  const exactMatches: {code:string;name:string;pp:number;user:number;ai:number;targetM:number;reason:string}[] = [];

  for (const row of mgmtData) {
    if (!vegeCodes.has(row.product_code)) continue;
    const prod = prodMap.get(row.product_code);
    const selling = sellingMap.get(row.product_code);
    if (!selling || !row.purchase_price) continue;

    const input: AiRecInput = {
      purchase_price: row.purchase_price,
      prev_purchase_price: row.prev_purchase_price || 0,
      current_selling_price: selling.selling_price,
      prev_selling_price: selling.prev_selling_price || 0,
      target_margin_rate: prod?.target_margin_rate ? Number(prod.target_margin_rate) : null,
      is_key_item: prod?.is_key_item || false,
      price_sensitivity: (prod?.price_sensitivity as "예민" | "고정" | "일반") || "일반",
      short_history: shortMap.get(row.product_code) || [],
      long_history: longMap.get(row.product_code) || [],
      monthly_sales: recentSalesMap.get(row.product_code) || [],
      prev_monthly_sales: prevSalesMap.get(row.product_code) || [],
      group_trend: null,
    };

    const result = calculateAiRecommendation(input);
    if (result.ai_price === selling.selling_price) {
      exactMatches.push({
        code: row.product_code,
        name: row.product_name || "",
        pp: row.purchase_price,
        user: selling.selling_price,
        ai: result.ai_price,
        targetM: input.target_margin_rate || 0,
        reason: result.ai_reason.slice(0, 200),
      });
    }
  }

  console.log(`정확히 일치: ${exactMatches.length}건\n`);
  console.log("코드   | 상품명                         | 매입   | 일치가  | 기준% | 핵심 판단");
  console.log("-".repeat(140));
  for (const m of exactMatches) {
    const name = m.name.slice(0, 28).padEnd(28);
    const firstReason = m.reason.split(".")[2]?.trim() || m.reason.slice(0, 60);
    console.log(`${m.code} | ${name} | ${m.pp.toString().padStart(6)} | ${m.user.toString().padStart(7)} | ${m.targetM.toFixed(1).padStart(5)} | ${firstReason.slice(0, 60)}`);
  }
}

main().catch(console.error);
