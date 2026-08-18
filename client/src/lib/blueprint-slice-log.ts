/**
 * Pull Blueprint Studio Slice.log text for sealed .ultx analyzes.
 *
 * Chrome blocks File System Access on AppData, and folder <input webkitdirectory>
 * often returns an empty FileList for those paths too. Reliable options:
 *   1) Drag the `logs` folder from File Explorer onto Prints (drag-drop is allowed)
 *   2) Copy/symlink logs outside AppData, then Import logs folder
 *   3) Pick one or more Slice.log files directly (file picker can open AppData files)
 *
 * Future (deferred): a small Windows sync agent could watch
 * `%APPDATA%\Blueprint Studio\logs` and POST new Slice.log files to Railway so
 * multi-HeyGears fleets do not need browser re-import. Not built yet — keep the
 * analyze `sliceLog` upload path as the server entry point when that lands.
 */

/** Env-style path operators paste into Explorer (Win+R / address bar). */
export const BLUEPRINT_STUDIO_LOGS_ENV_PATH = "%APPDATA%\\Blueprint Studio\\logs";

/** Expanded example — username still varies per PC. */
export const BLUEPRINT_STUDIO_LOGS_EXAMPLE_PATH =
  "C:\\Users\\<You>\\AppData\\Roaming\\Blueprint Studio\\logs";

const DB_NAME = "hubspot-blueprint-logs-v1";
const STORE_NAME = "handles";
const HANDLE_KEY = "logsDirectory";
const IMPORT_KEY = "logsImportCache";
const MAX_WALK_DEPTH = 8;
const MAX_SLICE_LOG_FILES = 60;
/** Per-file cap when reading into the import cache. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Upload budget must stay under the server's 8 MiB Slice.log limit.
 * Leave headroom for section headers and multipart framing.
 */
const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
/** When no plate-specific log matches, only merge this many newest logs. */
const MAX_BUNDLE_LOGS = 12;

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

export type SliceLogScanResult = {
  candidates: SliceLogCandidate[];
  totalFiles: number;
  logNamedFiles: number;
  sampleNames: string[];
};

