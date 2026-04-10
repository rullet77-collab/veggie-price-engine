"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

type LearnItem = {
  product_code: string;
  product_name: string;
  spec: string | null;
  unit: string | null;
  category_name: string | null;
  is_key_item: boolean;
  product_group: number | null;

  purchase_price: number;
  prev_purchase_price: number;
  purchase_change: number;
  purchase_history: { date: string; price: number }[];

  target_margin_rate: number | null;
  prev_3month_pct: string | null;

  prev_selling_price: number;
  user_price: number;
  user_margin: number;

  ai_price: number;
  ai_margin: number;
  ai_reason: string;

  user_reason: string;
  user_comment_on_ai: string;
  ai_comment_on_user: string;
};

function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "-";
  return n.toLocaleString();
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function MiniChart({ history }: { history: { date: string; price: number }[] }) {
  if (history.length < 2) return <span className="text-gray-300 text-[10px]">데이터부족</span>;
  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 160, h = 40;
  const points = prices
    .map((p, i) => `${4 + (i / (prices.length - 1)) * (w - 8)},${h - 4 - ((p - min) / range) * (h - 8)}`)
    .join(" ");
  const color = prices[prices.length - 1] > prices[0] ? "#ef4444" : prices[prices.length - 1] < prices[0] ? "#3b82f6" : "#9ca3af";
  return (
    <div className="inline-block">
      <svg width={w} height={h} className="bg-gray-50 rounded">
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
        {prices.map((p, i) => (
          <circle key={i} cx={4 + (i / (prices.length - 1)) * (w - 8)} cy={h - 4 - ((p - min) / range) * (h - 8)} r="2.5" fill={color} />
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-gray-400 mt-0.5 px-0.5">
        <span>{history[0].date.slice(5)}</span>
        <span>{history[history.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function LearnCard({
  item,
  index,
  userReason,
  onUserReasonChange,
  aiComment,
  onAiCommentChange,
  aiCommentOnUser,
  savingStatus,
}: {
  item: LearnItem;
  index: number;
  userReason: string;
  onUserReasonChange: (val: string) => void;
  aiComment: string;
  onAiCommentChange: (val: string) => void;
  aiCommentOnUser: string;
  savingStatus: "saving" | "saved" | null;
}) {
  const purchDir = item.purchase_change > 0 ? "text-red-500" : item.purchase_change < 0 ? "text-blue-500" : "text-gray-400";
  const purchPct = item.prev_purchase_price > 0
    ? ((item.purchase_change / item.prev_purchase_price) * 100).toFixed(1) + "%"
    : "-";

  const diff = item.user_price - item.ai_price;
  const diffLabel = diff === 0
    ? "동일"
    : diff > 0
      ? `사용자가 ${fmt(diff)}원 높음`
      : `AI가 ${fmt(Math.abs(diff))}원 높음`;
  const diffColor = diff === 0 ? "text-gray-500" : diff > 0 ? "text-red-500" : "text-blue-500";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* 헤더 */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-300">#{index + 1}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-gray-900">{item.product_name}</span>
              {item.is_key_item && <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded">주요</span>}
              {item.product_group && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">그룹{item.product_group}</span>}
            </div>
            <div className="text-[11px] text-gray-400">{item.product_code} · {item.spec} · {item.unit}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {savingStatus === "saving" && (
            <span className="text-[10px] text-gray-400 flex items-center gap-1">
              <span className="animate-spin w-2.5 h-2.5 border border-gray-300 border-t-blue-500 rounded-full" />
              저장 중
            </span>
          )}
          {savingStatus === "saved" && (
            <span className="text-[10px] text-green-500">✓ 저장됨</span>
          )}
          {item.target_margin_rate != null && item.target_margin_rate > 0 && (
            <div className="text-right">
              <div className="text-xs text-gray-400">기준수익률</div>
              <div className="text-sm font-semibold text-teal-600">{item.target_margin_rate}%</div>
            </div>
          )}
          {item.prev_3month_pct && (
            <div className="text-right">
              <div className="text-xs text-gray-400">3개월대비</div>
              <div className={`text-sm font-semibold ${
                item.prev_3month_pct.includes("▲") || item.prev_3month_pct.includes("+") ? "text-red-600" :
                item.prev_3month_pct.includes("▼") || item.prev_3month_pct.includes("-") ? "text-blue-600" : "text-gray-500"
              }`}>{item.prev_3month_pct}</div>
            </div>
          )}
          <div className="text-right">
            <div className="text-xs text-gray-400">매입가</div>
            <div className="text-sm">
              <span>{fmt(item.prev_purchase_price)}</span>
              <span className="mx-1 text-gray-300">→</span>
              <span className="font-bold">{fmt(item.purchase_price)}</span>
              <span className={`ml-1 text-xs ${purchDir}`}>
                ({item.purchase_change > 0 ? "+" : ""}{purchPct})
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 매입 추이 + 가격 비교 */}
      <div className="px-5 py-3 flex items-start gap-6 border-b border-gray-100">
        <div>
          <div className="text-[10px] text-gray-400 mb-1">8일 매입가 추이</div>
          <MiniChart history={item.purchase_history} />
        </div>
        <div className="flex-1 grid grid-cols-3 gap-4">
          <div>
            <div className="text-[10px] text-gray-400">기존 판매가</div>
            <div className="text-sm font-medium">{fmt(item.prev_selling_price)}</div>
          </div>
          <div className="bg-blue-50 rounded-lg px-3 py-1.5">
            <div className="text-[10px] text-blue-500 font-medium">사용자 설정가</div>
            <div className="text-lg font-bold text-blue-700">{fmt(item.user_price)}</div>
            <div className="text-[10px] text-gray-500">수익률 {pct(item.user_margin)}</div>
          </div>
          <div className="bg-purple-50 rounded-lg px-3 py-1.5">
            <div className="text-[10px] text-purple-500 font-medium">AI 추천가</div>
            <div className="text-lg font-bold text-purple-700">{fmt(item.ai_price)}</div>
            <div className="text-[10px] text-gray-500">수익률 {pct(item.ai_margin)}</div>
          </div>
        </div>
      </div>

      {/* 차이 표시 */}
      <div className="px-5 py-2 border-b border-gray-100 bg-gray-50/50">
        <div className="text-center">
          <span className={`text-xs font-medium ${diffColor}`}>{diffLabel}</span>
        </div>
      </div>

      {/* 판단 근거 2열 */}
      <div className="grid grid-cols-2 divide-x divide-gray-100">
        {/* 사용자 영역 */}
        <div className="p-4">
          <div className="text-xs font-bold text-blue-600 mb-2 flex items-center gap-1">
            <span className="w-2 h-2 bg-blue-500 rounded-full" />
            사용자 판단기준
          </div>
          <textarea
            value={userReason}
            onChange={(e) => onUserReasonChange(e.target.value)}
            placeholder="이 상품의 판매가를 이 금액으로 설정한 이유를 적어주세요.&#10;&#10;예: 매입가 하락 추세이나 3일 미만이라 관망.&#10;현재 수익률 여유 있어 동결."
            rows={4}
            className="w-full text-sm px-3 py-2 border border-blue-100 rounded-lg bg-blue-50/30 resize-none focus:ring-1 focus:ring-blue-300 outline-none placeholder:text-gray-300 leading-relaxed"
          />
          {/* AI가 사용자 근거에 코멘트 (서버 생성, DB 저장) */}
          <div className="mt-3 bg-purple-50/50 rounded-lg p-3 border border-purple-100">
            <div className="text-[10px] font-medium text-purple-500 mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-purple-500 rounded-full" />
              AI 답글
            </div>
            <div className="text-xs text-gray-600 leading-relaxed">
              {aiCommentOnUser ? (
                aiCommentOnUser
              ) : userReason ? (
                <span className="text-gray-300">저장 중... (1초 후 표시)</span>
              ) : (
                <span className="text-gray-300">사용자 판단기준을 입력하면 AI 답글이 자동 생성됩니다</span>
              )}
            </div>
          </div>
        </div>

        {/* AI 영역 */}
        <div className="p-4">
          <div className="text-xs font-bold text-purple-600 mb-2 flex items-center gap-1">
            <span className="w-2 h-2 bg-purple-500 rounded-full" />
            AI 판단기준
          </div>
          <div className="text-sm text-gray-700 leading-relaxed bg-purple-50/30 border border-purple-100 rounded-lg px-3 py-2 min-h-[96px]">
            {item.ai_reason}
          </div>
          {/* 사용자가 AI 근거에 코멘트 */}
          <div className="mt-3 bg-blue-50/50 rounded-lg p-3 border border-blue-100">
            <div className="text-[10px] font-medium text-blue-500 mb-1">사용자 코멘트</div>
            <textarea
              value={aiComment}
              onChange={(e) => onAiCommentChange(e.target.value)}
              placeholder="AI 판단에 대한 의견을 적어주세요..."
              rows={2}
              className="w-full text-xs px-2 py-1.5 border border-blue-100 rounded bg-white resize-none focus:ring-1 focus:ring-blue-200 outline-none placeholder:text-gray-300 leading-relaxed"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LearnPage() {
  const [items, setItems] = useState<LearnItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [priceDate, setPriceDate] = useState("");
  const [userReasons, setUserReasons] = useState<Record<string, string>>({});
  const [aiComments, setAiComments] = useState<Record<string, string>>({});
  const [aiCommentsOnUser, setAiCommentsOnUser] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState<Record<string, "saving" | "saved" | null>>({});
  const saveTimers = useRef<Record<string, NodeJS.Timeout>>({});

  // 페이지 로드 시 기존 세션 가져오기 (URL ?date= 지원)
  useEffect(() => {
    (async () => {
      try {
        const dateParam =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("date")
            : null;
        const url = dateParam ? `/api/learn?date=${dateParam}` : "/api/learn";
        const res = await fetch(url);
        if (!res.ok) throw new Error("API 오류");
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (data.items && data.items.length > 0) {
          setItems(data.items);
          setPriceDate(data.price_date || "");
          setGenerated(true);
          // 기존 입력값 복원
          const reasons: Record<string, string> = {};
          const userComm: Record<string, string> = {};
          const aiComm: Record<string, string> = {};
          for (const item of data.items as LearnItem[]) {
            reasons[item.product_code] = item.user_reason || "";
            aiComm[item.product_code] = item.user_comment_on_ai || "";
            userComm[item.product_code] = item.ai_comment_on_user || "";
          }
          setUserReasons(reasons);
          setAiComments(aiComm);
          setAiCommentsOnUser(userComm);
        }
        if (data.price_date) setPriceDate(data.price_date);
      } catch (err) {
        setError(err instanceof Error ? err.message : "오류 발생");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const generate = useCallback(async () => {
    if (generated && !confirm("기존 학습 내용이 삭제됩니다. 새로 생성하시겠습니까?")) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/learn", { method: "POST" });
      if (!res.ok) throw new Error("API 오류");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setItems(data.items || []);
      setPriceDate(data.price_date || "");
      setUserReasons({});
      setAiComments({});
      setAiCommentsOnUser({});
      setGenerated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "오류 발생");
    } finally {
      setGenerating(false);
    }
  }, [generated]);

  // 디바운스 자동 저장 (1초)
  const saveItem = useCallback((productCode: string, fields: { user_reason?: string; user_comment_on_ai?: string; ai_comment_on_user?: string }) => {
    if (saveTimers.current[productCode]) clearTimeout(saveTimers.current[productCode]);
    setSavingStatus((p) => ({ ...p, [productCode]: "saving" }));
    saveTimers.current[productCode] = setTimeout(async () => {
      try {
        const res = await fetch("/api/learn/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_date: priceDate, product_code: productCode, ...fields }),
        });
        const data = await res.json().catch(() => ({}));
        // 서버가 user_reason 기반으로 AI 답글을 생성해서 반환하면 반영
        if (data && typeof data.ai_comment_on_user === "string") {
          setAiCommentsOnUser((p) => ({ ...p, [productCode]: data.ai_comment_on_user }));
        }
        setSavingStatus((p) => ({ ...p, [productCode]: "saved" }));
        setTimeout(() => setSavingStatus((p) => ({ ...p, [productCode]: null })), 1500);
      } catch {
        setSavingStatus((p) => ({ ...p, [productCode]: null }));
      }
    }, 1000);
  }, [priceDate]);

  const handleUserReasonChange = (code: string, val: string) => {
    setUserReasons((p) => ({ ...p, [code]: val }));
    saveItem(code, { user_reason: val });
  };
  const handleAiCommentChange = (code: string, val: string) => {
    setAiComments((p) => ({ ...p, [code]: val }));
    saveItem(code, { user_comment_on_ai: val });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">판매가 책정 학습</h1>
            <p className="text-sm text-gray-500 mt-1">
              판매가 변경 후 실행하면, 야채 상품 중 무작위 10개를 뽑아 판단 근거를 비교합니다
            </p>
          </div>
          <div className="flex gap-2">
          <Link
            href="/learn/history"
            className="px-4 py-3 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50 flex items-center"
          >
            이력 보기
          </Link>
          <button
            onClick={generate}
            disabled={generating || loading}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-sm text-sm"
          >
            {generating ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                생성 중...
              </span>
            ) : generated ? "새로 실행" : "실행"}
          </button>
          </div>
        </div>

        {/* 초기 로딩 */}
        {loading && (
          <div className="bg-white rounded-xl border p-12 text-center text-gray-400">
            <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-500 rounded-full mx-auto mb-3" />
            불러오는 중...
          </div>
        )}

        {/* 실행 전 안내 */}
        {!loading && !generated && !error && (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="text-5xl mb-4">📊</div>
            <h2 className="text-lg font-bold text-gray-700 mb-2">판매가를 먼저 변경하세요</h2>
            <p className="text-sm text-gray-500 max-w-md mx-auto leading-relaxed">
              전체상품 페이지에서 오늘의 판매가를 책정한 후,<br />
              <strong>실행</strong> 버튼을 누르면 변경된 야채 상품 중<br />
              무작위 10개의 학습 카드가 생성됩니다.
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* 결과 없음 */}
        {generated && items.length === 0 && (
          <div className="bg-white rounded-xl border p-12 text-center text-gray-400">
            판매가가 변경된 야채 상품이 없습니다.<br />
            전체상품 페이지에서 판매가를 먼저 변경해주세요.
          </div>
        )}

        {/* 학습 카드 목록 */}
        {generated && items.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div className="text-xs text-gray-500">
                기준일: {priceDate} | 판매가 변경된 야채 상품 중 {items.length}개 선정
              </div>
              {/* 요약 */}
              <div className="flex gap-3 text-xs">
                <span className="px-2 py-1 bg-green-50 text-green-700 rounded">
                  일치 {items.filter((i) => i.user_price === i.ai_price).length}
                </span>
                <span className="px-2 py-1 bg-red-50 text-red-600 rounded">
                  사용자↑ {items.filter((i) => i.user_price > i.ai_price).length}
                </span>
                <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded">
                  AI↑ {items.filter((i) => i.ai_price > i.user_price).length}
                </span>
              </div>
            </div>

            <div className="space-y-5">
              {items.map((item, idx) => (
                <LearnCard
                  key={item.product_code}
                  item={item}
                  index={idx}
                  userReason={userReasons[item.product_code] || ""}
                  onUserReasonChange={(val) => handleUserReasonChange(item.product_code, val)}
                  aiComment={aiComments[item.product_code] || ""}
                  onAiCommentChange={(val) => handleAiCommentChange(item.product_code, val)}
                  aiCommentOnUser={aiCommentsOnUser[item.product_code] || ""}
                  savingStatus={savingStatus[item.product_code] || null}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
