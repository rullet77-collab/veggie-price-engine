import { createClient } from "@supabase/supabase-js";
import { rollSellingPrices } from "@/lib/rollSellingPrices";
import { learnTierRatios } from "@/lib/tierRatios";
import * as XLSX from "xlsx";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── 공통 유틸 ──

function padProductCode(value: unknown): string {
  const str = String(value).trim();
  return str.padStart(6, "0");
}

function parseDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
    }
  }
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(str)) return str.replace(/\//g, "-");
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(str)) return str.replace(/\./g, "-");
  if (/^\d{8}$/.test(str))
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  return null;
}

/** 시트명에서 MMDD 추출 → YYYY-MM-DD */
function extractDateFromSheetName(name: string): string | null {
  const m = name.match(/\((\d{4})\)/);
  if (!m) return null;
  const mmdd = m[1];
  const month = mmdd.slice(0, 2);
  const day = mmdd.slice(2, 4);
  const now = new Date();
  let year = now.getFullYear();
  if (parseInt(month) > now.getMonth() + 2) year--;
  return `${year}-${month}-${day}`;
}

/** 헤더 셀 값에서 공백 제거 후 매칭 (천년경영 엑셀은 '상  품  명' 같은 공백이 많음) */
function normalizeHeader(val: string): string {
  return val.replace(/\s+/g, "");
}

/** 시트에서 헤더 행을 찾아 컬럼 매핑 반환 (정확히 일치 우선, includes 후순위) */
function findHeaders(
  sheet: XLSX.WorkSheet,
  targetKeys: string[],
  minMatch = 3
): { headerRow: number; colMap: Record<string, number> } | null {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let r = range.s.r; r <= Math.min(range.s.r + 15, range.e.r); r++) {
    const colMap: Record<string, number> = {};
    const includesMap: Record<string, number> = {};

    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const val = normalizeHeader(String(cell.v).trim());
      for (const key of targetKeys) {
        const normKey = normalizeHeader(key);
        // 정확히 일치 → 즉시 확정
        if (val === normKey) {
          colMap[key] = c;
          break;
        }
        // includes → 후보로 저장 (첫 매칭만)
        if (val.includes(normKey) && includesMap[key] === undefined) {
          includesMap[key] = c;
          break;
        }
      }
    }

    // exact match 없는 키에 대해 includes 후보 적용
    for (const key of targetKeys) {
      if (colMap[key] === undefined && includesMap[key] !== undefined) {
        colMap[key] = includesMap[key];
      }
    }

    if (Object.keys(colMap).length >= Math.min(minMatch, targetKeys.length)) {
      return { headerRow: r, colMap };
    }
  }
  return null;
}

function getCellValue(sheet: XLSX.WorkSheet, r: number, c: number): unknown {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })];
  return cell ? cell.v : null;
}

async function batchUpsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  opts: { skipDuplicates?: boolean } = {}
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  const BATCH_SIZE = 500;
  let inserted = 0;
  const errors: string[] = [];
  const total = rows.length;
  // skipDuplicates: true → INSERT IGNORE (기존 보존), false → UPSERT (정정 반영)
  const ignoreDup = opts.skipDuplicates === true;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from(table)
      .upsert(batch as never[], { onConflict, ignoreDuplicates: ignoreDup })
      .select();

    if (error) {
      // 행단위 fallback — 호출 정책 그대로 유지
      for (const row of batch) {
        const { data: d, error: e } = await supabase
          .from(table)
          .upsert([row as never], { onConflict, ignoreDuplicates: ignoreDup })
          .select();
        if (!e && d) inserted += d.length;
        else if (e) errors.push(`${table}: ${e.message}`);
      }
    } else {
      inserted += data?.length ?? 0;
    }
  }
  return { inserted, skipped: total - inserted, errors };
}

// ── 시트 타입 감지 ──

type SheetType =
  | "기존" | "변경" | "상품별매입현황" | "월별매출현황" | "경매가평균" | "unknown";

