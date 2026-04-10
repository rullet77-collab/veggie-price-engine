"use client"

import React, { useEffect, useState, useMemo, useCallback, useRef } from "react"

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type Product = {
  product_code: string
  product_name: string
  category_name: string | null
  product_group: number | null
  is_key_item: boolean
  target_margin_rate: number | null
  latest_purchase_price: number | null
  latest_purchase_date: string | null
  latest_selling_price: number | null
  latest_selling_date: string | null
  current_margin_rate: number | null
}

type SortKey = keyof Product | "recommended_price"
type SortDir = "asc" | "desc"

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const CATEGORIES = [
  "전체",
  "엽채류",
  "근채류",
  "과채류",
  "버섯류",
  "가공품",
  "과일류",
  "건채/해조/수산",
] as const

const GROUP_COLORS = [
  "border-blue-500",
  "border-green-500",
  "border-purple-500",
  "border-orange-500",
  "border-pink-500",
  "border-teal-500",
  "border-indigo-500",
  "border-red-400",
  "border-yellow-500",
  "border-cyan-500",
  "border-emerald-500",
  "border-violet-500",
  "border-amber-500",
  "border-lime-500",
  "border-fuchsia-500",
  "border-rose-500",
]

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function formatPrice(v: number | null): string {
  if (v == null) return "-"
  return v.toLocaleString("ko-KR") + "원"
}

function formatRate(v: number | null): string {
  if (v == null) return "-"
  return v.toFixed(1) + "%"
}

function formatDate(v: string | null): string {
  if (!v) return "-"
  return v
}

/** 추천가 = CEIL(매입가 / (1 - 목표수익률/100) / 10) * 10 */
function calcRecommendedPrice(
  purchasePrice: number | null,
  targetMarginRate: number | null
): number | null {
  if (purchasePrice == null || targetMarginRate == null) return null
  if (targetMarginRate >= 100) return null
  const raw = purchasePrice / (1 - targetMarginRate / 100)
  return Math.ceil(raw / 10) * 10
}

/** 수익률 = 1 - (매입가 / 판매가) */
function calcMarginRate(
  purchasePrice: number | null,
  sellingPrice: number | null
): number | null {
  if (purchasePrice == null || sellingPrice == null || sellingPrice === 0)
    return null
  return (1 - purchasePrice / sellingPrice) * 100
}

/** 신선행가 = MAX(CEIL(식봄가 * 0.94 / 10) * 10, CEIL(매입가 / 0.9 / 10) * 10) */
function calcSinsunPrice(
  sibomPrice: number,
  purchasePrice: number | null
): number {
  const fromSibom = Math.ceil((sibomPrice * 0.94) / 10) * 10
  if (purchasePrice == null) return fromSibom
  const fromPurchase = Math.ceil(purchasePrice / 0.9 / 10) * 10
  return Math.max(fromSibom, fromPurchase)
}

function getGroupColorClass(
  groupNumber: number,
  groupIndexMap: Map<number, number>
): string {
  let idx = groupIndexMap.get(groupNumber)
  if (idx == null) {
    idx = groupIndexMap.size % GROUP_COLORS.length
    groupIndexMap.set(groupNumber, idx)
  }
  return GROUP_COLORS[idx]
}

// ──────────────────────────────────────────────
// Toast Component
// ──────────────────────────────────────────────

