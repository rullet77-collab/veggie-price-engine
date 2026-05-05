"use client";

import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { List } from "react-window";

// ── Types ──

type Product = {
  product_code: string;
  product_name: string;
  spec: string | null;
  unit: string | null;
  category_name: string | null;
  price_date: string;
  product_type: string;

  product_group: number | null;
  is_key_item: boolean;
  is_event_item: boolean;
  target_margin_rate: number | null;

  prev_purchase_price: number | null;
  purchase_price: number | null;
  change_amount: number;
  change_rate: number;

  purchase_prices_7d: number[];
  max_price_7d: number | null;
  today_purchase: number | null;
  purchase_history_8d: Array<{
    date: string;
    price: number | null;
    source: "actual" | "inferred" | "missing";
    anchor: string | null;
  }>;

  prev_selling_price: number | null;
  selling_price: number;
  margin_rate: number;

  target_price: number | null;

  recommended_price: number | null;
  recommended_margin: number | null;
  recommend_reason: string;

  sinsunhang_price: number | null;
  sinsunhang_margin: number | null;
  baemin_price: number | null;
  baemin_margin: number | null;

  monthly_qty: number | null;
  month_1_qty: number | null;
  month_2_qty: number | null;
  month_3_qty: number | null;
  current_month_qty: number | null;
  prev_3month_pct: string | null;
  learned_tier?: number | null;
  pack_role?: "박스" | "소분" | null;
  pack_meta?: unknown;
};

type SortKey = keyof Product;
type SortDir = "asc" | "desc";

// ── Helpers ──

function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  return n.toLocaleString();
}
function pct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  return (n * 100).toFixed(1) + "%";
}
function changeClass(val: number): string {
  if (val > 0) return "text-red-600";
  if (val < 0) return "text-blue-600";
  return "text-gray-400";
}
function marginClass(rate: number): string {
  if (rate < 0.1) return "text-red-600 font-semibold";
  if (rate < 0.15) return "text-orange-500";
  if (rate >= 0.25) return "text-green-600";
  return "";
}

type HistEntry = {
  date: string;
  price: number | null;
  source: "actual" | "inferred" | "missing";
  anchor: string | null;
};

function Sparkline({
  history,
  fallbackPrices,
}: {
  history?: HistEntry[];
  fallbackPrices?: number[];
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  // history 우선, 없으면 fallbackPrices 로 합성
  const hist: HistEntry[] = history && history.length > 0
    ? history
    : (fallbackPrices || []).map((p, i) => ({ date: `slot-${i}`, price: p, source: "actual" as const, anchor: null }));

  const valid = hist.filter((h) => h.price != null && h.price > 0) as Array<HistEntry & { price: number }>;
  if (valid.length < 2) return <span className="text-gray-300 text-xs">-</span>;

  const prices = valid.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 60, h = 20;

  const pts = valid.map((entry, i) => {
    const x = (i / (valid.length - 1)) * w;
    const y = h - ((entry.price - min) / range) * (h - 2) - 1;
    return { x, y, entry };
  });

  const lineColor =
    valid[valid.length - 1].price > valid[0].price
      ? "#ef4444"
      : valid[valid.length - 1].price < valid[0].price
        ? "#3b82f6"
        : "#9ca3af";

  const polylinePoints = pts.map((p) => `${p.x},${p.y}`).join(" ");

  const showTip = (e: React.MouseEvent) => {
    setTip({ x: e.clientX, y: e.clientY });
  };
  const hideTip = () => setTip(null);

  return (
    <span
      className="inline-block relative"
      onMouseEnter={showTip}
      onMouseMove={showTip}
      onMouseLeave={hideTip}
    >
      <svg width={w} height={h} className="inline-block">
        <polyline points={polylinePoints} fill="none" stroke={lineColor} strokeWidth="1.2" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={1.8}
            fill={p.entry.source === "actual" ? "#000" : "#ef4444"}
          />
        ))}
      </svg>
      {tip && typeof window !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[9999] bg-white border border-gray-300 rounded shadow-lg px-2 py-1 pointer-events-none"
            style={{ left: tip.x + 12, top: tip.y + 12, fontSize: "11px", minWidth: "120px" }}
          >
            <div className="text-gray-500 mb-0.5 text-[10px]">7일 매입가 (과거→현재)</div>
            {hist.map((h, i) => {
              const dateLabel = h.date.length >= 10 ? h.date.slice(5) : h.date;
              if (h.price == null) {
                return (
                  <div key={i} className="text-gray-300">
                    {dateLabel}: -
                  </div>
                );
              }
              const cls = h.source === "actual" ? "text-black" : "text-red-600";
              const tag = h.source === "inferred" ? " (계산)" : "";
              return (
                <div key={i} className={cls}>
                  <span className="font-mono">{dateLabel}</span>: {h.price.toLocaleString()}원{tag}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}

// ── 인라인 편집 셀 ──

function EditableCell({
  value,
  productCode,
  apiUrl,
  fieldName,
  onSaved,
  isPercent,
  className: extraClass,
}: {
  value: number;
  productCode: string;
  apiUrl: string;
  fieldName: string;
  onSaved: (code: string, newValue: number) => void;
  isPercent?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(isPercent ? String(value) : String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const save = async () => {
    const newVal = isPercent ? parseFloat(Number(draft).toFixed(1)) : Math.round(Number(draft));
    if (isNaN(newVal) || newVal < 0) {
      setDraft(String(value));
      setEditing(false);
      return;
    }
    if (newVal === value) {
      setEditing(false);
      return;
    }

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_code: productCode, [fieldName]: newVal }),
      });
      if (res.ok) {
        onSaved(productCode, newVal);
      }
    } catch {
      // ignore
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step={isPercent ? "0.1" : "1"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setDraft(String(value)); setEditing(false); }
        }}
        className="w-16 px-1 py-0 text-xs text-right border border-blue-400 rounded bg-blue-50 outline-none"
      />
    );
  }

  const display = isPercent
    ? (value > 0 ? value.toFixed(1) + "%" : <span className="text-gray-300">-</span>)
    : (value > 0 ? fmt(value) : <span className="text-gray-300">-</span>);

  return (
    <span
      onClick={() => { setDraft(String(value)); setEditing(true); }}
      className={`cursor-pointer hover:bg-yellow-100 px-1 py-0.5 rounded ${extraClass || "font-semibold"}`}
      title="클릭하여 편집"
    >
      {display}
    </span>
  );
}

