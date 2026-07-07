// 신그룹매핑안.xlsx → products 재태깅
// calc_group(가족번호) + relation_type(A형=소분관계/B형=수량동일) + pack_role + pack_meta(2값: actual_weight+formula_divisor)
// 실행: node scripts/apply-newgroups.js
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const env = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
const URL = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)[1].trim();
const KEY = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)[1].trim();

const XLSX_PATH = "C:/Users/y/Videos/판매가변경영상/자료/그룹재분류/신그룹매핑안.xlsx";

async function patch(code, body) {
  const res = await fetch(`${URL}/rest/v1/products?product_code=eq.${code}`, {
    method: "PATCH",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${code}: HTTP ${res.status} ${await res.text()}`);
}

(async () => {
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["신그룹매핑안"], { header: 1, defval: "" });
  // 헤더: 0신그룹 1유형 2역할 3코드 4상품명 5규격 6단위 7소분수량 8반박스 9실제무게 10공식수 11단위기준 12확인필요

  // 가족별 박스 메타 수집 (소분의 unit_kind 는 가족 박스의 단위기준을 따름)
  const famUnit = {};
  for (const r of rows.slice(1)) {
    if (String(r[2]).trim() === "박스") famUnit[r[0]] = String(r[11]).trim() || "kg";
  }

  let ok = 0, fail = 0;
  const updates = [];
  for (const r of rows.slice(1)) {
    const code = String(r[3]).trim();
    if (!code) continue;
    const calcGroup = Number(r[0]);
    const type = String(r[1]).startsWith("B") ? "수량동일" : "소분관계";
    const role = String(r[2]).trim(); // 박스/소분
    const unitKind = famUnit[r[0]] || "kg";

    let packMeta;
    if (role === "박스") {
      if (code === "003362") {
        // 가지 — 계절 분기 (기존 seasonal 구조 유지 + actual 확장)
        packMeta = {
          formula_divisor: 30,
          actual_weight: 30,
          unit_kind: "개",
          seasonal: {
            winter_months: [11, 12, 1, 2, 3, 4, 5, 6],
            winter_divisor: 30, summer_divisor: 45,
            winter_actual: 30, summer_actual: 45,
            note: "동절기 5kg박스 30개(11-6월) / 하절기 8kg박스 45개(7-10월)",
          },
        };
      } else {
        packMeta = {
          formula_divisor: Number(r[10]),
          actual_weight: Number(r[9]),
          unit_kind: unitKind,
        };
        if (!Number.isFinite(packMeta.formula_divisor) || !Number.isFinite(packMeta.actual_weight)) {
          console.error(`값 오류(박스): ${code} 실제무게=${r[9]} 공식수=${r[10]}`);
          fail++; continue;
        }
      }
    } else {
      const qty = Number(r[7]);
      if (!Number.isFinite(qty) || qty <= 0) {
        console.error(`값 오류(소분): ${code} 수량=${r[7]}`);
        fail++; continue;
      }
      packMeta = { quantity: qty, unit_kind: unitKind };
      if (String(r[8]).trim() === "Y") packMeta.half_box = true;
    }

    updates.push({ code, body: { calc_group: calcGroup, relation_type: type, pack_role: role, pack_meta: packMeta } });
  }

  console.log(`업데이트 대상: ${updates.length}건`);
  for (const u of updates) {
    try { await patch(u.code, u.body); ok++; }
    catch (e) { console.error(e.message); fail++; }
  }
  console.log(`완료: ${ok} 성공 / ${fail} 실패`);
})();