function detectSheetType(name: string, sheet?: XLSX.WorkSheet): SheetType {
  if (/^기존\(\d{4}\)/.test(name)) return "기존";
  if (/^변경\(\d{4}\)/.test(name)) return "변경";
  if (name.includes("상품별매입현황") || name.includes("매입상세") || name.includes("매입이력")) return "상품별매입현황";
  if (/^월별매출현황/.test(name) || /^신선행월별매출현황/.test(name)) return "월별매출현황";
  if (name.includes("경매가평균")) return "경매가평균";

  // 시트 이름이 "Sheet1" 같은 기본명일 때 — 헤더 (코드/일자/단가) 가 있으면 매입현황으로 인식
  if (sheet) {
    const headers = findHeaders(sheet, ["코드", "일자", "단가"]);
    if (headers && headers.colMap["코드"] !== undefined && headers.colMap["일자"] !== undefined && headers.colMap["단가"] !== undefined) {
      return "상품별매입현황";
    }
  }
  return "unknown";
}

function getMonthlySource(sheetName: string): string {
  return sheetName.includes("신선행") ? "신선행" : "전체";
}

/** 월별매출상세 파일 감지
 *  두 형식 모두 인식:
 *    A. RAW (일자별) — ROWKEY 컬럼 (천년경영 거래번호) → 시트만으로 식별
 *    B. 통합 (월/주말/누락분) — 파일명에 "매출" + 채널 키워드 (식봄/신선행/온일장/배민) 동시 존재
 *       (매입상세 파일도 같은 컬럼 셋이라 시트만으론 구분 불가 → 파일명 가드)
 */
function detectSalesDetail(workbook: XLSX.WorkBook, fileName: string | null = null): boolean {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return false;
  // A. RAW
  const raw = findHeaders(sheet, ["일자", "기본코드", "ROWKEY", "수량", "단가"], 4);
  if (raw && raw.colMap["ROWKEY"] !== undefined) return true;
  // B. 통합 — 파일명 가드
  if (!fileName) return false;
  const hasSales = fileName.includes("매출");
  const hasChannel = detectChannelFromFilename(fileName) != null;
  if (!hasSales || !hasChannel) return false;
  const integ = findHeaders(sheet, ["코드", "일자", "단가", "수량", "공급가액"], 4);
  return integ !== null;
}

/** 파일명에서 채널 추출 (통합 파일용) */
function detectChannelFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  if (filename.includes("식봄")) return "식봄";
  if (filename.includes("신선행")) return "신선행";
  if (filename.includes("온일장")) return "온일장";
  if (filename.includes("배민")) return "배민";
  return null;
}

// ── 각 시트 타입별 파서 ──

/** 기존/변경 → daily_product_management */
function parseProductManagement(
  sheet: XLSX.WorkSheet,
  sheetType: "기존" | "변경",
  sheetName: string
): { date: string; rows: Map<string, Record<string, unknown>> } | null {
  const date = extractDateFromSheetName(sheetName);
  if (!date) return null;

  const targetKeys = ["상품코드", "상품명", "규격", "단위", "매출가", "매입가", "소분류명", "대분류명"];
  const headers = findHeaders(sheet, targetKeys);
  if (!headers || headers.colMap["상품코드"] === undefined) return null;

  const { headerRow, colMap } = headers;
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const rows = new Map<string, Record<string, unknown>>();

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeRaw = getCellValue(sheet, r, colMap["상품코드"]!);
    if (!codeRaw) continue;

    const productCode = padProductCode(codeRaw);
    const purchasePrice = colMap["매입가"] !== undefined
      ? Math.round(Number(getCellValue(sheet, r, colMap["매입가"]!) || 0))
      : null;

    const row: Record<string, unknown> = { product_code: productCode };

    if (sheetType === "변경") {
      row.purchase_price = purchasePrice;
    } else {
      row.prev_purchase_price = purchasePrice;
    }

    if (colMap["상품명"] !== undefined)
      row.product_name = String(getCellValue(sheet, r, colMap["상품명"]!) || "").trim() || null;
    if (colMap["규격"] !== undefined)
      row.spec = String(getCellValue(sheet, r, colMap["규격"]!) || "").trim() || null;
    if (colMap["단위"] !== undefined)
      row.unit = String(getCellValue(sheet, r, colMap["단위"]!) || "").trim() || null;
    if (colMap["소분류명"] !== undefined)
      row.category_name = String(getCellValue(sheet, r, colMap["소분류명"]!) || "").trim() || null;
    if (colMap["대분류명"] !== undefined)
      row.major_category = String(getCellValue(sheet, r, colMap["대분류명"]!) || "").trim() || null;

    rows.set(productCode, row);
  }

  return { date, rows };
}