// ── Column definitions ──

// 그룹 expand UI 상태가 행에 주입됨 — 자식 표시용
type ProductRow = Product & {
  _isChild?: boolean;
  _isAnchor?: boolean;
  // Phase 2: 자식 행에 가격 관계식 검증 메타 주입
  _expectedFromAnchor?: number | null;   // 박스 → 자기 환산 예상가
  _conversionNote?: string | null;       // "÷2", "×5/30", "×1/5kg" 등
  _conversionDelta?: number | null;      // (실제-예상)/예상  (양수=비싸짐)
  _anomaly?: string | null;              // "등급역전" / "환산불일치 +20%" / null
  _anchorBoxPrice?: number | null;
  _anchorBoxName?: string | null;
};

// Phase 2: 환산 helper — 박스 → 자기 단위 예상가
function computeExpectedFromBox(
  boxPrice: number,
  boxSpec: string | null | undefined,
  boxPackMeta: unknown,
  myUnit: string | null | undefined,
  mySpec: string | null | undefined,
  myName: string | null | undefined,
  date: Date,
): { expected: number; note: string } | null {
  if (!boxPrice || boxPrice <= 0) return null;

  // 박스 → 반박스: ÷2
  if (myUnit === "반박스") {
    return { expected: Math.ceil(boxPrice / 2 / 10) * 10, note: "÷2" };
  }

  // 박스 → 봉/단/통: pack_meta.formula_divisor + 자기 quantity
  // boxPackMeta = { formula_divisor: 30, seasonal: { winter_months, winter_divisor, summer_divisor } }
  let divisor: number | null = null;
  if (boxPackMeta && typeof boxPackMeta === "object") {
    const meta = boxPackMeta as { formula_divisor?: number; seasonal?: { winter_months?: number[]; winter_divisor?: number; summer_divisor?: number } };
    if (meta.seasonal) {
      const m = date.getMonth() + 1;
      divisor = meta.seasonal.winter_months?.includes(m) ? meta.seasonal.winter_divisor ?? null : meta.seasonal.summer_divisor ?? null;
    }
    if (!divisor && meta.formula_divisor) divisor = meta.formula_divisor;
  }

  // 자기 수량 추출 (상품명 또는 spec 에서 "N개" / "Nkg" / "Nkg±")
  const nameStr = (myName || "") + " " + (mySpec || "");
  const piecesMatch = nameStr.match(/(\d+)\s*개/);
  const kgMatch = nameStr.match(/(\d+\.?\d*)\s*[kK][gG]/);

  if (divisor && piecesMatch) {
    const qty = parseInt(piecesMatch[1]);
    return { expected: Math.ceil((boxPrice * qty / divisor) / 10) * 10, note: `×${qty}/${divisor}개` };
  }

  // kg 환산: 박스spec kg / 자기 kg
  const boxKgMatch = (boxSpec || "").match(/(\d+\.?\d*)\s*[kK][gG]/);
  if (boxKgMatch && kgMatch) {
    const boxKg = parseFloat(boxKgMatch[1]);
    const myKg = parseFloat(kgMatch[1]);
    if (boxKg > 0 && myKg > 0) {
      return { expected: Math.ceil((boxPrice * myKg / boxKg) / 10) * 10, note: `×${myKg}kg/${boxKg}kg` };
    }
  }

  return null;
}

