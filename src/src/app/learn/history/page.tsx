"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SessionSummary = {
  session_date: string;
  total: number;
  matched: number;
  user_higher: number;
  ai_higher: number;
  user_reason_filled: number;
  ai_comment_filled: number;
  match_rate: number;
  created_at: string;
  updated_at: string;
};

type Stats = {
  total_sessions: number;
  total_items: number;
  total_matched: number;
  total_user_higher: number;
  total_ai_higher: number;
  overall_match_rate: number;
  top_user_keywords: { keyword: string; count: number }[];
};

export default function LearnHistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/learn/history");
        if (!res.ok) throw new Error("API 오류");
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setSessions(data.sessions || []);
        setStats(data.stats || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "오류 발생");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">학습 이력</h1>
            <p className="text-sm text-gray-500 mt-1">
              과거 학습 세션의 누적 통계와 세션별 상세를 확인합니다
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/learn"
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg text-sm hover:bg-gray-50"
            >
              오늘 학습으로
            </Link>
          </div>
        </div>

        {loading && (
          <div className="bg-white rounded-xl border p-12 text-center text-gray-400">
            <div className="animate-spin w-8 h-8 border-2 border-gray-300 border-t-blue-500 rounded-full mx-auto mb-3" />
            불러오는 중...
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {!loading && !error && sessions.length === 0 && (
          <div className="bg-white rounded-xl border p-12 text-center text-gray-400">
            아직 학습 세션이 없습니다.
            <br />
            <Link href="/learn" className="text-blue-500 hover:underline text-sm">
              학습 페이지에서 실행 버튼을 눌러보세요
            </Link>
          </div>
        )}

        {!loading && stats && sessions.length > 0 && (
          <>
            {/* 누적 통계 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-sm font-bold text-gray-900 mb-4">📊 누적 통계</h2>
              <div className="grid grid-cols-5 gap-3 mb-4">
                <StatCard label="세션" value={`${stats.total_sessions}`} suffix="회" color="gray" />
                <StatCard label="학습 항목" value={`${stats.total_items}`} suffix="개" color="gray" />
                <StatCard
                  label="일치율"
                  value={`${(stats.overall_match_rate * 100).toFixed(0)}`}
                  suffix="%"
                  color="green"
                />
                <StatCard
                  label="사용자↑"
                  value={`${stats.total_user_higher}`}
                  suffix="건"
                  color="red"
                />
                <StatCard
                  label="AI↑"
                  value={`${stats.total_ai_higher}`}
                  suffix="건"
                  color="blue"
                />
              </div>

              {stats.top_user_keywords.length > 0 && (
                <div>
                  <div className="text-[11px] text-gray-500 mb-1.5">자주 사용한 판단 키워드</div>
                  <div className="flex flex-wrap gap-1.5">
                    {stats.top_user_keywords.map((kw) => (
                      <span
                        key={kw.keyword}
                        className="text-[11px] px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full border border-blue-100"
                      >
                        {kw.keyword} <span className="text-blue-400">×{kw.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 세션 목록 */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50/50">
                <h2 className="text-sm font-bold text-gray-900">📅 세션 목록 ({sessions.length}개)</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">날짜</th>
                    <th className="px-4 py-2 text-right">항목</th>
                    <th className="px-4 py-2 text-right">일치</th>
                    <th className="px-4 py-2 text-right">사용자↑</th>
                    <th className="px-4 py-2 text-right">AI↑</th>
                    <th className="px-4 py-2 text-right">일치율</th>
                    <th className="px-4 py-2 text-right">판단 작성</th>
                    <th className="px-4 py-2 text-right">AI 답글</th>
                    <th className="px-4 py-2 text-center">보기</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sessions.map((s) => (
                    <tr key={s.session_date} className="hover:bg-blue-50/30">
                      <td className="px-4 py-2.5 font-medium text-gray-900">{s.session_date}</td>
                      <td className="px-4 py-2.5 text-right text-gray-600">{s.total}</td>
                      <td className="px-4 py-2.5 text-right text-green-600">{s.matched}</td>
                      <td className="px-4 py-2.5 text-right text-red-500">{s.user_higher}</td>
                      <td className="px-4 py-2.5 text-right text-blue-500">{s.ai_higher}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span
                          className={`font-bold ${
                            s.match_rate >= 0.5
                              ? "text-green-600"
                              : s.match_rate >= 0.3
                                ? "text-yellow-600"
                                : "text-gray-400"
                          }`}
                        >
                          {(s.match_rate * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">
                        {s.user_reason_filled}/{s.total}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">
                        {s.ai_comment_filled}/{s.total}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <Link
                          href={`/learn?date=${s.session_date}`}
                          className="text-blue-500 hover:underline text-xs"
                        >
                          상세
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: string;
  suffix: string;
  color: "gray" | "green" | "red" | "blue";
}) {
  const colorClass = {
    gray: "text-gray-900",
    green: "text-green-600",
    red: "text-red-500",
    blue: "text-blue-500",
  }[color];
  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <div className="text-[11px] text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${colorClass}`}>
        {value}
        <span className="text-xs text-gray-400 ml-0.5">{suffix}</span>
      </div>
    </div>
  );
}
