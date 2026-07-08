"use client";

import { useState, useRef, useCallback, useSyncExternalStore, DragEvent, ChangeEvent } from "react";
import { uploadManager, type Entry } from "@/lib/uploadManager";

// SSR/hydration 안전한 빈 스냅샷 (서버·클라 첫 렌더 공통, 참조 고정)
const EMPTY_ENTRIES: readonly Entry[] = [];
const getServerEntries = () => EMPTY_ENTRIES;
const getServerUploading = () => false;

function isExcelFile(file: File): boolean {
  return (
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.endsWith(".xlsx") ||
    file.name.endsWith(".xls")
  );
}

function statusLabel(s: Entry["status"]): { text: string; color: string; dot: string } {
  switch (s) {
    case "done": return { text: "완료", color: "text-green-600", dot: "bg-green-500" };
    case "uploading": return { text: "처리 중", color: "text-blue-600", dot: "bg-blue-500 animate-pulse" };
    case "error": return { text: "실패", color: "text-red-600", dot: "bg-red-500" };
    case "unknown": return { text: "결과 확인 필요", color: "text-amber-700", dot: "bg-amber-500" };
    default: return { text: "대기", color: "text-gray-400", dot: "bg-gray-300" };
  }
}

export default function UploadPage() {
  // manager 는 React 컴포넌트 밖의 external store (SPA 네비게이션·재마운트에도 살아있음).
  // useSyncExternalStore 로 구독 — getServerSnapshot 이 빈 상태를 돌려주므로
  // 서버 렌더·클라 첫 렌더가 항상 빈 상태로 일치 → hydration mismatch 없음.
  const entries = useSyncExternalStore(
    uploadManager.subscribe, uploadManager.getEntries, getServerEntries
  ) as Entry[];
  const uploading = useSyncExternalStore(
    uploadManager.subscribe, uploadManager.isUploading, getServerUploading
  );

  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const incoming = Array.from(files).filter(isExcelFile);
    if (incoming.length === 0) return;
    uploadManager.addFiles(incoming);
  }, []);

  const removeEntry = useCallback((key: string) => uploadManager.removeEntry(key), []);
  const clearAll = useCallback(() => uploadManager.clearAll(), []);
  const uploadAll = useCallback(() => uploadManager.uploadAll(), []);

  const handleDragOver = useCallback((e: DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
  const handleDragLeave = useCallback((e: DragEvent) => { e.preventDefault(); setDragOver(false); }, []);
  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault(); setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    if (e.target) e.target.value = "";
  }, [addFiles]);

  const uploadableCount = entries.filter((e) => (e.status === "pending" || e.status === "error") && e.file).length;
  const hasUnknown = entries.some((e) => e.status === "unknown");

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
            <li>각 파일 옆 점이 <span className="text-green-700">●</span> 완료 / <span className="text-blue-700">●</span> 처리 중 / <span className="text-red-700">●</span> 실패 로 표시</li>
            <li>업로드 중에 다른 탭으로 이동했다 돌아와도 <strong>진행 상황과 결과</strong>가 그대로 보입니다 (24시간 보존)</li>
          </ol>
        </div>

        {/* 새로고침으로 결과 확인 안 된 항목 안내 */}
        {hasUnknown && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            <p className="font-medium mb-1">이전 업로드 결과 확인 안 됨</p>
            <p className="text-xs">
              업로드 처리 중에 페이지가 새로고침/탭이 닫혔습니다. 서버에선 처리가 완료됐을 수 있으니
              <strong> 전체상품 / 대시보드</strong>에서 데이터 갱신 여부를 확인해주세요.
            </p>
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
                <p className="text-sm text-gray-700"><strong>{entries.length}개</strong> 파일</p>
                <p className="text-xs text-blue-600 mt-1">클릭하거나 끌어다 놓아 추가</p>
              </>
            )}
          </div>

          {entries.length > 0 && (
            <ul className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
              {entries.map((e) => {
                const s = statusLabel(e.status);
                const restored = e.file === null && (e.status === "done" || e.status === "error" || e.status === "unknown");
                return (
                  <li key={e.key} className="px-3 py-2 flex items-center gap-3 text-sm bg-white">
                    <span className={`shrink-0 w-2 h-2 rounded-full ${s.dot}`} />
                    <span className="flex-1 truncate text-gray-800">
                      {e.name}
                      {restored && <span className="ml-2 text-[10px] text-gray-400">(복구됨)</span>}
                    </span>
                    <span className="text-xs text-gray-400">{(e.size / 1024).toFixed(1)} KB</span>
                    <span className={`text-xs w-24 text-right ${s.color}`}>{s.text}</span>
                    {!uploading && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); removeEntry(e.key); }}
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
              disabled={uploadableCount === 0 || uploading}
              className={`flex-1 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                uploadableCount === 0 || uploading
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
              ) : uploadableCount === 0 ? (
                "추가 업로드할 파일 없음"
              ) : uploadableCount === entries.length ? (
                `${entries.length}개 업로드`
              ) : (
                `남은 ${uploadableCount}개 업로드`
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
                if (!e.result.success) {
                  return (
                    <div key={e.key} className="p-3 rounded-lg text-sm bg-red-50 border border-red-200 text-red-800">
                      <p className="font-medium text-xs text-gray-600">{e.name}</p>
                      <p>{e.result.error || "업로드 중 오류가 발생했습니다."}</p>
                    </div>
                  );
                }
                return (
                  <div key={e.key} className="p-3 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800">
                    <p className="font-medium text-xs text-gray-600 mb-1">{e.name}</p>
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
