/**
 * Pull Blueprint Studio Slice.log text for sealed .ultx analyzes.
 *
 * Chrome/Edge block File System Access on AppData ("contains system files"),
 * so the primary path is a one-shot webkitdirectory import that caches Slice.log
 * contents in IndexedDB. Live directory handles remain as an optional fallback
 * for non-AppData copies of the logs tree.
 */

const DB_NAME = "hubspot-blueprint-logs-v1";
const STORE_NAME = "handles";
const HANDLE_KEY = "logsDirectory";
const IMPORT_KEY = "logsImportCache";
const MAX_WALK_DEPTH = 4;
const MAX_SLICE_LOG_FILES = 40;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export type SliceLogCandidate = {
  relativePath: string;
  text: string;
  lastModified: number;
};

export type ImportedLogsCache = {
  rootLabel: string;
  importedAt: number;
  candidates: SliceLogCandidate[];
};

export type BlueprintLogsStatus =
  | { supported: true; ready: false }
  | {
      supported: true;
      ready: true;
      source: "import";
      name: string;
      fileCount: number;
      importedAt: number;
    }
  | { supported: true; ready: true; source: "directory"; name: string };

/** @deprecated Use BlueprintLogsStatus */
export type LinkedLogsStatus = BlueprintLogsStatus;

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

function byteLengthUtf8(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

function depthOfRelativePath(path: string): number {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return 0;
  return normalized.split("/").length - 1;
}

/** Pull Slice.log files out of a webkitdirectory FileList (works for AppData). */
export async function collectSliceLogsFromFileList(
  files: ArrayLike<File>,
): Promise<SliceLogCandidate[]> {
  const list = Array.from(files);
  const sliceFiles = list
    .filter((file) => {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
      if (depthOfRelativePath(rel) > MAX_WALK_DEPTH) return false;
      return isBlueprintSliceLogName(file.name);
    })
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, MAX_SLICE_LOG_FILES);

  const candidates: SliceLogCandidate[] = [];
  for (const file of sliceFiles) {
    try {
      if (file.size <= 0 || file.size > MAX_FILE_BYTES * 4) continue;
      let text = await file.text();
      if (byteLengthUtf8(text) > MAX_FILE_BYTES) {
        text = text.slice(-MAX_FILE_BYTES);
      }
      if (!text.includes("[Slice]")) continue;
      candidates.push({
        relativePath: (file.webkitRelativePath || file.name).replace(/\\/g, "/"),
        text,
        lastModified: file.lastModified,
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return candidates;
}

function rootLabelFromFiles(files: ArrayLike<File>): string {
  const first = Array.from(files)[0];
  const rel = (first?.webkitRelativePath || "").replace(/\\/g, "/");
  const root = rel.split("/")[0];
  return root || "logs";
}

export async function importBlueprintLogsFromFileList(
  files: ArrayLike<File>,
): Promise<ImportedLogsCache> {
  const candidates = await collectSliceLogsFromFileList(files);
  if (!candidates.length) {
    throw new Error(
      "No Slice.log files found in that folder. Pick Blueprint Studio\\logs (the folder that contains project subfolders).",
    );
  }
  const cache: ImportedLogsCache = {
    rootLabel: rootLabelFromFiles(files),
    importedAt: Date.now(),
    candidates,
  };
  await idbSet(IMPORT_KEY, cache);
  // Prefer import over a stale AppData directory handle that Chrome cannot re-open.
  await idbDelete(HANDLE_KEY);
  return cache;
}

export async function getImportedBlueprintLogsCache(): Promise<ImportedLogsCache | null> {
  try {
    const cache = await idbGet<ImportedLogsCache>(IMPORT_KEY);
    if (!cache?.candidates?.length) return null;
    return cache;
  } catch {
    return null;
  }
}

export async function clearImportedBlueprintLogsCache(): Promise<void> {
  await idbDelete(IMPORT_KEY);
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
  await idbDelete(IMPORT_KEY);
  return handle;
}

export async function unlinkBlueprintLogsDirectory(): Promise<void> {
  await idbDelete(HANDLE_KEY);
  await idbDelete(IMPORT_KEY);
}

export async function getLinkedBlueprintLogsStatus(): Promise<BlueprintLogsStatus> {
  const imported = await getImportedBlueprintLogsCache();
  if (imported) {
    return {
      supported: true,
      ready: true,
      source: "import",
      name: imported.rootLabel,
      fileCount: imported.candidates.length,
      importedAt: imported.importedAt,
    };
  }
  const handle = await getLinkedBlueprintLogsDirectory();
  if (handle) {
    return { supported: true, ready: true, source: "directory", name: handle.name };
  }
  return { supported: true, ready: false };
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

function bundleToUploadFile(
  bundle: { relativePath: string; text: string },
): File {
  return new File([bundle.text], bundle.relativePath.replace(/^.*[/\\]/, "") || "Slice.log", {
    type: "text/plain",
  });
}

/** Build a File to upload as `sliceLog` from live folder link or imported cache. */
export async function buildSliceLogUploadFromLinkedFolder(
  plateFileName: string,
): Promise<File | null> {
  const dir = await getLinkedBlueprintLogsDirectory();
  if (dir) {
    const candidates = await collectSliceLogsFromDirectory(dir);
    const bundle = assembleSliceLogBundle(candidates, plateFileName);
    if (bundle?.text.trim()) return bundleToUploadFile(bundle);
  }

  const imported = await getImportedBlueprintLogsCache();
  if (imported?.candidates.length) {
    const bundle = assembleSliceLogBundle(imported.candidates, plateFileName);
    if (bundle?.text.trim()) return bundleToUploadFile(bundle);
  }

  return null;
}
