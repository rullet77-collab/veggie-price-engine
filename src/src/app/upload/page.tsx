"use client";

import { useState, useRef, useCallback, useEffect, DragEvent, ChangeEvent } from "react";

type SheetResult = {
  sheetName: string;
  type: string;
  total: number;
  inserted: number;
  skipped?: number;
  errors?: string[];
};

type UploadResult = {
  success: boolean;
  results?: SheetResult[];
  error?: string;
};

type FileEntry = {
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  result?: UploadResult;
};

// 탭 이동 후 돌아와도 마지막 업로드 결과를 보여주기 위한 localStorage 스냅샷
type PersistedFile = {
  name: string;
  size: number;
  status: FileEntry["status"];
  result?: UploadResult;
};
type PersistedSnapshot = {
  at: number;
  files: PersistedFile[];
};
const SNAPSHOT_KEY = "upload:lastSnapshot:v1";
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function loadSnapshot(): PersistedSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedSnapshot;
    if (Date.now() - data.at > SNAPSHOT_TTL_MS) {
      localStorage.removeItem(SNAPSHOT_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveSnapshot(entries: FileEntry[]) {
  try {
    const files: PersistedFile[] = entries
      .filter((e) => e.result)
      .map((e) => ({
        name: e.file.name,
        size: e.file.size,
        status: e.status,
        result: e.result,
      }));
    if (files.length === 0) {
      localStorage.removeItem(SNAPSHOT_KEY);
      return;
    }
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), files }));
  } catch {}
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function isExcelFile(file: File): boolean {
  return (
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.endsWith(".xlsx") ||
    file.name.endsWith(".xls")
  );
}

function entryKey(f: File): string {
  return `${f.name}__${f.size}__${f.lastModified}`;
}

