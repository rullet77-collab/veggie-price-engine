import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// 천년경영 매입상세 한글 헤더 → DB 컬럼 매핑
const COLUMN_MAP: Record<string, string> = {
  상품코드: "product_code",
  일자: "price_date",
  단가: "purchase_price",
  수량: "quantity",
  단위: "unit",
  공급가액: "supply_amount",
};

function parseDate(value: unknown): string | null {
  if (value == null) return null;

  // 엑셀 시리얼 넘버
  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, "0");
      const d = String(date.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  // 문자열 날짜
  const str = String(value).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // YYYY/MM/DD
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(str)) return str.replace(/\//g, "-");
  // YYYYMMDD
  if (/^\d{8}$/.test(str))
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;

  return null;
}

function padProductCode(value: unknown): string {
  const str = String(value).trim();
  return str.padStart(6, "0");
}

function findHeaderRow(
  sheet: XLSX.WorkSheet
): { headerRow: number; colMap: Record<string, number> } | null {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const targetKeys = Object.keys(COLUMN_MAP);

  for (let r = range.s.r; r <= Math.min(range.s.r + 10, range.e.r); r++) {
    const colMap: Record<string, number> = {};
    let matchCount = 0;

    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const val = String(cell.v).trim();

      for (const key of targetKeys) {
        if (val.includes(key)) {
          colMap[key] = c;
          matchCount++;
          break;
        }
      }
    }

    // 최소 상품코드, 일자, 단가가 있어야 유효한 헤더
    if (colMap["상품코드"] !== undefined && colMap["일자"] !== undefined && colMap["단가"] !== undefined) {
      return { headerRow: r, colMap };
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const headerInfo = findHeaderRow(sheet);
    if (!headerInfo) {
      return Response.json(
        {
          success: false,
          error:
            "헤더를 찾을 수 없습니다. 상품코드, 일자, 단가 컬럼이 포함된 엑셀 파일인지 확인해주세요.",
        },
        { status: 400 }
      );
    }

    const { headerRow, colMap } = headerInfo;
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const rows: Record<string, unknown>[] = [];

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const getCell = (colName: string) => {
        const c = colMap[colName];
        if (c === undefined) return null;
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        return cell ? cell.v : null;
      };

      const productCodeRaw = getCell("상품코드");
      const dateRaw = getCell("일자");
      const priceRaw = getCell("단가");

      if (!productCodeRaw || !dateRaw || !priceRaw) continue;

      const productCode = padProductCode(productCodeRaw);
      const priceDate = parseDate(dateRaw);
      const purchasePrice = Math.round(Number(priceRaw));

      if (!priceDate || isNaN(purchasePrice) || purchasePrice <= 0) continue;

      const row: Record<string, unknown> = {
        product_code: productCode,
        price_date: priceDate,
        purchase_price: purchasePrice,
      };

      const qtyRaw = getCell("수량");
      if (qtyRaw != null) row.quantity = Number(qtyRaw) || null;

      const unitRaw = getCell("단위");
      if (unitRaw != null) row.unit = String(unitRaw).trim() || null;

      const supplyRaw = getCell("공급가액");
      if (supplyRaw != null) row.supply_amount = Math.round(Number(supplyRaw)) || null;

      rows.push(row);
    }

    if (rows.length === 0) {
      return Response.json(
        { success: false, error: "유효한 데이터가 없습니다." },
        { status: 400 }
      );
    }

    // 배치로 upsert (500건씩)
    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from("daily_purchase_prices")
        .upsert(batch as never[], {
          onConflict: "product_code,price_date,purchase_price",
          ignoreDuplicates: true,
        })
        .select();

      if (error) {
        console.error("Supabase insert error:", error);
        // 개별 행에 FK 위반 등이 있을 수 있으므로, 건별로 시도
        for (const row of batch) {
          const { data: singleData, error: singleErr } = await supabase
            .from("daily_purchase_prices")
            .upsert([row as never], {
              onConflict: "product_code,price_date,purchase_price",
              ignoreDuplicates: true,
            })
            .select();
          if (!singleErr && singleData) {
            inserted += singleData.length;
          }
        }
      } else {
        inserted += data?.length ?? 0;
      }
    }

    // 매입 데이터 변경됨 → 학습 tier 재계산 (365일 NTILE 단일 SQL, ~1초)
    let learned: { updated: number; tier1: number; tier2: number; tier3: number } | null = null;
    try {
      const { data: tierData, error: tierErr } = await supabase.rpc("learn_tiers", { days: 365 });
      if (tierErr) {
        console.warn("learn_tiers RPC 경고:", tierErr.message);
      } else if (Array.isArray(tierData) && tierData.length > 0) {
        learned = tierData[0] as { updated: number; tier1: number; tier2: number; tier3: number };
      }
    } catch (e) {
      console.warn("learn_tiers 호출 실패 (학습 갱신은 다음 업로드 때 재시도):", e);
    }

    return Response.json({
      success: true,
      total: rows.length,
      inserted,
      learned_tiers: learned,
    });
  } catch (err: unknown) {
    console.error("Upload error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
