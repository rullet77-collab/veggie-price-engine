"use client";

import { useState, useRef, useCallback, DragEvent, ChangeEvent } from "react";

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

function isExcelFile(file: File): boolean {
  return (
    file.type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.endsWith(".xlsx") ||
    file.name.endsWith(".xls")
  );
}

function DropZone({
  label,
  description,
  file,
  onFileSelect,
  onUpload,
  uploading,
  result,
}: {
  label: string;
  description: string;
  file: File | null;
  onFileSelect: (file: File) => void;
  onUpload: () => void;
  uploading: boolean;
  result: UploadResult | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

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
      const f = e.dataTransfer.files[0];
      if (f && isExcelFile(f)) onFileSelect(f);
    },
    [onFileSelect]
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) onFileSelect(f);
    },
    [onFileSelect]
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-1">{label}</h2>
      <p className="text-xs text-gray-500 mb-4">{description}</p>

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
              : file
              ? "border-green-300 bg-green-50"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
          }
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleChange}
          className="hidden"
        />
        {file ? (
          <div>
            <svg className="mx-auto h-8 w-8 text-green-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-gray-900">{file.name}</p>
            <p className="text-xs text-gray-500 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            <p className="text-xs text-blue-600 mt-1">클릭하여 다른 파일 선택</p>
          </div>
        ) : (
          <div>
            <svg className="mx-auto h-8 w-8 text-gray-400 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-sm text-gray-600">끌어다 놓거나 클릭</p>
            <p className="text-xs text-gray-400 mt-1">.xlsx, .xls</p>
          </div>
        )}
      </div>

      <button
        onClick={onUpload}
        disabled={!file || uploading}
        className={`mt-4 w-full py-2.5 rounded-lg font-medium text-sm transition-colors ${
          !file || uploading
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
        ) : (
          "업로드"
        )}
      </button>

      {result && (
        <div className="mt-4 space-y-2">
          {result.success && result.results ? (
            result.results.map((r, i) => (
              <div
                key={i}
                className="p-3 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800"
              >
                <p className="font-medium">{r.type}</p>
                <p className="text-xs mt-0.5">
                  {r.sheetName} — {r.total.toLocaleString()}건 처리, <strong>{r.inserted.toLocaleString()}건 신규 저장</strong>
                  {r.skipped !== undefined && r.skipped > 0 && (
                    <span className="text-gray-500"> ({r.skipped.toLocaleString()}건 이미 존재 → 스킵)</span>
                  )}
                </p>
                {r.errors && r.errors.length > 0 && (
                  <p className="text-xs text-amber-700 mt-1">
                    일부 오류: {r.errors[0]}
                  </p>
                )}
              </div>
            ))
          ) : (
            <div className="p-3 rounded-lg text-sm bg-red-50 border border-red-200 text-red-800">
              <p>{result.error || "업로드 중 오류가 발생했습니다."}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload/rawdata", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (res.ok && data.success) {
        setResult({ success: true, results: data.results });
      } else {
        setResult({ success: false, error: data.error || "서버 오류" });
      }
    } catch {
      setResult({ success: false, error: "네트워크 오류가 발생했습니다." });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          데이터 업로드
        </h1>
        <p className="text-sm text-gray-500 mb-8">
          엑셀 파일을 업로드하면 내용을 자동으로 인식하여 알맞은 테이블에 저장합니다.
        </p>

        <DropZone
          label="엑셀 파일 업로드"
          description="RAW DATA · 월별매출상세 자동 인식"
          file={file}
          onFileSelect={(f) => { setFile(f); setResult(null); }}
          onUpload={upload}
          uploading={uploading}
          result={result}
        />

        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <p className="font-medium mb-2">자동 인식되는 파일/시트</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <div className="flex justify-between">
              <span>기존(MMDD) + 변경(MMDD)</span>
              <span className="text-gray-500">→ 일일 상품관리</span>
            </div>
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
            <div className="flex justify-between col-span-2">
              <span>월별매출상세 (ROWKEY 컬럼 포함 별도 파일)</span>
              <span className="text-gray-500">→ 매출 상세 (누적, 신규만 INSERT)</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            중복 데이터는 자동으로 처리됩니다. 데이터는 누적 저장됩니다.
          </p>
        </div>
      </main>
    </div>
  );
}
