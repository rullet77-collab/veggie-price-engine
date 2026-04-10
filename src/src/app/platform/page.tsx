"use client"

import { useState, useEffect } from "react"

type SinsunItem = {
  product_code: string
  product_name: string
  sikbom_price: number
  purchase_price: number | null
  sinsun_price: number
  sinsun_margin_rate: string | null
  price_source: string
}

type SinsunResponse = {
  success: boolean
  date: string
  total_count: number
  items: SinsunItem[]
  error?: string
}

type PlatformCard = {
  id: string
  name: string
  description: string
  color: string
  borderColor: string
  iconBg: string
  type: "excel" | "api"
  apiPath: string
}

const PLATFORMS: PlatformCard[] = [
  {
    id: "sikbom",
    name: "식봄",
    description: "기준 판매가 + 행사품목 정상가",
    color: "text-green-700",
    borderColor: "border-green-200",
    iconBg: "bg-green-100",
    type: "excel",
    apiPath: "/api/platform/sikbom",
  },
  {
    id: "baemin",
    name: "배민상회",
    description: "식봄 판매가와 동일 적용",
    color: "text-blue-700",
    borderColor: "border-blue-200",
    iconBg: "bg-blue-100",
    type: "excel",
    apiPath: "/api/platform/baemin",
  },
  {
    id: "oniljang",
    name: "온일장",
    description: "식봄 기반 판매가",
    color: "text-purple-700",
    borderColor: "border-purple-200",
    iconBg: "bg-purple-100",
    type: "excel",
    apiPath: "/api/platform/oniljang",
  },
  {
    id: "sinsunhang",
    name: "신선행",
    description: "MAX(식봄x0.94, 매입가/0.9) API 전송",
    color: "text-orange-700",
    borderColor: "border-orange-200",
    iconBg: "bg-orange-100",
    type: "api",
    apiPath: "/api/platform/sinsunhang",
  },
]

