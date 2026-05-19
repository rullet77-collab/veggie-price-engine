// 대시보드 — 오늘 매입 등락 TOP10 + 이번달 매출 상/하위 (채널별 + 토탈)
import { headers } from "next/headers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type VolatileItem = {
  product_code: string;
  product_name: string;
  spec: string | null;
  today_price: number;
  prev_price: number;
  prev_date: string;
  change_rate: number;
  change_amount: number;
  derived: boolean;
  anchor_name?: string;
};

type SalesItem = {
  product_code: string;
  product_name: string;
  spec: string | null;
  quantity: number;
};

type DashboardData = {
  price_date: string | null;
  month: string | null;
  volatile_top10: VolatileItem[];
  sales_top: Record<string, SalesItem[]>;
  sales_bottom: Record<string, SalesItem[]>;
};

const CHANNELS = ["total", "식봄", "신선행", "온일장", "배민"] as const;

async function getData(): Promise<DashboardData> {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const res = await fetch(`${proto}://${host}/api/dashboard`, { cache: "no-store" });
  return res.json();
}

function formatPrice(n: number): string {
  return n.toLocaleString() + "원";
}

function formatQty(n: number): string {
  return n.toLocaleString();
}

function channelLabel(c: string): string {
  return c === "total" ? "토탈" : c;
}

export default async function Dashboard() {
  const data = await getData();
  const { price_date, month, volatile_top10, sales_top, sales_bottom } = data;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">대시보드</h1>
            <p className="text-sm text-gray-500 mt-1">야채 판매중 상품 — 매입 등락 / 매출 상하위</p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {price_date && (
              <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
                기준일 {price_date}
              </span>
            )}
            {month && (
              <span className="px-3 py-1 bg-purple-50 text-purple-700 rounded-full border border-purple-200">
                이번달 {month}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-10">
        {/* 1) 매입 등락 TOP10 */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            오늘 매입 등락 TOP 10{" "}
            <span className="text-xs text-gray-500 font-normal">(89개 박스소분 상품 포함)</span>
          </h2>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-gray-600">
                  <th className="text-left px-3 py-2 font-medium w-8">#</th>
                  <th className="text-left px-3 py-2 font-medium w-20">코드</th>
                  <th className="text-left px-3 py-2 font-medium">상품명</th>
                  <th className="text-left px-3 py-2 font-medium w-28">규격</th>
                  <th className="text-right px-3 py-2 font-medium w-28">이전</th>
                  <th className="text-right px-3 py-2 font-medium w-28">오늘</th>
                  <th className="text-right px-3 py-2 font-medium w-28">변동률</th>
                </tr>
              </thead>
              <tbody>
                {volatile_top10.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">데이터 없음</td></tr>
                )}
                {volatile_top10.map((v, i) => {
                  const up = v.change_rate > 0;
                  return (
                    <tr key={v.product_code} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                      <td className="px-3 py-2 text-gray-600 font-mono text-xs">{v.product_code}</td>
                      <td className="px-3 py-2 text-gray-900">
                        {v.product_name}
                        {v.derived && (
                          <span
                            className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200"
                            title={`박스소분 역산 (anchor: ${v.anchor_name})`}
                          >
                            역산
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-500 text-xs">{v.spec || ""}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{formatPrice(v.prev_price)}</td>
                      <td className="px-3 py-2 text-right text-gray-900 font-medium">{formatPrice(v.today_price)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${up ? "text-red-600" : "text-blue-600"}`}>
                        {up ? "▲" : "▼"}{(Math.abs(v.change_rate) * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* 2) 매출 상위 — 채널별 + 토탈 */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            이번달 매출 상위 TOP 10
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            {CHANNELS.map((c) => (
              <RankCard
                key={`top-${c}`}
                title={channelLabel(c)}
                items={sales_top[c] || []}
                tone="up"
                isTotal={c === "total"}
              />
            ))}
          </div>
        </section>

        {/* 3) 매출 하위 — 채널별 + 토탈 */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            이번달 매출 하위 TOP 10 <span className="text-xs text-gray-500 font-normal">(판매 1건 이상)</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            {CHANNELS.map((c) => (
              <RankCard
                key={`bot-${c}`}
                title={channelLabel(c)}
                items={sales_bottom[c] || []}
                tone="down"
                isTotal={c === "total"}
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function RankCard({
  title, items, tone, isTotal = false,
}: { title: string; items: SalesItem[]; tone: "up" | "down"; isTotal?: boolean }) {
  // 토탈 카드는 별도 색상 (emerald) + 강조 테두리, 채널 카드는 tone 별 색상
  const headerClass = isTotal
    ? "bg-emerald-100 border-emerald-300 text-emerald-800"
    : tone === "up"
      ? "bg-red-50 border-red-200 text-red-700"
      : "bg-blue-50 border-blue-200 text-blue-700";
  const cardClass = isTotal
    ? "bg-emerald-50/30 border-emerald-300 ring-1 ring-emerald-200"
    : "bg-white border-gray-200";
  return (
    <div className={`rounded-lg shadow-sm border overflow-hidden flex flex-col ${cardClass}`}>
      <div className={`px-3 py-2 border-b font-semibold text-sm ${headerClass}`}>{title}</div>
      <ol className="flex-1 divide-y divide-gray-100 text-xs">
        {items.length === 0 && (
          <li className="px-3 py-4 text-center text-gray-400">데이터 없음</li>
        )}
        {items.map((it, i) => (
          <li key={it.product_code} className="px-3 py-2 flex items-start gap-2">
            <span className="text-gray-400 w-4 shrink-0">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-gray-900 truncate" title={it.product_name}>{it.product_name}</div>
              <div className="text-gray-400 font-mono text-[10px]">{it.product_code}</div>
            </div>
            <span className="text-gray-700 font-medium tabular-nums">{formatQty(it.quantity)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