function Toast({
  message,
  type,
  onClose,
}: {
  message: string
  type: "success" | "error"
  onClose: () => void
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <div
      className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
        type === "success"
          ? "bg-green-600 text-white"
          : "bg-red-600 text-white"
      }`}
    >
      {message}
    </div>
  )
}

// ──────────────────────────────────────────────
// Group Sync Modal
// ──────────────────────────────────────────────

function GroupSyncModal({
  groupNumber,
  changedProductCode,
  groupProducts,
  onConfirm,
  onCancel,
}: {
  groupNumber: number
  changedProductCode: string
  groupProducts: Product[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const others = groupProducts.filter(
    (p) => p.product_code !== changedProductCode
  )
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <h3 className="text-lg font-bold text-gray-900 mb-2">
          상품그룹 동조화
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          그룹 {groupNumber}의 다른 상품도 함께 조정하시겠습니까?
        </p>
        <div className="mb-4 max-h-32 overflow-y-auto">
          {others.map((p) => (
            <div
              key={p.product_code}
              className="text-xs text-gray-500 py-0.5"
            >
              {p.product_code} - {p.product_name}
            </div>
          ))}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            이 상품만
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            그룹 전체 조정
          </button>
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Platform Prices Expandable Row
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Analysis Detail Panel
// ──────────────────────────────────────────────

type AnalysisData = {
  success: boolean
  product_code: string
  product_name: string
  analysis_date: string | null
  analysis: {
    trend: {
      direction: string | null
      change_rate: number | null
      base_price: number | null
      trimmed_avg: number | null
    }
    volatility: {
      level: string | null
      cv: number | null
      data_days: number
    }
    week_stats: {
      max: number | null
      min: number | null
      median: number | null
      weighted_avg: number | null
      range_rate: number | null
    }
    strategy: {
      policy: string | null
      total_score: number
      margin_adjustment: number
      score_details: { signal: string; detail: string; score: number }[]
    }
    sales_trend: Record<string, unknown> | null
    recent_prices: { price_date: string; purchase_price: number }[]
  } | null
  message?: string
}

function trendBadge(trend: string | null) {
  if (!trend) return <span className="text-gray-400 text-xs">-</span>
  const colors: Record<string, string> = {
    "급등": "bg-red-100 text-red-700",
    "상승": "bg-orange-100 text-orange-700",
    "보합": "bg-gray-100 text-gray-700",
    "하락": "bg-blue-100 text-blue-700",
    "급락": "bg-purple-100 text-purple-700",
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[trend] ?? "bg-gray-100 text-gray-600"}`}>
      {trend}
    </span>
  )
}

function volatilityBadge(level: string | null) {
  if (!level) return <span className="text-gray-400 text-xs">-</span>
  const colors: Record<string, string> = {
    "LOW": "bg-green-100 text-green-700",
    "MEDIUM": "bg-yellow-100 text-yellow-700",
    "HIGH": "bg-orange-100 text-orange-700",
    "VERY_HIGH": "bg-red-100 text-red-700",
  }
  const labels: Record<string, string> = {
    "LOW": "낮음",
    "MEDIUM": "보통",
    "HIGH": "높음",
    "VERY_HIGH": "매우높음",
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[level] ?? "bg-gray-100 text-gray-600"}`}>
      {labels[level] ?? level}
    </span>
  )
}

function policyBadge(policy: string | null) {
  if (!policy) return <span className="text-gray-400 text-xs">-</span>
  const colors: Record<string, string> = {
    "마진방어": "bg-red-100 text-red-700",
    "마진확보": "bg-orange-100 text-orange-700",
    "현상유지": "bg-gray-100 text-gray-700",
    "점유율확대": "bg-blue-100 text-blue-700",
    "공격적인하": "bg-purple-100 text-purple-700",
    "긴급대응": "bg-red-200 text-red-800",
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[policy] ?? "bg-gray-100 text-gray-600"}`}>
      {policy}
    </span>
  )
}