/** 상품별매입현황(야채7일) → daily_purchase_prices
 *  헤더: 코드, 상품명, 규격, 일자, 단가, 수량, 단위, 공급가액, 합계액, 주매입처 */
function parsePurchaseHistory(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const targetKeys = ["코드", "일자", "단가", "수량", "단위", "공급가액"];
  const headers = findHeaders(sheet, targetKeys);
  if (!headers || headers.colMap["코드"] === undefined) return [];

  const { headerRow, colMap } = headers;
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const rows: Record<string, unknown>[] = [];

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeRaw = getCellValue(sheet, r, colMap["코드"]!);
    const dateRaw = colMap["일자"] !== undefined ? getCellValue(sheet, r, colMap["일자"]!) : null;
    const priceRaw = colMap["단가"] !== undefined ? getCellValue(sheet, r, colMap["단가"]!) : null;

    if (!codeRaw || !dateRaw || !priceRaw) continue;

    const productCode = padProductCode(codeRaw);
    const priceDate = parseDate(dateRaw);
    const purchasePrice = Math.round(Number(priceRaw));

    if (!priceDate || isNaN(purchasePrice) || purchasePrice <= 0) continue;

    const row: Record<string, unknown> = {
      product_code: productCode,
      price_date: priceDate,
      purchase_price: purchasePrice,
    };

    if (colMap["수량"] !== undefined) {
      const v = getCellValue(sheet, r, colMap["수량"]!);
      if (v != null) row.quantity = Number(v) || null;
    }
    if (colMap["단위"] !== undefined) {
      const v = getCellValue(sheet, r, colMap["단위"]!);
      if (v != null) row.unit = String(v).trim() || null;
    }
    if (colMap["공급가액"] !== undefined) {
      const v = getCellValue(sheet, r, colMap["공급가액"]!);
      if (v != null) row.supply_amount = Math.round(Number(v)) || null;
    }

    rows.push(row);
  }
  return rows;
}

/** 월별매출현황(상품별) → monthly_sales_quantity
 *  헤더: 코드, 상품명, 규격, (빈칸=수량), 날짜시리얼(=월)
 *  or:   코드, 상품명, 규격, 수량 */
function parseMonthlySalesQty(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");

  // 헤더 행 찾기: "코드" 가 있는 행
  let headerRow = -1;
  let codeCol = -1;
  for (let r = range.s.r; r <= Math.min(range.s.r + 5, range.e.r); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell && normalizeHeader(String(cell.v)) === "코드") {
        headerRow = r;
        codeCol = c;
        break;
      }
    }
    if (headerRow >= 0) break;
  }
  if (headerRow < 0) return [];

  // 수량 컬럼: "코드" 다음 3번째 (D열, 인덱스 codeCol+3)
  // 헤더가 비어있거나 "수량"이면 사용
  const qtyCol = codeCol + 3;

  // 월 정보: 헤더 행의 마지막 열에 날짜 시리얼이 있을 수 있음
  let saleMonth: string;
  const lastHeaderCell = getCellValue(sheet, headerRow, codeCol + 4);
  if (typeof lastHeaderCell === "number" && lastHeaderCell > 40000) {
    // 엑셀 시리얼 → 날짜
    const d = XLSX.SSF.parse_date_code(lastHeaderCell);
    if (d) {
      saleMonth = `${d.y}-${String(d.m).padStart(2, "0")}-01`;
    } else {
      const now = new Date();
      saleMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    }
  } else if (typeof lastHeaderCell === "string" && /^\d{4}-\d{2}$/.test(lastHeaderCell.trim())) {
    saleMonth = `${lastHeaderCell.trim()}-01`;
  } else {
    const now = new Date();
    saleMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeRaw = getCellValue(sheet, r, codeCol);
    if (!codeRaw) continue;

    const productCode = padProductCode(codeRaw);
    const qtyRaw = getCellValue(sheet, r, qtyCol);
    const quantity = qtyRaw != null ? Math.round(Number(qtyRaw)) : 0;

    if (quantity <= 0) continue;

    rows.push({ product_code: productCode, sale_month: saleMonth, quantity });
  }
  return rows;
}