export function supportsBlueprintLogsFolderAccess(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function isBlueprintSliceLogName(fileName: string): boolean {
  const base = fileName.replace(/^.*[/\\]/, "").toLowerCase();
  return base === "slice.log" || /^slice(?:-.*)?\.log$/.test(base);
}

export function looksLikeBlueprintSliceLogText(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("[Slice]") ||
    text.includes("printEstimateTime") ||
    text.includes("printEstimateMaterials") ||
    text.includes("numberOfSlices") ||
    /material cost:/i.test(text) ||
    /Techbag file volume:/i.test(text)
  );
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

function relativePathOf(file: File): string {
  return (file.webkitRelativePath || file.name).replace(/\\/g, "/");
}

/** Scan a FileList (folder import, Explorer drag-drop, or multi file pick). */
export async function scanSliceLogsFromFileList(
  files: ArrayLike<File>,
): Promise<SliceLogScanResult> {
  const list = Array.from(files);
  const sampleNames = list.slice(0, 6).map((file) => relativePathOf(file) || file.name);
  const logNamedFiles = list.filter((file) => /\.log$/i.test(file.name)).length;

  const preferred = list
    .filter((file) => {
      const rel = relativePathOf(file);
      if (depthOfRelativePath(rel) > MAX_WALK_DEPTH) return false;
      return isBlueprintSliceLogName(file.name) || /\.log$/i.test(file.name);
    })
    .sort((a, b) => {
      const aSlice = isBlueprintSliceLogName(a.name) ? 1 : 0;
      const bSlice = isBlueprintSliceLogName(b.name) ? 1 : 0;
      if (aSlice !== bSlice) return bSlice - aSlice;
      return b.lastModified - a.lastModified;
    })
    .slice(0, MAX_SLICE_LOG_FILES);

  const candidates: SliceLogCandidate[] = [];
  for (const file of preferred) {
    try {
      if (file.size <= 0 || file.size > MAX_FILE_BYTES * 4) continue;
      let text = await file.text();
      if (byteLengthUtf8(text) > MAX_FILE_BYTES) {
        text = text.slice(-MAX_FILE_BYTES);
      }
      const nameMatch = isBlueprintSliceLogName(file.name);
      // Named Slice.log: keep non-empty text even if markers are sparse.
      if (!text.trim()) continue;
      if (!nameMatch && !looksLikeBlueprintSliceLogText(text)) continue;
      candidates.push({
        relativePath: relativePathOf(file),
        text,
        lastModified: file.lastModified,
      });
    } catch {
      /* skip unreadable entries */
    }
  }

  return {
    candidates,
    totalFiles: list.length,
    logNamedFiles,
    sampleNames,
  };
}

/** @deprecated Prefer scanSliceLogsFromFileList */
export async function collectSliceLogsFromFileList(
  files: ArrayLike<File>,
): Promise<SliceLogCandidate[]> {
  return (await scanSliceLogsFromFileList(files)).candidates;
}

function rootLabelFromFiles(files: ArrayLike<File>): string {
  const first = Array.from(files)[0];
  const rel = relativePathOf(first ?? new File([], "logs"));
  const root = rel.split("/")[0];
  return root || "logs";
}

export function describeSliceLogImportFailure(scan: SliceLogScanResult): string {
  if (scan.totalFiles === 0) {
    return (
      "Chrome returned no files from that folder (AppData is often blocked). " +
      "Drag the logs folder from File Explorer onto this page, or copy it to Desktop and import that copy, " +
      "or use Add Slice.log and pick files from a project subfolder."
    );
  }
  if (scan.logNamedFiles === 0) {
    const samples = scan.sampleNames.length ? ` Saw: ${scan.sampleNames.join(", ")}` : "";
    return (
      `No .log files in that selection (${scan.totalFiles} file(s)).` +
      ` Pick Blueprint Studio\\logs (project subfolders with Slice.log), or drag that folder here.` +
      samples
    );
  }
  return (
    `Found ${scan.logNamedFiles} .log file(s) among ${scan.totalFiles}, but none looked like Blueprint Slice.log.` +
    ` Open a project folder under logs and use Add Slice.log, or drag the logs folder from Explorer.`
  );
}

export async function importBlueprintLogsFromFileList(
  files: ArrayLike<File>,
  options?: { merge?: boolean },
): Promise<ImportedLogsCache> {
  const scan = await scanSliceLogsFromFileList(files);
  if (!scan.candidates.length) {
    throw new Error(describeSliceLogImportFailure(scan));
  }

  let candidates = scan.candidates;
  if (options?.merge) {
    const existing = await getImportedBlueprintLogsCache();
    if (existing?.candidates.length) {
      const byPath = new Map<string, SliceLogCandidate>();
      for (const candidate of existing.candidates) byPath.set(candidate.relativePath, candidate);
      for (const candidate of scan.candidates) byPath.set(candidate.relativePath, candidate);
      candidates = [...byPath.values()].sort((a, b) => b.lastModified - a.lastModified);
    }
  }

  const cache: ImportedLogsCache = {
    rootLabel: rootLabelFromFiles(files),
    importedAt: Date.now(),
    candidates: candidates.slice(0, MAX_SLICE_LOG_FILES),
  };
  await idbSet(IMPORT_KEY, cache);
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
  // P_YYYYMMDD_HHMMSS export names — match the stamp digits inside Output lines / paths.
  const exportStamp = plateFileName.match(/P_(\d{8})_(\d{6})/i);
  const exportToken = exportStamp ? `${exportStamp[1]}_${exportStamp[2]}`.toLowerCase() : null;

  const targeted = sorted.find((candidate) => {
    const lower = candidate.text.toLowerCase();
    if (uuid && lower.includes(uuid)) return true;
    if (base && lower.includes(`"slicefilename":"${base}"`)) return true;
    if (base.length > 12 && lower.includes(base)) return true;
    if (exportToken && lower.includes(exportToken)) return true;
    return false;
  });
  if (targeted) {
    const text =
      byteLengthUtf8(targeted.text) > MAX_TOTAL_BYTES
        ? targeted.text.slice(-Math.floor(MAX_TOTAL_BYTES / 2))
        : targeted.text;
    return { relativePath: "Slice.log", text };
  }

  // Prefer logs that actually contain estimate Output lines.
  const withEstimates = sorted.filter(
    (candidate) =>
      candidate.text.includes("printEstimateTime") ||
      candidate.text.includes("[Slice] Output:") ||
      candidate.text.includes("material cost:"),
  );
  const pool = (withEstimates.length ? withEstimates : sorted).slice(0, MAX_BUNDLE_LOGS);

  const parts: string[] = [];
  let remaining = MAX_TOTAL_BYTES;
  for (const candidate of pool) {
    if (remaining <= 256) break;
    const header = `----- ${candidate.relativePath} -----\n`;
    const headerBytes = byteLengthUtf8(header) + 1; // joining newline
    let chunk = candidate.text;
    const budget = remaining - headerBytes;
    if (budget <= 0) break;
    if (byteLengthUtf8(chunk) > budget) {
      chunk = chunk.slice(Math.max(0, chunk.length - budget));
    }
    if (!chunk.trim()) continue;
    const part = `${header}${chunk}`;
    parts.push(part);
    remaining -= byteLengthUtf8(part) + (parts.length > 1 ? 1 : 0);
  }
  if (!parts.length) return null;
  return { relativePath: "Slice.log", text: parts.join("\n") };
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
      if (!looksLikeBlueprintSliceLogText(text) && !text.trim()) continue;
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

function bundleToUploadFile(bundle: { relativePath: string; text: string }): File {
  // Always use Slice.log so server name checks and session memory stay consistent.
  return new File([bundle.text], "Slice.log", {
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
