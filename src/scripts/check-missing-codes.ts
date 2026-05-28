// DB에 없는 엑셀 품목 확인
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

async function main() {
  const envContent = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const key = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)?.[1].trim() || "";

  const wb = XLSX.readFile("C:/Users/y/Downloads/260421상품그룹.xlsx");
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });

  // DB에 모든 코드 조회
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?select=product_code&limit=1500`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const dbRows = await res.json();
  const dbCodes = new Set<string>(dbRows.map((r: { product_code: string }) => r.product_code));

  const missing: { code: string; name: string; group: number | null }[] = [];
  for (const r of rows) {
    const code = String(r["상품코드(수정금지)"]).padStart(6, "0");
    if (!dbCodes.has(code)) {
      missing.push({ code, name: String(r["상품명"] || ""), group: r["상품그룹"] });
    }
  }

  console.log(`DB에 없는 품목: ${missing.length}개`);
  console.log("\n예시 30개:");
  for (const m of missing.slice(0, 30)) {
    console.log(`  ${m.code} [그룹 ${m.group}] ${m.name}`);
  }
}

main().catch(console.error);