/** parseMonthlySalesQty에 source 필드 추가 */
function addSource(rows: Record<string, unknown>[], source: string): Record<string, unknown>[] {
  return rows.map((r) => ({ ...r, source }));
}

/** 경매가평균(최근일주일) → auction_prices
 *  헤더: 날짜, 품목, 품종, 등급, 거래단위, 최저가, 최고가, 평균가,
 *        전일대비 등락, 전일 평균대비, 전7일 평균대비, 전년 동월동일 평균대비 */
function parseAuctionPrices(sheet: XLSX.WorkSheet): Record<string, unknown>[] {
  const targetKeys = [
    "날짜", "품목", "품종", "등급", "거래단위",
    "최저가", "최고가", "평균가", "전일대비",
    "전일평균대비", "전7일", "전년",
  ];
  const headers = findHeaders(sheet, targetKeys);
  if (!headers || headers.colMap["날짜"] === undefined) return [];

  const { headerRow, colMap } = headers;
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const rows: Record<string, unknown>[] = [];

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const dateRaw = getCellValue(sheet, r, colMap["날짜"]!);
    if (!dateRaw) continue;

    const priceDate = parseDate(dateRaw);
    if (!priceDate) continue;

    const row: Record<string, unknown> = { price_date: priceDate };

    const strFields: [string, string][] = [
      ["품목", "item_name"], ["품종", "variety"],
      ["등급", "grade"], ["거래단위", "trade_unit"],
    ];
    for (const [kr, en] of strFields) {
      if (colMap[kr] !== undefined) {
        const v = getCellValue(sheet, r, colMap[kr]!);
        row[en] = v != null ? String(v).trim() : null;
      }
    }

    const numFields: [string, string][] = [
      ["최저가", "min_price"], ["최고가", "max_price"],
      ["평균가", "avg_price"], ["전일대비", "daily_change"],
    ];
    for (const [kr, en] of numFields) {
      if (colMap[kr] !== undefined) {
        const v = getCellValue(sheet, r, colMap[kr]!);
        row[en] = v != null ? Math.round(Number(v)) || null : null;
      }
    }

    const pctFields: [string, string][] = [
      ["전일평균대비", "daily_change_pct"],
      ["전7일", "weekly_change_pct"],
      ["전년", "yearly_change_pct"],
    ];
    for (const [kr, en] of pctFields) {
      if (colMap[kr] !== undefined) {
        const v = getCellValue(sheet, r, colMap[kr]!);
        row[en] = v != null ? String(v).trim() : null;
      }
    }

    rows.push(row);
  }
  return rows;
}

/** 그룹명 → 채널 (식봄/신선행/온일장/배민) 매핑 */
function detectChannel(groupName: string | null): string | null {
  if (!groupName) return null;
  const g = groupName.replace(/▣/g, "").trim();
  if (g.startsWith("식봄")) return "식봄";
  if (g.startsWith("신선행")) return "신선행";
  if (g.startsWith("온일장")) return "온일장";
  if (g.startsWith("배민")) return "배민";
  return null;
}

