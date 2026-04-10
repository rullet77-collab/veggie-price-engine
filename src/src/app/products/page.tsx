"use client";

import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";

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

function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return <span className="text-gray-300 text-xs">-</span>;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 60, h = 20;
  const points = prices
    .map((p, i) => `${(i / (prices.length - 1)) * w},${h - ((p - min) / range) * (h - 2) - 1}`)
    .join(" ");
  const color = prices[prices.length - 1] > prices[0] ? "#ef4444" : prices[prices.length - 1] < prices[0] ? "#3b82f6" : "#9ca3af";
  return (
    <svg width={w} height={h} className="inline-block">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
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

type Column = {
  key: string;
  label: string;
  group: string;
  width: string;
  align?: "left" | "right" | "center";
  render: (p: Product, callbacks: {
    onPriceSaved: (code: string, price: number) => void;
    onMarginSaved: (code: string, margin: number) => void;
  }) => React.ReactNode;
  sortable?: boolean;
};

const COLUMNS: Column[] = [
  { key: "product_group", label: "그룹", group: "기본", width: "w-12", align: "center", sortable: true,
    render: (p) => p.product_group ?? "-" },
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
    render: (p) => <Sparkline prices={p.purchase_prices_7d} /> },
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
      const colors: Record<string, string> = { "매입↑": "text-red-600", "하락추세": "text-blue-600", "관망": "text-amber-600", "저수익": "text-orange-600", "최소마진": "text-red-700", "유지": "text-gray-400" };
      return <span className={`text-[10px] ${colors[p.recommend_reason] || ""}`}>{p.recommend_reason || "-"}</span>;
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

const COL_GROUPS = [
  { label: "기본정보", cols: 5, color: "bg-gray-100" },
  { label: "매입가", cols: 7, color: "bg-blue-50" },
  { label: "판매가", cols: 3, color: "bg-green-50" },
  { label: "수익률일괄변경", cols: 2, color: "bg-teal-50" },
  { label: "Claude 추천", cols: 2, color: "bg-violet-50" },
  { label: "플랫폼", cols: 3, color: "bg-purple-50" },
  { label: "매출", cols: 5, color: "bg-amber-50" },
];

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

        {/* 테이블 */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white shadow-sm">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="border-b border-gray-200">
                  {COL_GROUPS.map((g) => (
                    <th key={g.label} colSpan={g.cols} className={`px-2 py-1 text-center text-[10px] font-medium text-gray-500 ${g.color} border-r border-gray-200 last:border-r-0`}>
                      {g.label}
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-gray-300 bg-gray-50">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`px-2 py-1.5 text-[10px] font-medium text-gray-600 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"} ${col.sortable ? "cursor-pointer hover:bg-gray-100 select-none" : ""}`}
                      onClick={() => col.sortable && handleSort(col.key as SortKey)}
                    >
                      {col.label}
                      {sortKey === col.key && <span className="ml-0.5">{sortDir === "asc" ? "\u25B2" : "\u25BC"}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, idx) => (
                  <tr
                    key={p.product_code}
                    className={`border-b border-gray-100 hover:bg-blue-50/30 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50/30"} ${p.change_amount !== 0 ? "bg-yellow-50/40" : ""}`}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key} className={`px-2 py-1 ${col.width} ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
                        {col.render(p, { onPriceSaved: handlePriceSaved, onMarginSaved: handleMarginSaved })}
                      </td>
                    ))}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-gray-400 text-sm">
                      {products.length === 0 ? "데이터가 없습니다. RAW DATA를 먼저 업로드해주세요." : "검색 결과가 없습니다."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
