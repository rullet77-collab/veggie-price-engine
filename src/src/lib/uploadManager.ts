// 업로드 상태를 React 컴포넌트 밖(모듈 싱글톤)에 보관.
// SPA 네비게이션으로 컴포넌트가 unmount 돼도 fetch·state 가 살아있어,
// 사용자가 다시 /upload 로 돌아오면 진행 중인 작업과 결과를 그대로 본다.
// localStorage 에도 매 상태 변화마다 백업 → 전체 새로고침/탭 닫음 후에도 결과 복구.

export type SheetResult = {
  sheetName: string;
  type: string;
  total: number;
  inserted: number;
  skipped?: number;
  errors?: string[];
};

export type UploadResult = {
  success: boolean;
  results?: SheetResult[];
  error?: string;
};

export type EntryStatus = "pending" | "uploading" | "done" | "error" | "unknown";

export type Entry = {
  key: string;
  name: string;
  size: number;
  lastModified: number;
  status: EntryStatus;
  result?: UploadResult;
  file: File | null; // 전체 새로고침으로 복구된 항목은 null (재업로드 불가)
};

type PersistedEntry = Omit<Entry, "file">;
type PersistedState = {
  at: number;
  entries: PersistedEntry[];
};

const STORAGE_KEY = "upload:manager:v1";
const TTL_MS = 24 * 60 * 60 * 1000;

let _entries: Entry[] = [];
let _uploading = false;
let _initialized = false;
const listeners = new Set<() => void>();

function entryKey(name: string, size: number, lastModified: number): string {
  return `${name}__${size}__${lastModified}`;
}

function saveToStorage() {
  if (typeof window === "undefined") return;
  try {
    if (_entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const persisted: PersistedState = {
      at: Date.now(),
      entries: _entries.map(({ file: _file, ...rest }) => {
        void _file;
        return rest;
      }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {}
}

function loadFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as PersistedState;
    if (!data || Date.now() - data.at > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    _entries = data.entries.map((e) => ({
      ...e,
      // 새로고침 시점에 "uploading" 이었던 항목은 결과를 확인할 수 없으므로 unknown
      status: e.status === "uploading" ? "unknown" : e.status,
      file: null,
    }));
  } catch {}
}

function ensureInit() {
  if (_initialized) return;
  _initialized = true;
  loadFromStorage();
  // 다른 탭에서의 변경도 반영
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (ev) => {
      if (ev.key !== STORAGE_KEY) return;
      loadFromStorage();
      listeners.forEach((l) => l());
    });
  }
}

function notify() {
  saveToStorage();
  listeners.forEach((l) => l());
}

async function uploadOne(file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload/rawdata", { method: "POST", body: fd });
    const data = await res.json();
    if (res.ok && data.success) return { success: true, results: data.results };
    return { success: false, error: data.error || "서버 오류" };
  } catch {
    return { success: false, error: "네트워크 오류" };
  }
}

export const uploadManager = {
  subscribe(l: () => void) {
    ensureInit();
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getEntries(): Entry[] {
    ensureInit();
    return _entries;
  },
  isUploading(): boolean {
    ensureInit();
    return _uploading;
  },
  addFiles(files: File[]) {
    ensureInit();
    let added = 0;
    for (const f of files) {
      const key = entryKey(f.name, f.size, f.lastModified);
      const existing = _entries.find((e) => e.key === key);
      if (existing) {
        // 같은 파일을 다시 추가하면 file 객체만 갱신 (복구된 항목 재업로드 가능)
        if (!existing.file) {
          existing.file = f;
          if (existing.status === "unknown") existing.status = "pending";
        }
        continue;
      }
      _entries.push({
        key, name: f.name, size: f.size, lastModified: f.lastModified,
        status: "pending", file: f,
      });
      added++;
    }
    if (added > 0 || _entries.length > 0) notify();
  },
  removeEntry(key: string) {
    ensureInit();
    _entries = _entries.filter((e) => e.key !== key);
    notify();
  },
  clearAll() {
    ensureInit();
    _entries = [];
    _uploading = false;
    notify();
  },
  async uploadAll() {
    ensureInit();
    if (_uploading) return;
    _uploading = true;
    notify();
    let anySuccess = false;
    for (let i = 0; i < _entries.length; i++) {
      const entry = _entries[i];
      if (entry.status === "done") continue;
      if (!entry.file) continue; // 복구된 항목 — file 없으면 스킵
      // 진행 상태 표시
      _entries[i] = { ...entry, status: "uploading" };
      notify();
      const result = await uploadOne(entry.file);
      if (result.success) anySuccess = true;
      _entries[i] = {
        ..._entries[i],
        status: result.success ? "done" : "error",
        result,
      };
      notify();
    }
    _uploading = false;
    notify();
    if (anySuccess) {
      try { localStorage.setItem("products:invalidate", String(Date.now())); } catch {}
    }
  },
};