/** 월별매출상세 (별도 파일) → sales_detail
 *  RAW 형식: 일자, 거래처코드, 거래처, 기본코드, 상품명, 규격, 단위, 수량,
 *           단가, 공급가액, 합계액, 매입가, 매출가, 이익률, ROWKEY, 그룹명
 *  통합 형식: 코드, 상품명, 규격, 거래처, 일자, 단가, 수량, 단위, 공급가액, 합계액 (ROWKEY 없음)
 *
 *  fileChannel: 통합파일에서 ROWKEY/그룹명이 없을 때 채널 fallback 으로 사용 (파일명 기반)
 */
function parseSalesDetail(sheet: XLSX.WorkSheet, fileChannel: string | null = null): Record<string, unknown>[] {
  const targetKeys = [
    "일자", "기본코드", "코드", "상품명", "규격", "단위",
    "수량", "단가", "공급가액", "합계액",
    "거래처", "매입가", "매출가", "이익률", "ROWKEY", "그룹명",
  ];
  const headers = findHeaders(sheet, targetKeys, 5);
  // 코드 컬럼 (기본코드 또는 코드)
  const codeCol = headers?.colMap["기본코드"] ?? headers?.colMap["코드"];
  if (!headers || codeCol === undefined) return [];

  const { headerRow, colMap } = headers;
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const rows: Record<string, unknown>[] = [];

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeRaw = getCellValue(sheet, r, codeCol);
    const dateRaw = colMap["일자"] !== undefined ? getCellValue(sheet, r, colMap["일자"]!) : null;
    if (!codeRaw || !dateRaw) continue;

    const productCode = padProductCode(codeRaw);
    const saleDate = parseDate(dateRaw);
    if (!saleDate) continue;

    const getNum = (key: string) => {
      if (colMap[key] === undefined) return null;
      const v = getCellValue(sheet, r, colMap[key]!);
      return v != null ? Math.round(Number(v)) || null : null;
    };
    const getStr = (key: string) => {
      if (colMap[key] === undefined) return null;
      const v = getCellValue(sheet, r, colMap[key]!);
      return v != null ? String(v).trim() || null : null;
    };

    const qty = colMap["수량"] !== undefined ? Number(getCellValue(sheet, r, colMap["수량"]!) || 0) : 0;
    const platform = getStr("거래처");
    const groupNameForKey = getStr("그룹명");
    const channelForKey = detectChannel(groupNameForKey) ?? fileChannel;

    // ROWKEY가 있으면 그대로 사용, 없으면 생성 (통합파일 채널별 충돌 방지)
    let rowKey = getStr("ROWKEY");
    if (!rowKey) {
      rowKey = `${saleDate}_${productCode}_${channelForKey || platform || ""}_${qty}_${getNum("단가") || 0}`;
    }

    const marginRaw = colMap["이익률"] !== undefined
      ? getCellValue(sheet, r, colMap["이익률"]!)
      : null;
    const marginRate = marginRaw != null ? Number(Number(marginRaw).toFixed(6)) : null;

    const channel = channelForKey;

    rows.push({
      sale_date: saleDate,
      product_code: productCode,
      product_name: getStr("상품명"),
      spec: getStr("규격"),
      unit: getStr("단위"),
      quantity: qty,
      unit_price: getNum("단가"),
      supply_amount: getNum("공급가액"),
      total_amount: getNum("합계액"),
      purchase_price: getNum("매입가"),
      selling_price: getNum("매출가"),
      margin_rate: marginRate,
      platform,
      row_key: rowKey,
      channel,
    });
  }
  return rows;
}

// ── 메인 핸들러 ──