export default function UploadPage() {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [snapshot, setSnapshot] = useState<PersistedSnapshot | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 마운트 시 직전 업로드 결과 복원 (탭 이동 후 돌아왔을 때 보여주기 위함)
  useEffect(() => {
    setSnapshot(loadSnapshot());
  }, []);

  // 파일 추가 — 같은 파일은 무시
  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(isExcelFile);
    if (incoming.length === 0) return;
    setEntries((prev) => {
      const existing = new Set(prev.map((e) => entryKey(e.file)));
      const fresh: FileEntry[] = [];
      for (const f of incoming) {
        if (!existing.has(entryKey(f))) {
          fresh.push({ file: f, status: "pending" });
          existing.add(entryKey(f));
        }
      }
      return [...prev, ...fresh];
    });
  }, []);

  const removeEntry = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => entryKey(e.file) !== key));
  }, []);

  const clearAll = useCallback(() => setEntries([]), []);

  // 한 파일 업로드
  const uploadOne = async (entry: FileEntry): Promise<UploadResult> => {
    const fd = new FormData();
    fd.append("file", entry.file);
    try {
      const res = await fetch("/api/upload/rawdata", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, results: data.results };
      }
      return { success: false, error: data.error || "서버 오류" };
    } catch {
      return { success: false, error: "네트워크 오류" };
    }
  };

  // 전체 업로드 — 순차 처리 (각 파일에서 RPC + rolling 돌기 때문)
  const uploadAll = async () => {
    if (entries.length === 0 || uploading) return;
    setUploading(true);
    let anySuccess = false;
    // pending / error 만 다시 시도
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].status === "done") continue;
      setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, status: "uploading" } : e)));
      // 순간 entries 는 stale 일 수 있어서 직접 file 참조
      const result = await uploadOne(entries[i]);
      if (result.success) anySuccess = true;
      setEntries((prev) =>
        prev.map((e, idx) =>
          idx === i ? { ...e, status: result.success ? "done" : "error", result } : e
        )
      );
    }
    setUploading(false);
    // 업로드 후 /products 페이지 열려있으면 자동 갱신 신호
    if (anySuccess) {
      try { localStorage.setItem("products:invalidate", String(Date.now())); } catch {}
    }
    // 결과 스냅샷 저장 (탭 이동 후 돌아와도 확인 가능)
    setEntries((curr) => {
      saveSnapshot(curr);
      setSnapshot(loadSnapshot());
      return curr;
    });
  };

  // 스냅샷 지우기
  const clearSnapshot = useCallback(() => {
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch {}
    setSnapshot(null);
  }, []);

  // 드래그앤드롭 — append
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  // 파일 추가 — input change
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      addFiles(e.target.files);
      // 같은 파일을 다시 선택할 수 있도록 input 초기화
      if (e.target) e.target.value = "";
    },
    [addFiles]
  );

  const pendingCount = entries.filter((e) => e.status === "pending" || e.status === "error").length;

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">데이터 업로드</h1>
        <p className="text-sm text-gray-500 mb-4">
          매입·매출 파일을 한 번에 여러 개 선택하거나 끌어다 놓으세요. 서로 다른 폴더의 파일도 추가 선택으로 합칠 수 있습니다.
        </p>

        {/* 사용 안내 */}
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
          <p className="font-medium mb-1">How-to Guide</p>
          <ol className="list-decimal list-inside space-y-0.5 text-xs leading-relaxed">
            <li>매입(상품별매입현황) / 매출(월별매출상세) 엑셀을 한 번에 여러 개 선택 또는 드래그</li>
            <li><strong>업로드</strong> 클릭 → 파일은 순차 처리 (각 파일 처리 후 추천가·매출 집계 자동 갱신)</li>
            <li>각 파일 옆 점이 <span className="text-green-700">●</span> 완료 / <span className="text-red-700">●</span> 실패 로 표시</li>
            <li>업로드 후 다른 탭으로 이동했다 돌아와도 <strong>직전 결과</strong>가 24시간 보존됩니다</li>
          </ol>
        </div>

        {/* 직전 업로드 결과 — 탭 이동 후 돌아왔을 때 보임 (현재 작업이 없을 때만) */}
        {snapshot && entries.length === 0 && (
          <div className="mb-6 bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-sm font-semibold text-gray-800">직전 업로드 결과</h2>
                <p className="text-xs text-gray-500">{formatRelative(snapshot.at)} · {snapshot.files.length}개 파일</p>
              </div>
              <button
                onClick={clearSnapshot}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                결과 지우기
              </button>
            </div>
            <div className="space-y-2">
              {snapshot.files.map((f, i) => {
                if (!f.result) return null;
                if (!f.result.success) {
                  return (
                    <div key={i} className="p-3 rounded-lg text-sm bg-red-50 border border-red-200 text-red-800">
                      <p className="font-medium text-xs text-gray-600">{f.name}</p>
                      <p>{f.result.error || "업로드 중 오류가 발생했습니다."}</p>
                    </div>
                  );
                }
                return (
                  <div key={i} className="p-3 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800">
                    <p className="font-medium text-xs text-gray-600 mb-1">{f.name}</p>
                    {(f.result.results || []).map((r, j) => (
                      <div key={j} className="text-xs">
                        <span className="font-medium">{r.type}</span> — {r.sheetName} · {r.total.toLocaleString()}건 처리,{" "}
                        <strong>{r.inserted.toLocaleString()}건 저장</strong>
                        {r.skipped !== undefined && r.skipped > 0 && (
                          <span className="text-gray-500"> ({r.skipped.toLocaleString()}건 변경 없음)</span>
                        )}
                        {r.errors && r.errors.length > 0 && (
                          <span className="block text-amber-700">일부 오류: {r.errors[0]}</span>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-1">엑셀 파일 업로드</h2>
          <p className="text-xs text-gray-500 mb-4">RAW DATA · 월별매출상세 자동 인식</p>

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
              ${
                dragOver
                  ? "border-blue-400 bg-blue-50"
                  : entries.length > 0
                  ? "border-green-300 bg-green-50"
                  : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
              }
            `}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls"
              multiple
              onChange={handleChange}
              className="hidden"
            />
            <svg className="mx-auto h-8 w-8 text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            {entries.length === 0 ? (
              <>
                <p className="text-sm text-gray-600">끌어다 놓거나 클릭해서 파일 선택 (여러 개 가능)</p>
                <p className="text-xs text-gray-400 mt-1">.xlsx, .xls</p>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-700"><strong>{entries.length}개</strong> 파일 선택됨</p>
                <p className="text-xs text-blue-600 mt-1">클릭하거나 끌어다 놓아 추가</p>
              </>
            )}
          </div>

          {entries.length > 0 && (
            <ul className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
              {entries.map((e) => {
                const k = entryKey(e.file);
                return (
                  <li key={k} className="px-3 py-2 flex items-center gap-3 text-sm bg-white">
                    <span
                      className={`shrink-0 w-2 h-2 rounded-full ${
                        e.status === "done"
                          ? "bg-green-500"
                          : e.status === "uploading"
                          ? "bg-blue-500 animate-pulse"
                          : e.status === "error"
                          ? "bg-red-500"
                          : "bg-gray-300"
                      }`}
                    />
                    <span className="flex-1 truncate text-gray-800">{e.file.name}</span>
                    <span className="text-xs text-gray-400">{(e.file.size / 1024).toFixed(1)} KB</span>
                    <span className="text-xs w-16 text-right">
                      {e.status === "done" && <span className="text-green-600">완료</span>}
                      {e.status === "uploading" && <span className="text-blue-600">처리 중</span>}
                      {e.status === "error" && <span className="text-red-600">실패</span>}
                      {e.status === "pending" && <span className="text-gray-400">대기</span>}
                    </span>
                    {!uploading && (
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          removeEntry(k);
                        }}
                        className="text-xs text-gray-400 hover:text-red-600"
                        title="제거"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={uploadAll}
              disabled={pendingCount === 0 || uploading}
              className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                pendingCount === 0 || uploading
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
              }`}
            >
              {uploading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  처리 중...
                </span>
              ) : entries.length === 0 ? (
                "파일을 추가하세요"
              ) : pendingCount === entries.length ? (
                `${entries.length}개 업로드`
              ) : (
                `남은 ${pendingCount}개 업로드`
              )}
            </button>
            {entries.length > 0 && !uploading && (
              <button
                onClick={clearAll}
                className="px-4 py-2.5 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50"
              >
                전체 비우기
              </button>
            )}
          </div>

          {entries.some((e) => e.result) && (
            <div className="mt-4 space-y-2">
              {entries.map((e) => {
                if (!e.result) return null;
                const k = entryKey(e.file);
                if (!e.result.success) {
                  return (
                    <div key={k} className="p-3 rounded-lg text-sm bg-red-50 border border-red-200 text-red-800">
                      <p className="font-medium text-xs text-gray-600">{e.file.name}</p>
                      <p>{e.result.error || "업로드 중 오류가 발생했습니다."}</p>
                    </div>
                  );
                }
                return (
                  <div key={k} className="p-3 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800">
                    <p className="font-medium text-xs text-gray-600 mb-1">{e.file.name}</p>
                    {(e.result.results || []).map((r, i) => (
                      <div key={i} className="text-xs">
                        <span className="font-medium">{r.type}</span> — {r.sheetName} · {r.total.toLocaleString()}건 처리,{" "}
                        <strong>{r.inserted.toLocaleString()}건 저장</strong>
                        {r.skipped !== undefined && r.skipped > 0 && (
                          <span className="text-gray-500"> ({r.skipped.toLocaleString()}건 변경 없음)</span>
                        )}
                        {r.errors && r.errors.length > 0 && (
                          <span className="block text-amber-700">일부 오류: {r.errors[0]}</span>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <p className="font-medium mb-2">자동 인식되는 파일/시트</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <div className="flex justify-between">
              <span>상품별매입현황(야채7일)</span>
              <span className="text-gray-500">→ 매입가 이력</span>
            </div>
            <div className="flex justify-between">
              <span>월별매출현황(상품별)</span>
              <span className="text-gray-500">→ 월별 수량</span>
            </div>
            <div className="flex justify-between">
              <span>경매가평균(최근일주일)</span>
              <span className="text-gray-500">→ 경매가</span>
            </div>
            <div className="flex justify-between">
              <span>월별매출상세 (RAW / 통합)</span>
              <span className="text-gray-500">→ 매출 상세 (UPSERT)</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            ※ 기존(MMDD)·변경(MMDD) 시트는 더 이상 처리하지 않습니다 (엔진에서 제거됨).
          </p>
        </div>
      </main>
    </div>
  );
}