type Column = {
  key: string;
  label: string;
  group: string;
  width: string;
  align?: "left" | "right" | "center";
  render: (p: ProductRow, callbacks: {
    onPriceSaved: (code: string, price: number) => void;
    onMarginSaved: (code: string, margin: number) => void;
    expandedGroups?: Set<number>;
    toggleGroup?: (g: number) => void;
  }) => React.ReactNode;
  sortable?: boolean;
};

const COLUMNS: Column[] = [
  { key: "product_group", label: "그룹", group: "기본", width: "w-12", align: "center", sortable: true,
    render: (p, ctx) => {
      if (!p.product_group) return <span className="text-gray-300">-</span>;
      // 학습 tier 색 dot — null=회색
      const tier = p.learned_tier;
      const tierDot = tier === 1
        ? "bg-emerald-500"
        : tier === 2 ? "bg-amber-400"
        : tier === 3 ? "bg-rose-400"
        : "bg-gray-300";
      const tierTip = tier ? `학습 tier ${tier}` : "tier 미학습";

      if (p._isChild) {
        return (
          <span className="text-gray-400 text-[10px] inline-flex items-center gap-0.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${tierDot}`} title={tierTip} />
            └ {p.product_group}
          </span>
        );
      }
      const expanded = ctx.expandedGroups?.has(p.product_group);
      return (
        <span className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.toggleGroup?.(p.product_group!); }}
            className="text-gray-400 hover:text-blue-600 cursor-pointer text-[8px] font-mono w-2.5 leading-none select-none"
            title={expanded ? "그룹 접기" : "그룹 멤버 펼치기"}
          >
            {expanded ? "▼" : "▶"}
          </button>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${tierDot}`} title={tierTip} />
          <span>{p.product_group}</span>
        </span>
      );
    } },
  { key: "product_code", label: "코드", group: "기본", width: "w-16", sortable: true,
    render: (p) => <span className="font-mono text-xs">{p.product_code}</span> },
  { key: "product_name", label: "상품명", group: "기본", width: "w-44", sortable: true,
    render: (p) => (
      <span className={p.is_key_item ? "font-semibold text-blue-700" : ""}>
        {p.product_name}
        {p.is_event_item && <span className="ml-1 text-orange-500 text-[10px]">행사</span>}
      </span>
    ) },
  { key: "spec", label: "규격", group: "기본", width: "w-24",
    render: (p) => <span className="text-gray-600">{p.spec || "-"}</span> },
  { key: "unit", label: "단위", group: "기본", width: "w-12", align: "center",
    render: (p) => p.unit || "-" },
  // 매입가
  { key: "prev_purchase_price", label: "기존", group: "매입가", width: "w-16", align: "right", sortable: true,
    render: (p) => fmt(p.prev_purchase_price) },
  { key: "purchase_price", label: "변경", group: "매입가", width: "w-16", align: "right", sortable: true,
    render: (p) => <span className={p.change_amount !== 0 ? "font-semibold" : ""}>{fmt(p.purchase_price)}</span> },
  { key: "change_rate", label: "변동률", group: "매입가", width: "w-14", align: "right", sortable: true,
    render: (p) => <span className={changeClass(p.change_rate)}>{p.change_rate !== 0 ? (p.change_rate > 0 ? "+" : "") + pct(p.change_rate) : "-"}</span> },
  { key: "change_amount", label: "변동액", group: "매입가", width: "w-14", align: "right", sortable: true,
    render: (p) => <span className={changeClass(p.change_amount)}>{p.change_amount !== 0 ? (p.change_amount > 0 ? "+" : "") + fmt(p.change_amount) : "-"}</span> },
  { key: "purchase_prices_7d", label: "7일동향", group: "매입가", width: "w-16", align: "center",
    render: (p) => <Sparkline history={p.purchase_history_8d} fallbackPrices={p.purchase_prices_7d} /> },
  { key: "max_price_7d", label: "7일최고", group: "매입가", width: "w-14", align: "right", sortable: true,
    render: (p) => fmt(p.max_price_7d) },
  { key: "today_purchase", label: "오늘매입", group: "매입가", width: "w-14", align: "right", sortable: true,
    render: (p) => <span className={p.today_purchase ? "" : "text-gray-300"}>{fmt(p.today_purchase)}</span> },
  // 판매가
  { key: "prev_selling_price", label: "기존판매가", group: "판매가", width: "w-16", align: "right", sortable: true,
    render: (p) => fmt(p.prev_selling_price) },
  { key: "selling_price", label: "판매가", group: "판매가", width: "w-20", align: "right", sortable: true,
    render: (p, { onPriceSaved }) => <EditableCell value={p.selling_price} productCode={p.product_code} apiUrl="/api/products/update-selling-price" fieldName="selling_price" onSaved={onPriceSaved} /> },
  { key: "margin_rate", label: "수익률", group: "판매가", width: "w-14", align: "right", sortable: true,
    render: (p) => <span className={marginClass(p.margin_rate)}>{pct(p.margin_rate)}</span> },
  // 수익률일괄변경
  { key: "target_margin_rate", label: "일괄변경용", group: "일괄변경", width: "w-14", align: "right", sortable: true,
    render: (p, { onMarginSaved }) => <EditableCell value={p.target_margin_rate || 0} productCode={p.product_code} apiUrl="/api/products/update-target-margin" fieldName="target_margin_rate" onSaved={onMarginSaved} isPercent /> },
  { key: "target_price", label: "변경시가격", group: "일괄변경", width: "w-16", align: "right", sortable: true,
    render: (p) => fmt(p.target_price) },
  // Claude 추천
  { key: "recommended_price", label: "추천가", group: "추천", width: "w-16", align: "right", sortable: true,
    render: (p) => {
      if (!p.recommended_price || !p.selling_price) return <span className="text-gray-300">-</span>;
      const diff = p.recommended_price - p.selling_price;
      return <span className={diff > 0 ? "text-red-600 font-semibold" : diff < 0 ? "text-blue-600 font-semibold" : "text-gray-500"}>{fmt(p.recommended_price)}</span>;
    } },
  { key: "recommend_reason", label: "사유", group: "추천", width: "w-12", align: "center",
    render: (p) => {
      // 자식 행 + 환산식 메타가 있으면 환산식 + 이상치 표시
      if (p._isChild && p._conversionNote) {
        const exp = p._expectedFromAnchor;
        const delta = p._conversionDelta ?? null;
        const ok = delta != null && Math.abs(delta) <= 0.2;
        const icon = p._anomaly ? "⚠️" : ok ? "✓" : "";
        const cls = p._anomaly
          ? "text-red-600"
          : ok ? "text-emerald-600" : "text-gray-500";
        const tip = p._anomaly
          ? `이상치: ${p._anomaly} (anchor ${p._anchorBoxName?.slice(0, 12) ?? ""} ${(p._anchorBoxPrice || 0).toLocaleString()}원 → 예상 ${exp?.toLocaleString() ?? "-"}원, 실제 ${(p.purchase_price || 0).toLocaleString()}원)`
          : `${p._anchorBoxName?.slice(0, 12) ?? ""} → ${p._conversionNote} = ${exp?.toLocaleString() ?? "-"}원`;
        return (
          <span className={`text-[10px] ${cls}`} title={tip}>
            {p._conversionNote} {icon}
          </span>
        );
      }
      const colors: Record<string, string> = { "매입↑": "text-red-600", "하락추세": "text-blue-600", "관망": "text-amber-600", "저수익": "text-orange-600", "최소마진": "text-red-700", "유지": "text-gray-400" };
      return <span className={`text-[10px] ${colors[p.recommend_reason] || ""}`}>{p.recommend_reason || "-"}</span>;
    } },
  { key: "recommended_margin", label: "수익률", group: "추천", width: "w-14", align: "right", sortable: true,
    render: (p) => {
      if (p.recommended_margin == null) return <span className="text-gray-300">-</span>;
      // 기준수익률 대비 차이(%p)를 색으로 강조
      const target = p.target_margin_rate ? Number(p.target_margin_rate) / 100 : null;
      const diffPp = target != null ? (p.recommended_margin - target) * 100 : 0;
      const cls = marginClass(p.recommended_margin);
      const diffStr = target != null ? ` (${diffPp >= 0 ? "+" : ""}${diffPp.toFixed(1)}%p)` : "";
      return (
        <span className={cls} title={`기준 ${target != null ? (target * 100).toFixed(1) : "-"}% 대비${diffStr}`}>
          {pct(p.recommended_margin)}
        </span>
      );
    } },
  // 플랫폼
  { key: "sinsunhang_price", label: "신선행", group: "플랫폼", width: "w-16", align: "right",
    render: (p) => fmt(p.sinsunhang_price) },
  { key: "sinsunhang_margin", label: "수익률", group: "플랫폼", width: "w-14", align: "right",
    render: (p) => <span className={marginClass(p.sinsunhang_margin || 0)}>{pct(p.sinsunhang_margin)}</span> },
  { key: "baemin_price", label: "배민", group: "플랫폼", width: "w-16", align: "right",
    render: (p) => fmt(p.baemin_price) },
  // 매출
  { key: "month_1_qty", label: "1월", group: "매출", width: "w-12", align: "right", sortable: true,
    render: (p) => fmt(p.month_1_qty) },
  { key: "month_2_qty", label: "2월", group: "매출", width: "w-12", align: "right", sortable: true,
    render: (p) => fmt(p.month_2_qty) },
  { key: "month_3_qty", label: "3월", group: "매출", width: "w-12", align: "right", sortable: true,
    render: (p) => fmt(p.month_3_qty) },
  { key: "current_month_qty", label: "이번달", group: "매출", width: "w-12", align: "right", sortable: true,
    render: (p) => <span className="font-semibold">{fmt(p.current_month_qty)}</span> },
  { key: "prev_3month_pct", label: "3개월대비", group: "매출", width: "w-16", align: "right", sortable: true,
    render: (p) => {
      if (!p.prev_3month_pct) return <span className="text-gray-300">-</span>;
      const s = p.prev_3month_pct;
      const isUp = s.includes("▲") || s.includes("+");
      const isDown = s.includes("▼") || s.includes("-");
      return <span className={`text-[10px] ${isUp ? "text-red-600" : isDown ? "text-blue-600" : ""}`}>{s}</span>;
    } },
];

// ── Column pixel widths (matching tailwind w-XX classes) ──
const COL_WIDTHS: Record<string, number> = {
  product_group: 48,
  product_code: 64,
  product_name: 176,
  spec: 96,
  unit: 48,
  prev_purchase_price: 64,
  purchase_price: 64,
  change_rate: 56,
  change_amount: 56,
  purchase_prices_7d: 64,
  max_price_7d: 56,
  today_purchase: 56,
  prev_selling_price: 64,
  selling_price: 80,
  margin_rate: 56,
  target_margin_rate: 56,
  target_price: 64,
  recommended_price: 64,
  recommend_reason: 48,
  recommended_margin: 56,
  sinsunhang_price: 64,
  sinsunhang_margin: 56,
  baemin_price: 64,
  month_1_qty: 48,
  month_2_qty: 48,
  month_3_qty: 48,
  current_month_qty: 48,
  prev_3month_pct: 64,
};

const COL_GROUPS: { label: string; group: string; color: string }[] = [
  { label: "기본정보", group: "기본", color: "bg-gray-100" },
  { label: "매입가", group: "매입가", color: "bg-blue-50" },
  { label: "판매가", group: "판매가", color: "bg-green-50" },
  { label: "수익률일괄변경", group: "일괄변경", color: "bg-teal-50" },
  { label: "Claude 추천", group: "추천", color: "bg-violet-50" },
  { label: "플랫폼", group: "플랫폼", color: "bg-purple-50" },
  { label: "매출", group: "매출", color: "bg-amber-50" },
];

// 그룹별 합산 너비 (px)
const COL_GROUP_WIDTHS: Record<string, number> = {};
for (const g of COL_GROUPS) {
  COL_GROUP_WIDTHS[g.group] = COLUMNS
    .filter((c) => c.group === g.group)
    .reduce((sum, c) => sum + (COL_WIDTHS[c.key] || 60), 0);
}

// ── Virtual scroll constants ──
const ROW_HEIGHT = 28;
const MAX_TABLE_HEIGHT = 700;
const TABLE_MIN_WIDTH = 1600;

// ── Virtual Row (for react-window v2) ──
interface VirtualRowProps {
  items: ProductRow[];
  onPriceSaved: (code: string, price: number) => void;
  onMarginSaved: (code: string, margin: number) => void;
  expandedGroups: Set<number>;
  toggleGroup: (g: number) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function VirtualRow(props: any) {
  const { index, style, items, onPriceSaved, onMarginSaved, expandedGroups, toggleGroup } = props as {
    index: number;
    style: React.CSSProperties;
  } & VirtualRowProps;
  const p = items[index];
  if (!p) return null;
  // 자식 행은 시각 구분 (얇은 들여쓰기 효과 + 옅은 배경)
  const childBg = p._isChild ? "bg-violet-50/40" : (index % 2 === 0 ? "bg-white" : "bg-gray-50/30");
  return (
    <div
      style={style}
      className={`flex items-center border-b border-gray-100 hover:bg-blue-50/30 text-xs whitespace-nowrap ${childBg} ${
        p.change_amount !== 0 && !p._isChild ? "bg-yellow-50/40" : ""
      }`}
    >
      {COLUMNS.map((col) => (
        <div
          key={col.key}
          className={`flex-shrink-0 px-2 py-1 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}
          style={{ width: COL_WIDTHS[col.key] || 60 }}
        >
          {col.render(p, { onPriceSaved, onMarginSaved, expandedGroups, toggleGroup })}
        </div>
      ))}
    </div>
  );
}