type SheetResult = {
  sheetName: string;
  type: string;
  total: number;
  inserted: number;
  skipped?: number;
  errors?: string[];
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const results: SheetResult[] = [];

    // 1) 월별매출상세 (별도 파일) 감지
    //    UPSERT 정책: 같은 row_key 가 다시 들어오면 정정으로 간주하고 갱신
    //    이유: 천년경영에서 거래 정정 시 같은 ROWKEY 재발행 — selling_price/qty 변경 반영 필요
    //    매일 전체 파일을 올려도 ROWKEY UNIQUE 제약 + 동일값 UPSERT 라 부작용 없음
    if (detectSalesDetail(workbook, file.name)) {
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      // 통합파일은 그룹명이 없으니 파일명에서 채널 추출 (RAW면 그룹명 우선이라 무해)
      const fileChannel = detectChannelFromFilename(file.name);
      const rows = parseSalesDetail(sheet, fileChannel);
      let monthlyTouched: { touched_months: number; total_rows: number } | null = null;
      let rolled: { prev_rolled: number; recommended_set: number; duration_ms: number } | null = null;
      if (rows.length > 0) {
        const { inserted, skipped, errors } = await batchUpsert(
          "sales_detail",
          rows,
          "row_key",
          { skipDuplicates: false }
        );
        results.push({
          sheetName: workbook.SheetNames[0],
          type: "월별매출상세",
          total: rows.length,
          inserted,
          skipped,
          errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
        });

        // 영향받은 가장 이른 월부터 monthly_sales_quantity 재집계
        const minDate = rows
          .map((r) => r.sale_date as string)
          .filter(Boolean)
          .sort()[0];
        if (minDate) {
          const sinceMonth = `${minDate.slice(0, 7)}-01`;
          try {
            const { data, error } = await supabase.rpc("recompute_monthly_sales", { since_month: sinceMonth });
            if (error) console.warn("recompute_monthly_sales RPC 경고:", error.message);
            else if (Array.isArray(data) && data.length > 0) monthlyTouched = data[0];
          } catch (e) {
            console.warn("recompute_monthly_sales 호출 실패:", e);
          }
        }

        // 매출 변경은 추천가에 영향 → rollSellingPrices 한번 더
        try {
          rolled = await rollSellingPrices(supabase);
        } catch (e) {
          console.warn("rollSellingPrices 실패:", e);
        }
      }
      return Response.json({ success: true, results, monthly_touched: monthlyTouched, rolled_selling: rolled });
    }

    // 2) RAW DATA 파일 — 시트별 처리
    // 기존/변경 시트가 있으면 → 판매가 회전 (selling_price → prev_selling_price)
    const hasGijonByun = workbook.SheetNames.some(
      (n) => /^기존\(\d{4}\)/.test(n) || /^변경\(\d{4}\)/.test(n)
    );
    if (hasGijonByun) {
      await supabase.rpc("rotate_selling_prices");
    }

    let gijonData: ReturnType<typeof parseProductManagement> = null;
    let byunData: ReturnType<typeof parseProductManagement> = null;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const type = detectSheetType(sheetName, sheet);

      switch (type) {
        case "기존":
          gijonData = parseProductManagement(sheet, "기존", sheetName);
          break;

        case "변경":
          byunData = parseProductManagement(sheet, "변경", sheetName);
          break;

        case "상품별매입현황": {
          const rows = parsePurchaseHistory(sheet);
          if (rows.length > 0) {
            const { inserted, errors } = await batchUpsert(
              "daily_purchase_prices", rows,
              "product_code,price_date,purchase_price"
            );
            results.push({ sheetName, type: "상품별매입현황", total: rows.length, inserted,
              errors: errors.length > 0 ? errors.slice(0, 5) : undefined });
          }
          break;
        }

        case "월별매출현황": {
          const source = getMonthlySource(sheetName);
          const rows = addSource(parseMonthlySalesQty(sheet), source);
          if (rows.length > 0) {
            const { inserted, errors } = await batchUpsert(
              "monthly_sales_quantity", rows,
              "product_code,sale_month,source"
            );
            results.push({ sheetName, type: `월별매출현황(${source})`, total: rows.length, inserted,
              errors: errors.length > 0 ? errors.slice(0, 5) : undefined });
          }
          break;
        }

        case "경매가평균": {
          const rows = parseAuctionPrices(sheet);
          if (rows.length > 0) {
            const { inserted, errors } = await batchUpsert(
              "auction_prices", rows,
              "price_date,item_name,variety,grade,trade_unit"
            );
            results.push({ sheetName, type: "경매가평균", total: rows.length, inserted,
              errors: errors.length > 0 ? errors.slice(0, 5) : undefined });
          }
          break;
        }

        default:
          break;
      }
    }

    // 기존/변경 합치기 → daily_product_management
    if (gijonData || byunData) {
      const priceDate = byunData?.date || gijonData?.date;
      if (priceDate) {
        const allCodes = new Set([
          ...(gijonData?.rows.keys() || []),
          ...(byunData?.rows.keys() || []),
        ]);

        const mergedRows: Record<string, unknown>[] = [];
        for (const code of allCodes) {
          const gijon = gijonData?.rows.get(code) || {};
          const byun = byunData?.rows.get(code) || {};
          mergedRows.push({
            product_code: code,
            price_date: priceDate,
            purchase_price: byun.purchase_price ?? null,
            prev_purchase_price: gijon.prev_purchase_price ?? null,
            product_name: byun.product_name || gijon.product_name || null,
            spec: byun.spec || gijon.spec || null,
            unit: byun.unit || gijon.unit || null,
            category_name: byun.category_name || gijon.category_name || null,
            major_category: byun.major_category || gijon.major_category || null,
          });
        }

        if (mergedRows.length > 0) {
          const { inserted, errors } = await batchUpsert(
            "daily_product_management", mergedRows, "product_code,price_date"
          );
          results.push({
            sheetName: `기존+변경 → ${priceDate}`,
            type: "기존/변경",
            total: mergedRows.length,
            inserted,
            errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
          });
        }
      }
    }

    if (results.length === 0) {
      return Response.json(
        { success: false, error: "인식 가능한 시트가 없습니다. RAW DATA 파일 또는 월별매출상세 파일을 업로드해주세요." },
        { status: 400 }
      );
    }

    // 매입 데이터 영향이 있는 시트(상품별매입현황)가 처리되면 학습 tier 재계산 + selling_price 라이프사이클 갱신
    const hasPurchaseChange = results.some((r) =>
      r.type.includes("매입현황") || r.type.includes("매입상세")
    );
    let learned: { updated: number; tier1: number; tier2: number; tier3: number } | null = null;
    let learnedRatios: { learnedPairs: number; totalSamples: number } | null = null;
    let rolled: { prev_rolled: number; recommended_set: number; duration_ms: number } | null = null;
    if (hasPurchaseChange) {
      try {
        const { data: tierData, error: tierErr } = await supabase.rpc("learn_tiers", { days: 365 });
        if (tierErr) console.warn("learn_tiers RPC 경고:", tierErr.message);
        else if (Array.isArray(tierData) && tierData.length > 0) {
          learned = tierData[0] as { updated: number; tier1: number; tier2: number; tier3: number };
        }
      } catch (e) {
        console.warn("learn_tiers 호출 실패:", e);
      }
      try {
        // B-3: 등급별 가격비율 학습 (group_tier_ratios)
        const r = await learnTierRatios(365);
        learnedRatios = { learnedPairs: r.learnedPairs, totalSamples: r.totalSamples };
      } catch (e) {
        console.warn("learnTierRatios 호출 실패:", e);
      }
      try {
        // rollSellingPrices 는 group_tier_ratios 를 자동 로드해서 추천에 사용
        rolled = await rollSellingPrices(supabase);
      } catch (e) {
        console.warn("rollSellingPrices 실패:", e);
      }
    }

    return Response.json({ success: true, results, learned_tiers: learned, learned_tier_ratios: learnedRatios, rolled_selling: rolled });
  } catch (err: unknown) {
    console.error("Upload error:", err);
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return Response.json(
      { success: false, error: `처리 중 오류: ${message}` },
      { status: 500 }
    );
  }
}
