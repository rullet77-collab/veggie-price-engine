// 박스소분상품260420.xlsx 기반 89개 품목에 pack_role + pack_meta 태깅
import * as XLSX from "xlsx";
import * as fs from "fs";

const SUPABASE_URL = "https://sxndahqadpgivvejxjtg.supabase.co";

// 그룹별 공식수 (박스 ÷ 공식수 = 단위가)
const GROUP_FORMULAS: Record<number, {
  divisor: number;
  unit_kind: "개" | "kg" | "통" | "봉" | "묶음";
  seasonal?: { winter_months: number[]; winter_divisor: number; summer_divisor: number; note: string };
}> = {
  1: { divisor: 30, unit_kind: "개", seasonal: { winter_months: [11,12,1,2,3,4,5,6], winter_divisor: 30, summer_divisor: 45, note: "5kg 박스(30개) 11-6월 / 8kg 박스(45개) 7-10월" } },
  3: { divisor: 18, unit_kind: "kg" },
  4: { divisor: 12, unit_kind: "개" },
  5: { divisor: 3, unit_kind: "통" },
  6: { divisor: 13, unit_kind: "kg" },
  7: { divisor: 3, unit_kind: "통" },
  9: { divisor: 12, unit_kind: "개" },
  12: { divisor: 34, unit_kind: "봉" },
  19: { divisor: 10, unit_kind: "묶음" },
  21: { divisor: 9, unit_kind: "kg" },
  23: { divisor: 3.5, unit_kind: "kg" },
  30: { divisor: 9, unit_kind: "kg" },
  31: { divisor: 9, unit_kind: "kg" },
  32: { divisor: 9, unit_kind: "kg" },
  33: { divisor: 9, unit_kind: "kg" },
  34: { divisor: 9, unit_kind: "kg" },
  46: { divisor: 48, unit_kind: "개" },
  47: { divisor: 42, unit_kind: "개" },
  49: { divisor: 20, unit_kind: "개" },
  50: { divisor: 20, unit_kind: "개" },
  51: { divisor: 2, unit_kind: "kg" },
  58: { divisor: 9, unit_kind: "kg" },
  64: { divisor: 3.5, unit_kind: "kg" },
  82: { divisor: 27, unit_kind: "개" },
  96: { divisor: 6, unit_kind: "개" },
};

// 상품명에서 소분 수량 자동 추출
function parseSubdivQuantity(name: string, spec: string, unit: string, groupFormula: { divisor: number; unit_kind: string }): { quantity: number; unit_kind: string; half_box?: boolean } | null {
  const g = groupFormula;

  // 반박스 (kg 표기)
  const halfBoxMatch = (spec || "").match(/반박스\/?(\d+\.?\d*)\s*[kK][gG]/);
  if (halfBoxMatch) {
    return { quantity: parseFloat(halfBoxMatch[1]), unit_kind: "kg", half_box: true };
  }

  // "1kg", "3kg", "5kg" 등 kg 단위
  const kgMatch = name.match(/(\d+\.?\d*)\s*[kK][gG]/);
  if (kgMatch && g.unit_kind === "kg") {
    return { quantity: parseFloat(kgMatch[1]), unit_kind: "kg" };
  }

  // "500g", "250g" 등 g 단위 (0.5kg, 0.25kg 으로 변환)
  const gMatch = name.match(/(\d+)\s*[gG](?!\w)/);
  if (gMatch && g.unit_kind === "kg") {
    return { quantity: parseInt(gMatch[1]) / 1000, unit_kind: "kg" };
  }

  // "3개", "5개", "10개"
  const gaeMatch = name.match(/(\d+)\s*개/);
  if (gaeMatch && g.unit_kind === "개") {
    return { quantity: parseInt(gaeMatch[1]), unit_kind: "개" };
  }

  // "3묶음", "5묶음", "10묶음"
  const mukMatch = name.match(/(\d+)\s*묶음/);
  if (mukMatch && g.unit_kind === "묶음") {
    return { quantity: parseInt(mukMatch[1]), unit_kind: "묶음" };
  }

  // "3봉", "5봉", "10봉" (팽이버섯)
  const bongMatch = name.match(/(\d+)\s*봉/);
  if (bongMatch && g.unit_kind === "봉") {
    return { quantity: parseInt(bongMatch[1]), unit_kind: "봉" };
  }

  // 낱개/통 (이름 또는 규격에 "낱개" 포함)
  if ((unit === "통" || unit === "개" || unit === "봉") && (name.includes("낱개") || spec.includes("낱개"))) {
    return { quantity: 1, unit_kind: g.unit_kind };
  }

  return null;
}

async function main() {
  const envContent = fs.readFileSync("C:/Users/y/Videos/판매가변경영상/src/.env.local", "utf-8");
  const key = envContent.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)?.[1].trim() || "";
  if (!key) throw new Error("Supabase key not found");

  const wb = XLSX.readFile("C:/Users/y/Downloads/박스소분상품260420.xlsx");
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: null });

  console.log(`엑셀 품목: ${rows.length}개\n`);

  let boxCount = 0, subdivCount = 0, failCount = 0;
  const failures: string[] = [];

  for (const row of rows) {
    const code = String(row["상품코드(수정금지)"]).padStart(6, "0");
    const groupRaw = row["상품그룹"];
    const role = row["소분여부"];
    const name = String(row["상품명"] || "");
    const spec = String(row["규격"] || "");
    const unit = String(row["단위"] || "");

    const group = Number(groupRaw);
    if (!group || !GROUP_FORMULAS[group]) {
      failures.push(`[그룹 미정의] ${code} ${name} (그룹 ${group})`);
      failCount++;
      continue;
    }

    const groupFormula = GROUP_FORMULAS[group];
    let packRole: "박스" | "소분";
    let packMeta: Record<string, unknown>;

    if (role === "박스") {
      packRole = "박스";
      packMeta = {
        formula_divisor: groupFormula.divisor,
        unit_kind: groupFormula.unit_kind,
      };
      if (groupFormula.seasonal) {
        packMeta.seasonal = groupFormula.seasonal;
      }
      boxCount++;
    } else if (role === "소분" || role === "반박스") {
      const parsed = parseSubdivQuantity(name, spec, unit, groupFormula);
      if (!parsed) {
        failures.push(`[수량 파싱 실패] ${code} ${name} [spec=${spec}]`);
        failCount++;
        continue;
      }
      packRole = "소분";
      packMeta = parsed;
      subdivCount++;
    } else {
      failures.push(`[역할 불명] ${code} ${name} (${role})`);
      failCount++;
      continue;
    }

    // DB 업데이트
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/products?product_code=eq.${code}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          pack_role: packRole,
          pack_meta: packMeta,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!patchRes.ok) {
      failures.push(`[DB 실패] ${code} ${name}: ${patchRes.status}`);
      failCount++;
    }
  }

  console.log(`결과:`);
  console.log(`  박스: ${boxCount}건`);
  console.log(`  소분: ${subdivCount}건`);
  console.log(`  실패: ${failCount}건\n`);
  if (failures.length) {
    console.log(`실패 목록:`);
    for (const f of failures) console.log(`  ${f}`);
  }
}

main().catch(console.error);
