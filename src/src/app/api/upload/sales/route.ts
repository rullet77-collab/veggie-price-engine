import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function parseDate(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, "0");
      const d = String(date.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(str)) return str.replace(/\//g, "-");
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
  const targetKeys = ["상품코드", "일자", "단가", "수량", "단위", "공급가액"];

  for (let r = range.s.r; r <= Math.min(range.s.r + 10, range.e.r); r++) {
    const colMap: Record<string, number> = {};

    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const val = String(cell.v).trim();

      for (const key of targetKeys) {
        if (val.includes(key)) {
          colMap[key] = c;
          break;
        }
      }
    }

    if (
      colMap["상품코드"] !== undefined &&
      colMap["일자"] !== undefined &&
      colMap["단가"] !== undefined
    ) {
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
      return Response.json(
        { success: false, error: "파일이 없습니다." },
        { status: 400 }
      );
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
      const sellingPrice = Math.round(Number(priceRaw));

      if (!priceDate || isNaN(sellingPrice) || sellingPrice <= 0) continue;

      const row: Record<string, unknown> = {
        product_code: productCode,
        price_date: priceDate,
        selling_price: sellingPrice,
      };

      const qtyRaw = getCell("수량");
      if (qtyRaw != null) row.quantity = Number(qtyRaw) || null;

      const unitRaw = getCell("단위");
      if (unitRaw != null) row.unit = String(unitRaw).trim() || null;

      const supplyRaw = getCell("공급가액");
      if (supplyRaw != null)
        row.supply_amount = Math.round(Number(supplyRaw)) || null;

      rows.push(row);
    }

    if (rows.length === 0) {
      return Response.json(
        { success: false, error: "유효한 데이터가 없습니다." },
        { status: 400 }
      );
    }

    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from("daily_selling_prices")
        .upsert(batch as never[], {
          onConflict: "product_code,price_date,selling_price",
          ignoreDuplicates: true,
        })
        .select();

      if (error) {
        console.error("Supabase insert error:", error);
        for (const row of batch) {
          const { data: singleData, error: singleErr } = await supabase
            .from("daily_selling_prices")
            .upsert([row as never], {
              onConflict: "product_code,price_date,selling_price",
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

    return Response.json({
      success: true,
      total: rows.length,
      inserted,
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