export default function PlatformPage() {
  const [downloading, setDownloading] = useState<string | null>(null)
  const [toast, setToast] = useState<{
    message: string
    type: "success" | "error"
  } | null>(null)

  // 신선행 미리보기 상태
  const [sinsunData, setSinsunData] = useState<SinsunResponse | null>(null)
  const [sinsunLoading, setSinsunLoading] = useState(false)
  const [sinsunExpanded, setSinsunExpanded] = useState(false)

  // 상품 수 조회
  const [productCount, setProductCount] = useState<number | null>(null)

  useEffect(() => {
    fetch("/api/products")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const withPrice = data.filter(
            (p: Record<string, unknown>) => p.latest_selling_price != null
          )
          setProductCount(withPrice.length)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [toast])

  async function handleExcelDownload(platform: PlatformCard) {
    setDownloading(platform.id)
    try {
      const res = await fetch(platform.apiPath)
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.error ?? `서버 오류: ${res.status}`)
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      const disposition = res.headers.get("Content-Disposition")
      const match = disposition?.match(/filename="(.+)"/)
      a.download = match?.[1] ?? `${platform.id}_upload.xlsx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setToast({
        message: `${platform.name} 엑셀 다운로드 완료`,
        type: "success",
      })
    } catch (e) {
      setToast({
        message:
          e instanceof Error ? e.message : "다운로드 중 오류가 발생했습니다",
        type: "error",
      })
    } finally {
      setDownloading(null)
    }
  }

  async function handleSinsunPreview() {
    setSinsunLoading(true)
    try {
      const res = await fetch("/api/platform/sinsunhang")
      const data: SinsunResponse = await res.json()
      if (!data.success) {
        throw new Error(data.error ?? "조회 실패")
      }
      setSinsunData(data)
      setSinsunExpanded(true)
    } catch (e) {
      setToast({
        message:
          e instanceof Error ? e.message : "신선행 데이터 조회 중 오류",
        type: "error",
      })
    } finally {
      setSinsunLoading(false)
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-900">플랫폼 업로드</h1>
        <p className="text-sm text-gray-500 mt-1">
          확정된 판매가를 플랫폼별 양식으로 다운로드합니다 ({today})
        </p>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {/* 요약 */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600">
              판매가 등록 상품:{" "}
              <strong className="text-gray-900">
                {productCount != null ? `${productCount}개` : "조회 중..."}
              </strong>
            </div>
            <div className="text-sm text-gray-400">|</div>
            <div className="text-sm text-gray-600">
              기준일: <strong className="text-gray-900">{today}</strong>
            </div>
          </div>
        </div>

        {/* 플랫폼 카드 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PLATFORMS.map((platform) => (
            <div
              key={platform.id}
              className={`bg-white rounded-lg shadow-sm border-2 ${platform.borderColor} p-6`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`w-12 h-12 rounded-lg ${platform.iconBg} flex items-center justify-center text-lg font-bold ${platform.color}`}
                >
                  {platform.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <h3 className={`text-lg font-bold ${platform.color}`}>
                    {platform.name}
                  </h3>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {platform.description}
                  </p>

                  <div className="mt-4">
                    {platform.type === "excel" ? (
                      <button
                        onClick={() => handleExcelDownload(platform)}
                        disabled={downloading === platform.id}
                        className={`w-full px-4 py-2.5 text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2 ${
                          downloading === platform.id
                            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                            : "bg-gray-900 text-white hover:bg-gray-800"
                        }`}
                      >
                        {downloading === platform.id ? (
                          <>
                            <span className="animate-spin inline-block w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full" />
                            생성 중...
                          </>
                        ) : (
                          <>
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                              />
                            </svg>
                            엑셀 다운로드
                          </>
                        )}
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <button
                          onClick={handleSinsunPreview}
                          disabled={sinsunLoading}
                          className={`w-full px-4 py-2.5 text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2 ${
                            sinsunLoading
                              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                              : "bg-orange-600 text-white hover:bg-orange-700"
                          }`}
                        >
                          {sinsunLoading ? (
                            <>
                              <span className="animate-spin inline-block w-4 h-4 border-2 border-orange-300 border-t-transparent rounded-full" />
                              조회 중...
                            </>
                          ) : (
                            <>
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                />
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                />
                              </svg>
                              전송 대상 미리보기
                            </>
                          )}
                        </button>
                        {sinsunData && (
                          <p className="text-xs text-gray-500 text-center">
                            {sinsunData.total_count}개 상품 조회됨
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 신선행 미리보기 테이블 */}
        {sinsunExpanded && sinsunData && (
          <div className="mt-6 bg-white rounded-lg shadow-sm border border-orange-200 overflow-hidden">
            <div className="px-4 py-3 bg-orange-50 border-b border-orange-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-orange-800">
                신선행 전송 대상 ({sinsunData.total_count}개)
              </h3>
              <button
                onClick={() => setSinsunExpanded(false)}
                className="text-xs text-orange-600 hover:text-orange-800"
              >
                닫기
              </button>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      상품코드
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      상품명
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">
                      식봄가
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">
                      매입가
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">
                      신선행가
                    </th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">
                      수익률
                    </th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">
                      산출기준
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sinsunData.items.map((item) => (
                    <tr
                      key={item.product_code}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td className="px-3 py-1.5 text-gray-900 font-mono">
                        {item.product_code}
                      </td>
                      <td className="px-3 py-1.5 text-gray-700">
                        {item.product_name}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-700">
                        {item.sikbom_price.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-700">
                        {item.purchase_price != null
                          ? item.purchase_price.toLocaleString()
                          : "-"}
                      </td>
                      <td className="px-3 py-1.5 text-right font-medium text-orange-700">
                        {item.sinsun_price.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">
                        {item.sinsun_margin_rate != null
                          ? `${item.sinsun_margin_rate}%`
                          : "-"}
                      </td>
                      <td className="px-3 py-1.5">
                        <span
                          className={`px-1.5 py-0.5 rounded text-xs ${
                            item.price_source.includes("매입가")
                              ? "bg-red-100 text-red-700"
                              : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {item.price_source}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 안내 문구 */}
        <div className="mt-6 bg-gray-100 rounded-lg p-4 text-xs text-gray-500 space-y-1">
          <p>
            * 식봄/배민/온일장: 엑셀 파일을 다운로드하여 각 플랫폼에 수동
            업로드합니다.
          </p>
          <p>
            * 신선행: 자사 시스템이므로 API로 직접 전송할 수 있습니다. 미리보기
            확인 후 전송하세요.
          </p>
          <p>
            * 모든 금액은 10원 단위 올림 처리됩니다.
          </p>
          <p>
            * 판매가가 등록된 상품만 포함됩니다. 전체상품 페이지에서 먼저 확정해
            주세요.
          </p>
        </div>
      </main>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
            toast.type === "success"
              ? "bg-green-600 text-white"
              : "bg-red-600 text-white"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}