// ── Main Page ──

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("전체");
  const [productType, setProductType] = useState<"전체" | "야채" | "공산">("야채");
  const [sortKey, setSortKey] = useState<SortKey>("product_code");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [onlyKeyItems, setOnlyKeyItems] = useState(false);
  const [onlyLowMargin, setOnlyLowMargin] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const toggleGroup = useCallback((g: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  // 검색 디바운스 (300ms)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // 데이터 로드 (검색은 클라이언트에서)
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category && category !== "전체") params.set("category", category);
      const res = await fetch(`/api/products?${params}`);
      const data = await res.json();
      if (Array.isArray(data)) setProducts(data);
    } catch (err) {
      console.error("Fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 판매가 수정 콜백
  const handlePriceSaved = useCallback((code: string, newPrice: number) => {
    setProducts((prev) =>
      prev.map((p) => {
        if (p.product_code !== code) return p;
        const purchasePrice = p.purchase_price || 0;
        const newMargin = newPrice > 0 ? 1 - purchasePrice / newPrice : 0;
        return { ...p, selling_price: newPrice, margin_rate: newMargin };
      })
    );
  }, []);

  // 목표수익률 수정 콜백
  const handleMarginSaved = useCallback((code: string, newMargin: number) => {
    setProducts((prev) =>
      prev.map((p) => {
        if (p.product_code !== code) return p;
        const purchasePrice = p.purchase_price || 0;
        const newTargetPrice = newMargin > 0 && purchasePrice > 0
          ? Math.ceil(purchasePrice / (1 - newMargin / 100) / 10) * 10
          : null;
        return { ...p, target_margin_rate: newMargin, target_price: newTargetPrice };
      })
    );
  }, []);

  // 클라이언트 사이드 필터 + 정렬
  const filtered = useMemo(() => {
    let list = products;

    // 야채/공산 필터
    if (productType !== "전체") {
      list = list.filter((p) => p.product_type === productType);
    }

    // 검색 (클라이언트사이드)
    if (debouncedSearch) {
      const kw = debouncedSearch.toLowerCase();
      list = list.filter(
        (p) =>
          (p.product_name || "").toLowerCase().includes(kw) ||
          p.product_code.includes(kw)
      );
    }

    if (onlyChanged) list = list.filter((p) => p.change_amount !== 0);
    if (onlyKeyItems) list = list.filter((p) => p.is_key_item);
    if (onlyLowMargin) list = list.filter((p) => p.margin_rate > 0 && p.margin_rate < 0.195);

    return list.sort((a, b) => {
      const av = a[sortKey as keyof Product];
      const bv = b[sortKey as keyof Product];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [products, sortKey, sortDir, onlyChanged, onlyKeyItems, onlyLowMargin, debouncedSearch, productType]);

  // 그룹 expand 가 적용된 표시용 행 배열 — 자식은 anchor 바로 아래에 삽입
  // Phase 2: 자식에 박스→자기 환산 예상가 + 이상치 플래그 주입
  const displayRows = useMemo<ProductRow[]>(() => {
    if (expandedGroups.size === 0) return filtered as ProductRow[];
    const seenGroups = new Set<number>();
    const out: ProductRow[] = [];
    const unitOrder = (u: string | null | undefined): number =>
      u === "박스" ? 0 : u === "반박스" ? 1 : u === "망" ? 2 : u === "봉" ? 3 : u === "단" ? 4 : u === "통" ? 5 : 6;
    const today = new Date();
    for (const p of filtered) {
      const g = p.product_group;
      if (g != null && expandedGroups.has(g)) {
        if (seenGroups.has(g)) continue;
        seenGroups.add(g);
        out.push({ ...p, _isAnchor: true });

        // 그룹의 모든 멤버 (자기 포함)
        const allMembers = products.filter((m) => m.product_group === g);

        // 그룹 anchor 박스: pack_role=박스 + pack_meta 보유 + 매입가 > 0 인 박스 멤버 (가격 가장 비싼 박스 = T1)
        const boxAnchors = allMembers
          .filter((m) => m.unit === "박스" && (m.purchase_price || 0) > 0)
          .sort((a, b) => (b.purchase_price || 0) - (a.purchase_price || 0));
        const boxAnchor = boxAnchors[0] || null;

        const members = allMembers
          .filter((m) => m.product_code !== p.product_code)
          .sort((a, b) => {
            const ua = unitOrder(a.unit), ub = unitOrder(b.unit);
            if (ua !== ub) return ua - ub;
            const at = a.learned_tier ?? 9, bt = b.learned_tier ?? 9;
            if (at !== bt) return at - bt;
            return (a.product_code || "").localeCompare(b.product_code || "");
          });

        for (const m of members) {
          const child: ProductRow = { ...m, _isChild: true };

          // 환산식 + 이상치 계산 (박스 anchor 가 있고 자기는 박스가 아닐 때)
          if (boxAnchor && m.unit !== "박스" && (boxAnchor.purchase_price || 0) > 0) {
            const conv = computeExpectedFromBox(
              boxAnchor.purchase_price as number,
              boxAnchor.spec,
              boxAnchor.pack_meta,
              m.unit,
              m.spec,
              m.product_name,
              today,
            );
            if (conv) {
              child._expectedFromAnchor = conv.expected;
              child._conversionNote = conv.note;
              child._anchorBoxPrice = boxAnchor.purchase_price;
              child._anchorBoxName = boxAnchor.product_name;
              const actual = m.purchase_price || 0;
              if (actual > 0 && conv.expected > 0) {
                const delta = (actual - conv.expected) / conv.expected;
                child._conversionDelta = delta;
                if (Math.abs(delta) > 0.2) {
                  child._anomaly = `환산 ±${(delta * 100).toFixed(0)}%`;
                }
              }
            }
          }

          // 등급 역전 감지 (학습 tier 기준): 자기 박스가 anchor 박스보다 비쌈 = 역전
          if (m.unit === "박스" && boxAnchor && m.product_code !== boxAnchor.product_code) {
            const aLT = boxAnchor.learned_tier;
            const mLT = m.learned_tier;
            if (aLT != null && mLT != null && mLT < aLT) {
              child._anomaly = (child._anomaly ? child._anomaly + " / " : "") + "tier역전";
            }
          }

          out.push(child);
        }
      } else {
        out.push(p as ProductRow);
      }
    }
    return out;
  }, [filtered, products, expandedGroups]);

  const priceDate = products.length > 0 ? products[0].price_date : "";

  const stats = useMemo(() => {
    const total = filtered.length;
    const changed = filtered.filter((p) => p.change_amount !== 0).length;
    const up = filtered.filter((p) => p.change_amount > 0).length;
    const down = filtered.filter((p) => p.change_amount < 0).length;
    const lowMargin = filtered.filter((p) => p.margin_rate > 0 && p.margin_rate < 0.1).length;
    return { total, changed, up, down, lowMargin };
  }, [filtered]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  // 수익률일괄변경 실행 — 현재 필터된 상품들의 판매가를 target_price 로 일괄 변경
  // (역마진/긴급 상황용. 판매가가 수익률일괄변경용 값과 불일치하더라도 사용자가 수동으로 실행)
  const handleBulkApplyTarget = useCallback(async () => {
    // target_price 가 있고 현재 판매가와 다른 상품만 대상
    const candidates = filtered.filter(
      (p) =>
        p.target_price != null &&
        p.target_price > 0 &&
        p.selling_price !== p.target_price
    );

    if (candidates.length === 0) {
      alert("일괄변경 대상이 없습니다. (필터를 확인해주세요)");
      return;
    }

    const sampleLines = candidates
      .slice(0, 5)
      .map(
        (p) =>
          `  • ${p.product_name} (${p.product_code}) : ${fmt(p.selling_price)} → ${fmt(p.target_price)}`
      )
      .join("\n");
    const more = candidates.length > 5 ? `\n  ... 외 ${candidates.length - 5}개` : "";

    const confirmed = window.confirm(
      `현재 필터된 ${candidates.length}개 상품의 판매가를 '수익률일괄변경용' 기준 가격으로 즉시 변경합니다.\n\n${sampleLines}${more}\n\n이 작업은 역마진/긴급 상황용입니다. 계속하시겠습니까?`
    );
    if (!confirmed) return;

    setBulkApplying(true);
    try {
      const res = await fetch("/api/products/bulk-apply-target", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_codes: candidates.map((p) => p.product_code),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`오류: ${data.error || "일괄변경 실패"}`);
        return;
      }
      alert(
        `완료: ${data.applied}건 적용${data.skipped ? `, ${data.skipped}건 스킵` : ""}`
      );
      // 목록 갱신
      await fetchData();
    } catch (err) {
      console.error(err);
      alert("네트워크 오류가 발생했습니다.");
    } finally {
      setBulkApplying(false);
    }
  }, [filtered, fetchData]);

  const categories = useMemo(() => {
    const cats = new Set(products.map((p) => p.category_name).filter(Boolean));
    return ["전체", ...Array.from(cats).sort()] as string[];
  }, [products]);

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-[1800px] mx-auto px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">전체상품 (야채용)</h1>
            <p className="text-xs text-gray-500">{priceDate && `기준일: ${priceDate}`} | {stats.total}개 상품</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="px-2 py-1 bg-red-50 text-red-700 rounded">상승 {stats.up}</span>
            <span className="px-2 py-1 bg-blue-50 text-blue-700 rounded">하락 {stats.down}</span>
            <span className="px-2 py-1 bg-gray-100 text-gray-600 rounded">변동 {stats.changed}</span>
            {stats.lowMargin > 0 && <span className="px-2 py-1 bg-orange-50 text-orange-700 rounded">저수익 {stats.lowMargin}</span>}
          </div>
        </div>

        {/* 필터 바 */}
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <input
            type="text"
            placeholder="상품명 또는 코드 검색..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-56 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white"
          >
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          {/* 야채/공산 필터 */}
          <div className="flex bg-white border border-gray-300 rounded-lg overflow-hidden text-sm">
            {(["야채", "공산", "전체"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setProductType(t)}
                className={`px-3 py-1 ${productType === t ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              >
                {t}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1 text-sm text-gray-600 cursor-pointer">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} className="rounded" />
            변동만
          </label>
          <label className="flex items-center gap-1 text-sm text-gray-600 cursor-pointer">
            <input type="checkbox" checked={onlyKeyItems} onChange={(e) => setOnlyKeyItems(e.target.checked)} className="rounded" />
            주요품목
          </label>
          <label className="flex items-center gap-1 text-sm text-orange-600 cursor-pointer font-medium">
            <input type="checkbox" checked={onlyLowMargin} onChange={(e) => setOnlyLowMargin(e.target.checked)} className="rounded border-orange-400" />
            19.5%미만
          </label>

          {/* 수익률일괄변경 실행 — 역마진/긴급 상황용 수동 버튼 */}
          <button
            onClick={handleBulkApplyTarget}
            disabled={bulkApplying || filtered.length === 0}
            className={`ml-auto px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
              bulkApplying || filtered.length === 0
                ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                : "bg-red-600 text-white border-red-700 hover:bg-red-700 active:bg-red-800"
            }`}
            title="현재 필터된 상품들의 판매가를 수익률일괄변경가(target_price)로 즉시 변경합니다. 역마진/긴급 상황용."
          >
            {bulkApplying ? "적용 중..." : `수익률일괄변경 실행 (${filtered.length})`}
          </button>
        </div>

        {/* 테이블 (가상 스크롤) */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="border border-gray-200 rounded-lg bg-white shadow-sm px-4 py-12 text-center text-gray-400 text-sm">
            {products.length === 0 ? "데이터가 없습니다. RAW DATA를 먼저 업로드해주세요." : "검색 결과가 없습니다."}
          </div>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
            {/* 고정 헤더 (flex 기반, body와 너비 동기화) */}
            <div className="overflow-x-auto overflow-y-hidden" ref={headerRef} style={{ scrollbarWidth: "none" }}>
              <div style={{ minWidth: TABLE_MIN_WIDTH }}>
                {/* 그룹 헤더 */}
                <div className="flex border-b border-gray-200">
                  {COL_GROUPS.map((g) => (
                    <div
                      key={g.group}
                      className={`flex-shrink-0 px-2 py-1 text-center text-[10px] font-medium text-gray-500 ${g.color} border-r border-gray-200 last:border-r-0`}
                      style={{ width: COL_GROUP_WIDTHS[g.group] }}
                    >
                      {g.label}
                    </div>
                  ))}
                </div>
                {/* 컬럼 헤더 */}
                <div className="flex border-b border-gray-300 bg-gray-50">
                  {COLUMNS.map((col) => (
                    <div
                      key={col.key}
                      className={`flex-shrink-0 px-2 py-1.5 text-[10px] font-medium text-gray-600 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"} ${col.sortable ? "cursor-pointer hover:bg-gray-100 select-none" : ""}`}
                      style={{ width: COL_WIDTHS[col.key] || 60 }}
                      onClick={() => col.sortable && handleSort(col.key as SortKey)}
                    >
                      {col.label}
                      {sortKey === col.key && <span className="ml-0.5">{sortDir === "asc" ? "▲" : "▼"}</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* 가상 스크롤 바디 */}
            <div
              className="overflow-x-auto"
              ref={bodyRef}
              onScroll={(e) => {
                if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }}
            >
              <List
                defaultHeight={Math.min(displayRows.length * ROW_HEIGHT, MAX_TABLE_HEIGHT)}
                rowCount={displayRows.length}
                rowHeight={ROW_HEIGHT}
                overscanCount={10}
                rowComponent={VirtualRow}
                rowProps={{ items: displayRows, onPriceSaved: handlePriceSaved, onMarginSaved: handleMarginSaved, expandedGroups, toggleGroup }}
                style={{ height: Math.min(displayRows.length * ROW_HEIGHT, MAX_TABLE_HEIGHT), minWidth: TABLE_MIN_WIDTH }}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
