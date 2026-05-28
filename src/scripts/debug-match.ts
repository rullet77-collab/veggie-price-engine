// 특정 코드들의 AI 계산 과정 디버깅
import { calculateAiRecommendation, type AiRecInput } from "../src/lib/aiRecommendation";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function fetchKey(): Promise<string> {
  const fs = await import("fs");
  const envContent = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const match = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/);
  return match ? match[1].trim() : "";
}

async function debugCode(code: string, key: string, priceDate: string) {
  // product
  const pRes = await fetch(`${SUPABASE_URL}/rest/v1/products?product_code=eq.${code}&select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const prods = await pRes.json();
  const prod = prods[0];

  // selling
  const sRes = await fetch(`${SUPABASE_URL}/rest/v1/product_selling_prices?product_code=eq.${code}&select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const sells = await sRes.json();
  const selling = sells[0];

  // mgmt (latest)
  const mRes = await fetch(`${SUPABASE_URL}/rest/v1/daily_product_management?product_code=eq.${code}&price_date=eq.${priceDate}&select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const mgmtArr = await mRes.json();
  const mgmt = mgmtArr[0];

  // purchase history (60일)
  const sixtyAgo = new Date(priceDate);
  sixtyAgo.setDate(sixtyAgo.getDate() - 60);
  const eightAgo = new Date(priceDate);
  eightAgo.setDate(eightAgo.getDate() - 8);

  const phRes = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_purchase_prices?product_code=eq.${code}&price_date=gte.${sixtyAgo.toISOString().slice(0,10)}&order=price_date.asc&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const phArr = await phRes.json();

  const shortHistory = phArr.filter((h: { price_date: string }) => h.price_date >= eightAgo.toISOString().slice(0,10))
    .map((h: { price_date: string; purchase_price: number }) => ({ date: h.price_date, price: h.purchase_price }));
  const longHistory = phArr.map((h: { price_date: string; purchase_price: number }) => ({ date: h.price_date, price: h.purchase_price }));

  // sales
  const priceDateObj = new Date(priceDate);
  const recentStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1).toISOString().slice(0, 10);
  const prevStart = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 5, 1).toISOString().slice(0, 10);
  const prevEnd = new Date(priceDateObj.getFullYear(), priceDateObj.getMonth() - 2, 1).toISOString().slice(0, 10);

  const msRes = await fetch(
    `${SUPABASE_URL}/rest/v1/monthly_sales_quantity?product_code=eq.${code}&sale_month=gte.${prevStart}&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  const msArr = await msRes.json();
  const recentSales = msArr.filter((m: { sale_month: string; source: string }) => m.sale_month >= recentStart && (!m.source || m.source === "전체")).map((m: { sale_month: string; quantity: number }) => ({ sale_month: m.sale_month, quantity: m.quantity || 0 }));
  const prevSales = msArr.filter((m: { sale_month: string; source: string }) => m.sale_month >= prevStart && m.sale_month < prevEnd && (!m.source || m.source === "전체")).map((m: { sale_month: string; quantity: number }) => ({ sale_month: m.sale_month, quantity: m.quantity || 0 }));

  const aiInput: AiRecInput = {
    purchase_price: mgmt?.purchase_price || 0,
    prev_purchase_price: mgmt?.prev_purchase_price || 0,
    current_selling_price: selling?.selling_price || 0,
    prev_selling_price: selling?.prev_selling_price || 0,
    target_margin_rate: prod?.target_margin_rate ? Number(prod.target_margin_rate) : null,
    is_key_item: prod?.is_key_item || false,
    price_sensitivity: (prod?.price_sensitivity as "예민" | "고정" | "일반") || "일반",
    short_history: shortHistory,
    long_history: longHistory,
    monthly_sales: recentSales,
    prev_monthly_sales: prevSales,
    group_trend: null,
  };

  const result = calculateAiRecommendation(aiInput);

  console.log(`\n━━━━━━━━ ${code} / ${prod?.product_name} ━━━━━━━━`);
  console.log(`매입: 오늘 ${aiInput.purchase_price} / 어제 ${aiInput.prev_purchase_price}`);
  console.log(`판매: 사용자 ${aiInput.current_selling_price} / 기존 ${aiInput.prev_selling_price}`);
  console.log(`기준수익률: ${aiInput.target_margin_rate}%, 민감도: ${aiInput.price_sensitivity}, 경쟁품목: ${aiInput.is_key_item}`);
  console.log(`8일 매입이력 (${shortHistory.length}건):`, shortHistory);
  console.log(`매출: 최근 ${recentSales.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0)}건 / 직전 ${prevSales.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0)}건`);
  console.log(`\n🤖 AI 추천가: ${result.ai_price}원`);
  console.log(`🧍 사용자가: ${aiInput.current_selling_price}원`);
  console.log(`차이: ${result.ai_price - aiInput.current_selling_price}원`);
  console.log(`\n[AI 판단 근거]`);
  console.log(result.ai_reason);
}

async function main() {
  const key = await fetchKey();
  const priceDate = "2026-04-17";

  // 007751 가지/상 확인
  await debugCode("007751", key, priceDate);
}

main().catch(console.error);
