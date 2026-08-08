/**
 * Link a local Blueprint Studio `logs` folder via the File System Access API
 * so sealed .ultx analyzes can pull Slice.log automatically in Chrome/Edge.
 *
 * The directory handle is stored in IndexedDB. Railway never sees the disk —
 * only the Slice.log text uploaded with each analyze request.
 */

const DB_NAME = "hubspot-blueprint-logs-v1";
const STORE_NAME = "handles";
const HANDLE_KEY = "logsDirectory";
const MAX_WALK_DEPTH = 4;
const MAX_SLICE_LOG_FILES = 40;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export type LinkedLogsStatus =
  | { supported: false; linked: false; reason: string }
  | { supported: true; linked: false }
  | { supported: true; linked: true; name: string };

type SliceLogCandidate = {
  relativePath: string;
  text: string;
  lastModified: number;
};

export function supportsBlueprintLogsFolderAccess(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function isBlueprintSliceLogName(fileName: string): boolean {
  const base = fileName.replace(/^.*[/\\]/, "").toLowerCase();
  return base === "slice.log" || /^slice(?:-.*)?\.log$/.test(base);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
  } finally {
    db.close();
  }
}

async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const mode = { mode: "read" as const };
  if ((await handle.queryPermission(mode)) === "granted") return true;
  if ((await handle.requestPermission(mode)) === "granted") return true;
  return false;
}

export async function getLinkedBlueprintLogsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsBlueprintLogsFolderAccess()) return null;
  try {
    const handle = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
    if (!handle) return null;
    if (!(await ensureReadPermission(handle))) return null;
    return handle;
  } catch {
    return null;
  }
}

export async function linkBlueprintLogsDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!supportsBlueprintLogsFolderAccess()) {
    throw new Error("This browser cannot link a local folder. Use Chrome or Edge.");
  }
  const handle = await window.showDirectoryPicker({
    id: "blueprint-studio-logs",
    mode: "read",
    startIn: "documents",
  });
  if (!(await ensureReadPermission(handle))) {
    throw new Error("Permission to read the Blueprint logs folder was denied.");
  }
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

export async function unlinkBlueprintLogsDirectory(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

export async function getLinkedBlueprintLogsStatus(): Promise<LinkedLogsStatus> {
  if (!supportsBlueprintLogsFolderAccess()) {
    return {
      supported: false,
      linked: false,
      reason: "Folder linking needs Chrome or Edge.",
    };
  }
  const handle = await getLinkedBlueprintLogsDirectory();
  if (!handle) return { supported: true, linked: false };
  return { supported: true, linked: true, name: handle.name };
}

async function walkSliceLogs(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  out: Array<{ relativePath: string; handle: FileSystemFileHandle }>,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_SLICE_LOG_FILES) return;
  for await (const [name, entry] of dir.entries()) {
    if (out.length >= MAX_SLICE_LOG_FILES) return;
    if (entry.kind === "directory") {
      await walkSliceLogs(entry, prefix ? `${prefix}/${name}` : name, depth + 1, out);
      continue;
    }
    if (entry.kind === "file" && isBlueprintSliceLogName(name)) {
      out.push({ relativePath: prefix ? `${prefix}/${name}` : name, handle: entry });
    }
  }
}

function byteLengthUtf8(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

/** Prefer a log that mentions this plate; otherwise merge newest logs under the byte budget. */
export function assembleSliceLogBundle(
  candidates: SliceLogCandidate[],
  plateFileName: string,
): { relativePath: string; text: string } | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.lastModified - a.lastModified);
  const base = plateFileName.replace(/^.*[/\\]/, "").toLowerCase();
  const uuidMatch = plateFileName.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  const uuid = uuidMatch?.[0]?.toLowerCase() ?? null;

  const targeted = sorted.find((candidate) => {
    const lower = candidate.text.toLowerCase();
    if (uuid && lower.includes(uuid)) return true;
    if (base && lower.includes(`"slicefilename":"${base}"`)) return true;
    if (base.length > 12 && lower.includes(base)) return true;
    return false;
  });
  if (targeted) {
    return { relativePath: targeted.relativePath, text: targeted.text };
  }

  const parts: string[] = [];
  let remaining = MAX_TOTAL_BYTES;
  for (const candidate of sorted) {
    if (remaining <= 0) break;
    let chunk = candidate.text;
    const size = byteLengthUtf8(chunk);
    if (size > remaining) {
      chunk = chunk.slice(Math.max(0, chunk.length - remaining));
    }
    if (!chunk.trim()) continue;
    parts.push(`----- ${candidate.relativePath} -----\n${chunk}`);
    remaining -= byteLengthUtf8(chunk);
  }
  if (!parts.length) return null;
  return { relativePath: "Blueprint-logs-bundle.log", text: parts.join("\n") };
}

export async function collectSliceLogsFromDirectory(
  dir: FileSystemDirectoryHandle,
): Promise<SliceLogCandidate[]> {
  const files: Array<{ relativePath: string; handle: FileSystemFileHandle }> = [];
  await walkSliceLogs(dir, "", 0, files);
  const candidates: SliceLogCandidate[] = [];
  for (const file of files) {
    try {
      const blob = await file.handle.getFile();
      if (blob.size <= 0 || blob.size > MAX_FILE_BYTES * 4) continue;
      let text = await blob.text();
      if (byteLengthUtf8(text) > MAX_FILE_BYTES) {
        text = text.slice(-MAX_FILE_BYTES);
      }
      if (!text.includes("[Slice]")) continue;
      candidates.push({
        relativePath: file.relativePath,
        text,
        lastModified: blob.lastModified,
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return candidates;
}

/** Build a File to upload as `sliceLog`, or null when the linked folder has nothing useful. */
export async function buildSliceLogUploadFromLinkedFolder(
  plateFileName: string,
): Promise<File | null> {
  const dir = await getLinkedBlueprintLogsDirectory();
  if (!dir) return null;
  const candidates = await collectSliceLogsFromDirectory(dir);
  const bundle = assembleSliceLogBundle(candidates, plateFileName);
  if (!bundle?.text.trim()) return null;
  return new File([bundle.text], bundle.relativePath.replace(/^.*[/\\]/, "") || "Slice.log", {
    type: "text/plain",
  });
}
