import { supabase } from "@/lib/supabase";

// 수익률일괄변경 실행:
// 요청받은 product_code 배열에 대해
//   target_price = ceil(purchase_price / (1 - target_margin_rate/100) / 10) * 10
// 을 계산하여 product_selling_prices.selling_price 에 적용.
// prev_selling_price 는 기존 selling_price 를 보존한다.
//
// 이 API 는 "역마진/긴급 가격 변경" 용도이며,
// 일상적인 매입 변동에 따른 추천가와는 별도로 사용자가 수동으로 호출한다.

type BulkTargetRow = {
  product_code: string;
  purchase_price: number | null;
  prev_selling_price: number | null;
  selling_price: number | null;
  target_margin_rate: number | null;
};

type BulkResult = {
  product_code: string;
  applied: boolean;
  new_price?: number;
  target_margin_rate?: number;
  error?: string;
};

function computeTargetPrice(
  purchasePrice: number,
  targetMarginRate: number
): number {
  // 10원 단위 올림
  return Math.ceil(purchasePrice / (1 - targetMarginRate / 100) / 10) * 10;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { product_codes } = body as { product_codes?: string[] };

    if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
      return Response.json(
        { success: false, error: "product_codes 배열이 필요합니다." },
        { status: 400 }
      );
    }

    // 1) 대상 상품 정보 fetch
    //    products (target_margin_rate) + daily_purchase_prices (purchase_price)
    //    + product_selling_prices (기존 selling_price)
    //    매입가 source = daily_purchase_prices 만 (mgmt 미사용).
    const { data: productsData, error: prodErr } = await supabase
      .from("products")
      .select("product_code, target_margin_rate")
      .in("product_code", product_codes);

    if (prodErr) {
      return Response.json({ success: false, error: prodErr.message }, { status: 500 });
    }

    // 최신 매입일 — daily_purchase_prices
    const { data: latestDateRow } = await supabase
      .from("daily_purchase_prices")
      .select("price_date")
      .order("price_date", { ascending: false })
      .limit(1)
      .single();

    const latestDate = latestDateRow?.price_date as string | undefined;
    if (!latestDate) {
      return Response.json(
        { success: false, error: "기준이 되는 매입가가 없습니다." },
        { status: 400 }
      );
    }

    // 각 상품의 최근 매입가 — 60일 윈도우 내 가장 최근 price_date 의 purchase_price
    const windowStart = (() => {
      const [y, m, d] = latestDate.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d) - 60 * 86_400_000);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    })();

    const purchaseMap = new Map<string, number | null>();
    {
      const latestByCode = new Map<string, string>();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("daily_purchase_prices")
          .select("product_code, price_date, purchase_price")
          .in("product_code", product_codes)
          .gte("price_date", windowStart)
          .lte("price_date", latestDate)
          .order("price_date", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) {
          return Response.json({ success: false, error: error.message }, { status: 500 });
        }
        if (!data || data.length === 0) break;
        for (const r of data) {
          const cur = latestByCode.get(r.product_code);
          if (!cur || r.price_date >= cur) {
            latestByCode.set(r.product_code, r.price_date);
            purchaseMap.set(r.product_code, r.purchase_price);
          }
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
    }

    const { data: sellingData, error: sellErr } = await supabase
      .from("product_selling_prices")
      .select("product_code, selling_price, prev_selling_price")
      .in("product_code", product_codes);

    if (sellErr) {
      return Response.json({ success: false, error: sellErr.message }, { status: 500 });
    }

    const marginMap = new Map<string, number | null>();
    for (const p of productsData || []) {
      marginMap.set(p.product_code, p.target_margin_rate);
    }
    const sellingMap = new Map<string, { selling_price: number | null; prev_selling_price: number | null }>();
    for (const s of sellingData || []) {
      sellingMap.set(s.product_code, {
        selling_price: s.selling_price,
        prev_selling_price: s.prev_selling_price,
      });
    }

    // 2) 각 상품 처리
    const results: BulkResult[] = [];
    const upserts: {
      product_code: string;
      selling_price: number;
      prev_selling_price: number | null;
      updated_at: string;
    }[] = [];

    for (const code of product_codes) {
      const row: BulkTargetRow = {
        product_code: code,
        purchase_price: purchaseMap.get(code) ?? null,
        prev_selling_price: sellingMap.get(code)?.prev_selling_price ?? null,
        selling_price: sellingMap.get(code)?.selling_price ?? null,
        target_margin_rate: marginMap.get(code) ?? null,
      };

      if (!row.purchase_price || row.purchase_price <= 0) {
        results.push({ product_code: code, applied: false, error: "매입가 없음" });
        continue;
      }
      if (row.target_margin_rate == null || row.target_margin_rate <= 0) {
        results.push({ product_code: code, applied: false, error: "수익률일괄변경용 값 없음" });
        continue;
      }
      if (row.target_margin_rate >= 100) {
        results.push({ product_code: code, applied: false, error: "수익률 100% 이상 불가" });
        continue;
      }

      const newPrice = computeTargetPrice(row.purchase_price, Number(row.target_margin_rate));
      // 기존 가격과 같으면 스킵
      if (row.selling_price === newPrice) {
        results.push({
          product_code: code,
          applied: false,
          new_price: newPrice,
          target_margin_rate: Number(row.target_margin_rate),
          error: "이미 일괄변경가와 일치",
        });
        continue;
      }

      upserts.push({
        product_code: code,
        selling_price: newPrice,
        prev_selling_price: row.selling_price, // 기존 selling_price 를 prev 로 이동
        updated_at: new Date().toISOString(),
      });
      results.push({
        product_code: code,
        applied: true,
        new_price: newPrice,
        target_margin_rate: Number(row.target_margin_rate),
      });
    }

    // 3) 일괄 upsert (batch 500)
    if (upserts.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < upserts.length; i += BATCH) {
        const batch = upserts.slice(i, i + BATCH);
        const { error } = await supabase
          .from("product_selling_prices")
          .upsert(batch, { onConflict: "product_code" });
        if (error) {
          return Response.json(
            {
              success: false,
              error: `일괄 적용 중 오류: ${error.message}`,
              partial_results: results,
            },
            { status: 500 }
          );
        }
      }
    }

    const appliedCount = results.filter((r) => r.applied).length;
    const skippedCount = results.length - appliedCount;

    return Response.json({
      success: true,
      total: product_codes.length,
      applied: appliedCount,
      skipped: skippedCount,
      results,
    });
  } catch (err: unknown) {
    console.error("bulk-apply-target error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