function AnalysisPanel({
  data,
  loading,
  onClose,
}: {
  data: AnalysisData | null
  loading: boolean
  onClose: () => void
}) {
  if (loading) {
    return (
      <tr>
        <td colSpan={12} className="px-4 py-6 bg-blue-50">
          <div className="flex items-center gap-2 text-sm text-blue-600">
            <span className="animate-spin inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full" />
            분석 데이터 로딩 중...
          </div>
        </td>
      </tr>
    )
  }

  if (!data || !data.analysis) {
    return (
      <tr>
        <td colSpan={12} className="px-4 py-4 bg-gray-50">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">
              {data?.message ?? "분석 데이터가 없습니다."}
            </span>
            <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">닫기</button>
          </div>
        </td>
      </tr>
    )
  }

  const a = data.analysis
  return (
    <tr>
      <td colSpan={12} className="px-0 py-0">
        <div className="bg-blue-50 border-y border-blue-200 px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-bold text-blue-900">
              {data.product_name} 분석 ({data.analysis_date})
            </h4>
            <button onClick={onClose} className="text-xs text-blue-500 hover:text-blue-700">닫기</button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            {/* 동향 */}
            <div className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-gray-500 mb-1">7일 동향</p>
              <div className="flex items-center gap-2">
                {trendBadge(a.trend.direction)}
                {a.trend.change_rate != null && (
                  <span className="text-xs text-gray-500">
                    ({(a.trend.change_rate * 100).toFixed(1)}%)
                  </span>
                )}
              </div>
              {a.trend.base_price != null && (
                <p className="text-xs text-gray-400 mt-1">
                  기준가 {a.trend.base_price.toLocaleString()}원
                </p>
              )}
            </div>

            {/* 변동성 */}
            <div className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-gray-500 mb-1">변동성</p>
              <div className="flex items-center gap-2">
                {volatilityBadge(a.volatility.level)}
                {a.volatility.cv != null && (
                  <span className="text-xs text-gray-500">
                    CV {a.volatility.cv.toFixed(1)}%
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                데이터 {a.volatility.data_days}일
              </p>
            </div>

            {/* 7일 통계 */}
            <div className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-gray-500 mb-1">7일 가격 범위</p>
              <div className="text-xs space-y-0.5">
                <div className="flex justify-between">
                  <span className="text-gray-500">최고</span>
                  <span className="font-medium text-gray-700">
                    {a.week_stats.max != null ? `${a.week_stats.max.toLocaleString()}원` : "-"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">중앙</span>
                  <span className="font-medium text-gray-700">
                    {a.week_stats.median != null ? `${Math.round(a.week_stats.median).toLocaleString()}원` : "-"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">최저</span>
                  <span className="font-medium text-gray-700">
                    {a.week_stats.min != null ? `${a.week_stats.min.toLocaleString()}원` : "-"}
                  </span>
                </div>
              </div>
            </div>

            {/* 전략 정책 */}
            <div className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-gray-500 mb-1">전략 정책</p>
              <div className="flex items-center gap-2">
                {policyBadge(a.strategy.policy)}
                <span className="text-xs text-gray-500">
                  점수 {a.strategy.total_score}
                </span>
              </div>
              {a.strategy.margin_adjustment !== 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  수익률 조정 {a.strategy.margin_adjustment > 0 ? "+" : ""}{a.strategy.margin_adjustment}%p
                </p>
              )}
            </div>
          </div>

          {/* 점수 상세 */}
          {a.strategy.score_details.length > 0 && (
            <div className="bg-white rounded-lg p-3 border border-blue-100 mb-3">
              <p className="text-xs text-gray-500 mb-2">신호 상세</p>
              <div className="flex flex-wrap gap-2">
                {a.strategy.score_details.map((d, i) => (
                  <div
                    key={i}
                    className={`text-xs px-2 py-1 rounded ${
                      d.score > 0 ? "bg-orange-50 text-orange-700" : "bg-green-50 text-green-700"
                    }`}
                  >
                    <span className="font-medium">{d.signal}</span>
                    <span className="text-gray-500 ml-1">({d.score > 0 ? "+" : ""}{d.score})</span>
                    <span className="block text-gray-400 text-[10px]">{d.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 최근 매입가 추이 */}
          {a.recent_prices.length > 0 && (
            <div className="bg-white rounded-lg p-3 border border-blue-100">
              <p className="text-xs text-gray-500 mb-2">최근 매입가 추이</p>
              <div className="flex items-end gap-1 h-12">
                {a.recent_prices.map((rp, i) => {
                  const prices = a.recent_prices.map((r) => r.purchase_price)
                  const max = Math.max(...prices)
                  const min = Math.min(...prices)
                  const range = max - min || 1
                  const height = ((rp.purchase_price - min) / range) * 100
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col items-center gap-0.5"
                      title={`${rp.price_date}: ${rp.purchase_price.toLocaleString()}원`}
                    >
                      <div
                        className="w-full bg-blue-400 rounded-t min-h-[2px]"
                        style={{ height: `${Math.max(height, 5)}%` }}
                      />
                      <span className="text-[8px] text-gray-400">
                        {rp.price_date.slice(5)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ──────────────────────────────────────────────
// Platform Prices Expandable Row
// ──────────────────────────────────────────────

function PlatformPrices({
  sibomPrice,
  purchasePrice,
}: {
  sibomPrice: number
  purchasePrice: number | null
}) {
  const baeminPrice = sibomPrice
  const sinsunPrice = calcSinsunPrice(sibomPrice, purchasePrice)

  return (
    <div className="text-xs text-gray-500 mt-1 space-y-0.5">
      <div>
        식봄: <span className="font-medium text-gray-700">{formatPrice(sibomPrice)}</span>
      </div>
      <div>
        배민: <span className="font-medium text-gray-700">{formatPrice(baeminPrice)}</span>
      </div>
      <div>
        신선행: <span className="font-medium text-gray-700">{formatPrice(sinsunPrice)}</span>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────
// Main Page Component
// ──────────────────────────────────────────────

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Edits: map of product_code -> edited selling price
  const [edits, setEdits] = useState<Map<string, number>>(new Map())

  // Inline editing state
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState("")
  const editInputRef = useRef<HTMLInputElement>(null)

  // Filters
  const [category, setCategory] = useState<string>("전체")
  const [search, setSearch] = useState("")
  const [lowMarginOnly, setLowMarginOnly] = useState(false)

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("product_code")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  // Toast
  const [toast, setToast] = useState<{
    message: string
    type: "success" | "error"
  } | null>(null)

  // Platform prices expand
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set())

  // Group sync modal
  const [groupSyncModal, setGroupSyncModal] = useState<{
    groupNumber: number
    changedProductCode: string
    newPrice: number
  } | null>(null)

  // Saving state
  const [saving, setSaving] = useState(false)

  // Analysis panel state
  const [analysisCode, setAnalysisCode] = useState<string | null>(null)
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)

  // ──────────────────────────────────────────
  // Fetch data
  // ──────────────────────────────────────────

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/products")
        if (!res.ok) throw new Error(`API 오류: ${res.status}`)
        const data = await res.json()
        if (Array.isArray(data)) {
          setProducts(data)
        } else {
          setProducts([])
          if (data?.error) setError(data.error)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "데이터를 불러올 수 없습니다")
        setProducts([])
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  // Focus input when editing starts
  useEffect(() => {
    if (editingCode && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingCode])

  // ──────────────────────────────────────────
  // Group color mapping (stable across renders)
  // ──────────────────────────────────────────

  const groupIndexMap = useMemo(() => {
    const map = new Map<number, number>()
    let idx = 0
    for (const p of products) {
      if (p.product_group != null && !map.has(p.product_group)) {
        map.set(p.product_group, idx % GROUP_COLORS.length)
        idx++
      }
    }
    return map
  }, [products])

  // ──────────────────────────────────────────
  // Derived: effective selling price (with edits)
  // ──────────────────────────────────────────

  function getEffectiveSellingPrice(p: Product): number | null {
    if (edits.has(p.product_code)) return edits.get(p.product_code)!
    return p.latest_selling_price
  }

  function getEffectiveMarginRate(p: Product): number | null {
    const sellingPrice = getEffectiveSellingPrice(p)
    return calcMarginRate(p.latest_purchase_price, sellingPrice)
  }

  // ──────────────────────────────────────────
  // Inline edit handlers
  // ──────────────────────────────────────────

  function startEdit(p: Product) {
    const currentPrice = getEffectiveSellingPrice(p)
    setEditingCode(p.product_code)
    setEditingValue(currentPrice != null ? String(currentPrice) : "")
  }

  function commitEdit(productCode: string) {
    const num = parseInt(editingValue, 10)
    if (!isNaN(num) && num > 0) {
      const product = products.find((p) => p.product_code === productCode)
      // Check if value actually changed from original
      if (product && num !== product.latest_selling_price) {
        const newEdits = new Map(edits)
        newEdits.set(productCode, num)
        setEdits(newEdits)

        // Check for group sync
        if (product.product_group != null) {
          const groupProducts = products.filter(
            (p) =>
              p.product_group === product.product_group &&
              p.product_code !== productCode
          )
          if (groupProducts.length > 0) {
            setGroupSyncModal({
              groupNumber: product.product_group,
              changedProductCode: productCode,
              newPrice: num,
            })
          }
        }
      } else if (product && num === product.latest_selling_price) {
        // Reverted to original, remove edit
        const newEdits = new Map(edits)
        newEdits.delete(productCode)
        setEdits(newEdits)
      }
    }
    setEditingCode(null)
    setEditingValue("")
  }

  function cancelEdit() {
    setEditingCode(null)
    setEditingValue("")
  }

  // ──────────────────────────────────────────
  // Analysis panel
  // ──────────────────────────────────────────

  async function toggleAnalysis(productCode: string) {
    if (analysisCode === productCode) {
      setAnalysisCode(null)
      setAnalysisData(null)
      return
    }
    setAnalysisCode(productCode)
    setAnalysisLoading(true)
    setAnalysisData(null)
    try {
      const res = await fetch(`/api/products/analysis?product_code=${productCode}`)
      const data: AnalysisData = await res.json()
      setAnalysisData(data)
    } catch {
      setAnalysisData(null)
    } finally {
      setAnalysisLoading(false)
    }
  }

  // ──────────────────────────────────────────
  // Group sync
  // ──────────────────────────────────────────

  function handleGroupSyncConfirm() {
    if (!groupSyncModal) return
    const { groupNumber, changedProductCode, newPrice } = groupSyncModal
    const changedProduct = products.find(
      (p) => p.product_code === changedProductCode
    )
    if (!changedProduct) {
      setGroupSyncModal(null)
      return
    }

    const originalPrice = changedProduct.latest_selling_price
    if (originalPrice == null || originalPrice === 0) {
      setGroupSyncModal(null)
      return
    }

    const ratio = newPrice / originalPrice
    const groupProducts = products.filter(
      (p) =>
        p.product_group === groupNumber &&
        p.product_code !== changedProductCode
    )

    const newEdits = new Map(edits)
    for (const gp of groupProducts) {
      const gpPrice = getEffectiveSellingPrice(gp)
      if (gpPrice != null) {
        const adjusted = Math.ceil((gpPrice * ratio) / 10) * 10
        newEdits.set(gp.product_code, adjusted)
      }
    }
    setEdits(newEdits)
    setGroupSyncModal(null)
  }

  // ──────────────────────────────────────────
  // Bulk adjust: < 19.5% -> recommended price
  // ──────────────────────────────────────────

  function handleBulkAdjust() {
    const newEdits = new Map(edits)
    let count = 0
    for (const p of products) {
      const margin = getEffectiveMarginRate(p)
      if (margin != null && margin < 19.5) {
        const recommended = calcRecommendedPrice(
          p.latest_purchase_price,
          p.target_margin_rate
        )
        if (recommended != null) {
          const currentEffective = getEffectiveSellingPrice(p)
          if (currentEffective !== recommended) {
            newEdits.set(p.product_code, recommended)
            count++
          }
        }
      }
    }
    setEdits(newEdits)
    if (count > 0) {
      setToast({ message: `${count}개 상품 판매가를 추천가로 조정했습니다`, type: "success" })
    } else {
      setToast({ message: "조정할 상품이 없습니다", type: "success" })
    }
  }

  // ──────────────────────────────────────────
  // Confirm (batch save)
  // ──────────────────────────────────────────

  async function handleConfirm() {
    if (edits.size === 0) return
    setSaving(true)

    const today = new Date().toISOString().slice(0, 10)
    const updates = Array.from(edits.entries()).map(([code, price]) => ({
      product_code: code,
      selling_price: price,
    }))

    try {
      const res = await fetch("/api/products/batch-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates, price_date: today }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.error ?? `서버 오류: ${res.status}`)
      }

      const result = await res.json()
      const successCount = result.success_count ?? edits.size

      // Update local state with confirmed prices
      setProducts((prev) =>
        prev.map((p) => {
          if (edits.has(p.product_code)) {
            const newPrice = edits.get(p.product_code)!
            return {
              ...p,
              latest_selling_price: newPrice,
              latest_selling_date: today,
              current_margin_rate: calcMarginRate(
                p.latest_purchase_price,
                newPrice
              ),
            }
          }
          return p
        })
      )
      setEdits(new Map())
      setToast({
        message: `${successCount}개 상품 확정 완료`,
        type: "success",
      })
    } catch (e) {
      setToast({
        message:
          e instanceof Error ? e.message : "확정 중 오류가 발생했습니다",
        type: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  // ──────────────────────────────────────────
  // Sort
  // ──────────────────────────────────────────

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
      } else {
        setSortKey(key)
        setSortDir("asc")
      }
    },
    [sortKey]
  )

  // ──────────────────────────────────────────
  // Filter + sort
  // ──────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = products

    if (category !== "전체") {
      list = list.filter((p) => p.category_name === category)
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (p) =>
          p.product_code.toLowerCase().includes(q) ||
          p.product_name.toLowerCase().includes(q)
      )
    }

    if (lowMarginOnly) {
      list = list.filter((p) => {
        const margin = getEffectiveMarginRate(p)
        return margin != null && margin < 19.5
      })
    }

    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, category, search, lowMarginOnly, edits])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      let av: string | number | boolean | null
      let bv: string | number | boolean | null

      if (sortKey === "recommended_price") {
        av = calcRecommendedPrice(a.latest_purchase_price, a.target_margin_rate)
        bv = calcRecommendedPrice(b.latest_purchase_price, b.target_margin_rate)
      } else if (sortKey === "current_margin_rate") {
        av = getEffectiveMarginRate(a)
        bv = getEffectiveMarginRate(b)
      } else if (sortKey === "latest_selling_price") {
        av = getEffectiveSellingPrice(a)
        bv = getEffectiveSellingPrice(b)
      } else {
        av = a[sortKey]
        bv = b[sortKey]
      }

      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av
      }
      if (typeof av === "boolean" && typeof bv === "boolean") {
        return sortDir === "asc"
          ? Number(av) - Number(bv)
          : Number(bv) - Number(av)
      }
      return 0
    })
    return arr
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, edits])

  // ──────────────────────────────────────────
  // Row style helpers
  // ──────────────────────────────────────────

  function rowBgClass(p: Product): string {
    const margin = getEffectiveMarginRate(p)
    if (margin != null && margin < 10) return "bg-red-50"
    if (margin != null && margin < 19.5) return "bg-yellow-50"
    return ""
  }

  function recommendedPriceColorClass(
    currentPrice: number | null,
    recommendedPrice: number | null
  ): string {
    if (currentPrice == null || recommendedPrice == null) return "text-gray-700"
    const ratio = currentPrice / recommendedPrice
    if (ratio > 1.05) return "text-blue-600"
    if (ratio < 0.95) return "text-red-600"
    return "text-gray-700"
  }

  // ──────────────────────────────────────────
  // Expand toggle
  // ──────────────────────────────────────────

  function toggleExpand(code: string) {
    setExpandedCodes((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  // ──────────────────────────────────────────
  // Columns
  // ──────────────────────────────────────────

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col)
      return <span className="text-gray-300 ml-1">&#8597;</span>
    return (
      <span className="ml-1 text-gray-600">
        {sortDir === "asc" ? "\u25B2" : "\u25BC"}
      </span>
    )
  }

  type ColumnDef = { key: SortKey; label: string; align?: "right" | "left" }

  const columns: ColumnDef[] = [
    { key: "product_code", label: "상품코드" },
    { key: "product_name", label: "상품명" },
    { key: "category_name", label: "대분류" },
    { key: "product_group", label: "그룹", align: "right" },
    { key: "latest_purchase_price", label: "최근매입가", align: "right" },
    { key: "latest_selling_price", label: "판매가", align: "right" },
    { key: "current_margin_rate", label: "수익률", align: "right" },
    { key: "target_margin_rate", label: "목표수익률", align: "right" },
    { key: "recommended_price", label: "추천가", align: "right" },
    { key: "latest_purchase_date", label: "매입일" },
    { key: "latest_selling_date", label: "판매일" },
  ]

  // ──────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">전체상품</h1>
          <p className="text-sm text-gray-500 mt-1">
            상품 목록 및 수익률 현황 -- 판매가 클릭으로 인라인 수정
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* 수익률 일괄조정 버튼 */}
          <button
            onClick={handleBulkAdjust}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            19.5% 미만 일괄조정
          </button>

          {/* 확정 버튼 */}
          <button
            onClick={handleConfirm}
            disabled={edits.size === 0 || saving}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
              edits.size === 0
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {saving ? "저장 중..." : "변경사항 확정"}
            {edits.size > 0 && (
              <span className="bg-white/20 text-white px-2 py-0.5 rounded-full text-xs font-bold">
                {edits.size}개 변경
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 py-6">
        {/* 필터 바 */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label
              htmlFor="category"
              className="text-sm font-medium text-gray-700"
            >
              대분류
            </label>
            <select
              id="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="search"
              className="text-sm font-medium text-gray-700"
            >
              검색
            </label>
            <input
              id="search"
              type="text"
              placeholder="상품명 또는 상품코드"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={lowMarginOnly}
              onChange={(e) => setLowMarginOnly(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            19.5% 미만만 표시
          </label>

          <span className="ml-auto text-sm text-gray-500">
            총{" "}
            <strong className="text-gray-900">
              {sorted.length.toLocaleString()}
            </strong>
            개 상품
            {edits.size > 0 && (
              <span className="ml-2 text-blue-600 font-medium">
                ({edits.size}개 수정됨)
              </span>
            )}
          </span>
        </div>

        {/* 에러 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {/* 테이블 */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <div className="max-h-[calc(100vh-280px)] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                  <tr>
                    {/* Group color bar header */}
                    <th className="w-1 px-0" />
                    {columns.map((col) => (
                      <th
                        key={col.key}
                        className={`px-4 py-3 font-medium text-gray-600 whitespace-nowrap cursor-pointer select-none hover:bg-gray-100 transition-colors ${
                          col.align === "right" ? "text-right" : "text-left"
                        }`}
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        <SortIcon col={col.key} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <>
                      {Array.from({ length: 15 }).map((_, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="w-1 px-0" />
                          {columns.map((col) => (
                            <td key={col.key} className="px-4 py-3">
                              <div className="h-4 bg-gray-200 rounded animate-pulse" />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </>
                  ) : sorted.length === 0 ? (
                    <tr>
                      <td
                        colSpan={columns.length + 1}
                        className="px-4 py-12 text-center text-gray-400"
                      >
                        {products.length === 0
                          ? "데이터가 없습니다"
                          : "필터 조건에 맞는 상품이 없습니다"}
                      </td>
                    </tr>
                  ) : (
                    sorted.map((p) => {
                      const isEdited = edits.has(p.product_code)
                      const effectivePrice = getEffectiveSellingPrice(p)
                      const effectiveMargin = getEffectiveMarginRate(p)
                      const recommendedPrice = calcRecommendedPrice(
                        p.latest_purchase_price,
                        p.target_margin_rate
                      )
                      const isExpanded = expandedCodes.has(p.product_code)
                      const isCurrentlyEditing =
                        editingCode === p.product_code

                      const isAnalysisOpen = analysisCode === p.product_code

                      return [
                        <tr
                          key={p.product_code}
                          className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${rowBgClass(p)} ${
                            isEdited ? "border-l-4 border-l-blue-500" : ""
                          } ${isAnalysisOpen ? "bg-blue-50/50" : ""}`}
                        >
                          {/* Group color bar */}
                          <td className="w-1 px-0">
                            {p.product_group != null && (
                              <div
                                className={`w-1 h-full min-h-[2.5rem] border-l-4 ${getGroupColorClass(
                                  p.product_group,
                                  groupIndexMap
                                )}`}
                              />
                            )}
                          </td>

                          {/* 상품코드 (클릭 시 분석) */}
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleAnalysis(p.product_code)
                              }}
                              className={`font-mono text-sm hover:underline ${
                                analysisCode === p.product_code
                                  ? "text-blue-600 font-bold"
                                  : "text-gray-700"
                              }`}
                              title="클릭하여 분석 보기"
                            >
                              {p.product_code}
                            </button>
                          </td>

                          {/* 상품명 */}
                          <td className="px-4 py-2.5 text-gray-900 whitespace-nowrap">
                            {p.is_key_item && (
                              <span
                                className="text-yellow-500 mr-1"
                                title="주요 경쟁 품목"
                              >
                                &#9733;
                              </span>
                            )}
                            {p.product_name}
                          </td>

                          {/* 대분류 */}
                          <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                            {p.category_name ?? "-"}
                          </td>

                          {/* 그룹 */}
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {p.product_group ?? "-"}
                          </td>

                          {/* 최근매입가 */}
                          <td className="px-4 py-2.5 text-right text-gray-700 whitespace-nowrap">
                            {formatPrice(p.latest_purchase_price)}
                          </td>

                          {/* 판매가 (인라인 편집) */}
                          <td
                            className={`px-4 py-2.5 text-right whitespace-nowrap cursor-pointer ${
                              isEdited
                                ? "text-blue-700 font-bold"
                                : "text-gray-700"
                            }`}
                            onClick={() => {
                              if (!isCurrentlyEditing) startEdit(p)
                            }}
                          >
                            {isCurrentlyEditing ? (
                              <input
                                ref={editInputRef}
                                type="number"
                                value={editingValue}
                                onChange={(e) =>
                                  setEditingValue(e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    commitEdit(p.product_code)
                                  if (e.key === "Escape") cancelEdit()
                                }}
                                onBlur={() => commitEdit(p.product_code)}
                                className="w-24 px-2 py-1 text-right border-2 border-blue-500 rounded text-sm focus:outline-none"
                              />
                            ) : (
                              <span
                                className={
                                  isEdited
                                    ? "border-b-2 border-blue-500 pb-0.5"
                                    : ""
                                }
                                title="클릭하여 수정"
                              >
                                {formatPrice(effectivePrice)}
                              </span>
                            )}
                          </td>

                          {/* 수익률 */}
                          <td
                            className={`px-4 py-2.5 text-right font-medium whitespace-nowrap ${
                              effectiveMargin != null &&
                              effectiveMargin < 10
                                ? "text-red-600"
                                : effectiveMargin != null &&
                                    effectiveMargin < 19.5
                                  ? "text-yellow-600"
                                  : "text-gray-700"
                            }`}
                          >
                            {formatRate(effectiveMargin)}
                          </td>

                          {/* 목표수익률 */}
                          <td className="px-4 py-2.5 text-right text-gray-600 whitespace-nowrap">
                            {formatRate(p.target_margin_rate)}
                          </td>

                          {/* 추천가 + 플랫폼 펼치기 */}
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <div className="flex flex-col items-end">
                              <div className="flex items-center gap-1">
                                <span
                                  className={`font-medium ${recommendedPriceColorClass(
                                    effectivePrice,
                                    recommendedPrice
                                  )}`}
                                >
                                  {formatPrice(recommendedPrice)}
                                </span>
                                {recommendedPrice != null && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleExpand(p.product_code)
                                    }}
                                    className="text-gray-400 hover:text-gray-600 text-xs ml-1"
                                    title="플랫폼별 가격 보기"
                                  >
                                    {isExpanded ? "\u25B4" : "\u25BE"}
                                  </button>
                                )}
                              </div>
                              {isExpanded && recommendedPrice != null && (
                                <PlatformPrices
                                  sibomPrice={recommendedPrice}
                                  purchasePrice={p.latest_purchase_price}
                                />
                              )}
                            </div>
                          </td>

                          {/* 매입일 */}
                          <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                            {formatDate(p.latest_purchase_date)}
                          </td>

                          {/* 판매일 */}
                          <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">
                            {formatDate(p.latest_selling_date)}
                          </td>
                        </tr>,
                        isAnalysisOpen ? (
                          <AnalysisPanel
                            key={`${p.product_code}-analysis`}
                            data={analysisData}
                            loading={analysisLoading}
                            onClose={() => {
                              setAnalysisCode(null)
                              setAnalysisData(null)
                            }}
                          />
                        ) : null,
                      ]
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Group Sync Modal */}
      {groupSyncModal && (
        <GroupSyncModal
          groupNumber={groupSyncModal.groupNumber}
          changedProductCode={groupSyncModal.changedProductCode}
          groupProducts={products.filter(
            (p) => p.product_group === groupSyncModal.groupNumber
          )}
          onConfirm={handleGroupSyncConfirm}
          onCancel={() => setGroupSyncModal(null)}
        />
      )}
    </div>
  )
}
