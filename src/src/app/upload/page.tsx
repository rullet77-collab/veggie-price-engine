"use client";

import { useState, useRef, useCallback, DragEvent, ChangeEvent } from "react";

type UploadResult = {
  success: boolean;
  total?: number;
  inserted?: number;
  error?: string;
};

type UploadType = "purchase" | "sales";

function DropZone({
  type,
  label,
  file,
  onFileSelect,
  onUpload,
  uploading,
  result,
}: {
  type: UploadType;
  label: string;
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
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile && isExcelFile(droppedFile)) {
        onFileSelect(droppedFile);
      }
    },
    [onFileSelect]
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (selected) {
        onFileSelect(selected);
      }
    },
    [onFileSelect]
  );

  return (
    <div className="flex-1 bg-white rounded-lg border border-gray-200 shadow-sm p-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">{label}</h2>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors
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
            <svg
              className="mx-auto h-10 w-10 text-green-500 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-sm font-medium text-gray-900">{file.name}</p>
            <p className="text-xs text-gray-500 mt-1">
              {(file.size / 1024).toFixed(1)} KB
            </p>
            <p className="text-xs text-blue-600 mt-2">
              다른 파일을 선택하려면 클릭하세요
            </p>
          </div>
        ) : (
          <div>
            <svg
              className="mx-auto h-10 w-10 text-gray-400 mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="text-sm text-gray-600">
              엑셀 파일을 끌어다 놓거나 클릭하여 선택
            </p>
            <p className="text-xs text-gray-400 mt-1">.xlsx, .xls 파일만 가능</p>
          </div>
        )}
      </div>

      <button
        onClick={onUpload}
        disabled={!file || uploading}
        className={`
          mt-4 w-full py-2.5 rounded-lg font-medium text-sm transition-colors
          ${
            !file || uploading
              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
          }
        `}
      >
        {uploading ? (
          <span className="flex items-center justify-center gap-2">
            <svg
              className="animate-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            업로드 중...
          </span>
        ) : (
          "업로드"
        )}
      </button>

      {result && (
        <div
          className={`mt-4 p-3 rounded-lg text-sm ${
            result.success
              ? "bg-green-50 border border-green-200 text-green-800"
              : "bg-red-50 border border-red-200 text-red-800"
          }`}
        >
          {result.success ? (
            <p>
              {result.total?.toLocaleString()}건 처리 완료 (중복 제외{" "}
              {result.inserted?.toLocaleString()}건 신규 추가)
            </p>
          ) : (
            <p>{result.error || "업로드 중 오류가 발생했습니다."}</p>
          )}
        </div>
      )}
    </div>
  );
}

function isExcelFile(file: File): boolean {
  const validTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
  ];
  return (
    validTypes.includes(file.type) ||
    file.name.endsWith(".xlsx") ||
    file.name.endsWith(".xls")
  );
}

export default function UploadPage() {
  const [purchaseFile, setPurchaseFile] = useState<File | null>(null);
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [purchaseUploading, setPurchaseUploading] = useState(false);
  const [salesUploading, setSalesUploading] = useState(false);
  const [purchaseResult, setPurchaseResult] = useState<UploadResult | null>(
    null
  );
  const [salesResult, setSalesResult] = useState<UploadResult | null>(null);

  const uploadFile = async (type: UploadType) => {
    const file = type === "purchase" ? purchaseFile : salesFile;
    const setUploading =
      type === "purchase" ? setPurchaseUploading : setSalesUploading;
    const setResult =
      type === "purchase" ? setPurchaseResult : setSalesResult;

    if (!file) return;

    setUploading(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/upload/${type}`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResult({
          success: true,
          total: data.total,
          inserted: data.inserted,
        });
      } else {
        setResult({
          success: false,
          error: data.error || "서버 오류가 발생했습니다.",
        });
      }
    } catch (err) {
      setResult({
        success: false,
        error: "네트워크 오류가 발생했습니다.",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          엑셀 데이터 업로드
        </h1>
        <p className="text-sm text-gray-500 mb-8">
          천년경영 매입상세/매출상세 엑셀 파일을 업로드하여 DB에 적재합니다.
        </p>

        <div className="flex flex-col md:flex-row gap-6">
          <DropZone
            type="purchase"
            label="매입상세 업로드"
            file={purchaseFile}
            onFileSelect={(f) => {
              setPurchaseFile(f);
              setPurchaseResult(null);
            }}
            onUpload={() => uploadFile("purchase")}
            uploading={purchaseUploading}
            result={purchaseResult}
          />

          <DropZone
            type="sales"
            label="매출상세 업로드"
            file={salesFile}
            onFileSelect={(f) => {
              setSalesFile(f);
              setSalesResult(null);
            }}
            onUpload={() => uploadFile("sales")}
            uploading={salesUploading}
            result={salesResult}
          />
        </div>

        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <p className="font-medium mb-1">참고사항</p>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>
              천년경영 매입상세/매출상세 엑셀 파일만 지원합니다 (.xlsx, .xls)
            </li>
            <li>
              상품코드가 products 테이블에 등록되어 있어야 정상 처리됩니다
            </li>
            <li>
              중복 데이터는 자동으로 건너뜁니다 (ON CONFLICT DO NOTHING)
            </li>
            <li>대용량 파일은 처리에 시간이 걸릴 수 있습니다</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
