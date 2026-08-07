/**
 * Browser-local kit import (drag-drop / choose folder).
 * Walks nested folders and opens .zip archives (including zips inside zips).
 * Never reads arbitrary disk paths — only files the user selects.
 */

import { unzipSync } from "fflate";

export type ImportedStlFile = {
  fileName: string;
  relativePath: string;
  file: File;
  sizeBytes: number;
  /** Where the STL came from. */
  source: "folder" | "zip";
  /** Archive path when source is zip (e.g. Kit/Parts.zip → nested/a.stl). */
  archivePath?: string;
  /**
   * Immediate parent folder or zip container for this STL
   * (e.g. Kit/Head/18.stl → "Head", Delivery.zip/Legs/a.stl → "Legs").
   * Empty when the STL sits flat at the kit root.
   */
  folderGroup?: string;
};

export type KitImportSummary = {
  imports: ImportedStlFile[];
  archivesOpened: string[];
  unsupportedArchives: string[];
  duplicatesSkipped: number;
  looseStlCount: number;
  zipStlCount: number;
  /** Distinct structural groups (subfolders / zip containers) with bit counts. */
  folderGroups: Array<{ group: string; count: number }>;
};

const MAX_ZIP_DEPTH = 3;
const MAX_ZIP_BYTES = 250 * 1024 * 1024;

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function isStlFileName(name: string): boolean {
  return /\.stl$/i.test(name.trim());
}

export function isZipFileName(name: string): boolean {
  return /\.zip$/i.test(name.trim());
}

/** Archives we cannot open in-browser — reported so the operator knows. */
export function isUnsupportedArchiveName(name: string): boolean {
  return /\.(rar|7z|tar|tgz|gz|bz2|xz|dmg|iso)$/i.test(name.trim());
}

function emptySummary(): KitImportSummary {
  return {
    imports: [],
    archivesOpened: [],
    unsupportedArchives: [],
    duplicatesSkipped: 0,
    looseStlCount: 0,
    zipStlCount: 0,
    folderGroups: [],
  };
}

function cleanSegment(segment: string): string {
  return segment.replace(/\.zip$/i, "").replace(/@.*$/, "").trim();
}

/**
 * Infer a human group from the path so multi-folder / multi-zip kits stay organized.
 * Prefers the immediate parent directory; falls back to the enclosing zip name.
 */
export function inferFolderGroup(relativePath: string, archivePath?: string): string {
  const parts = relativePath.split(/[/\\]/).map(cleanSegment).filter(Boolean);
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2]!;
    // Skip generic bucket names that don't help the operator
    if (parent && !/^(stl|stls|files|models|mesh|meshes|3d|objects)$/i.test(parent)) {
      return parent;
    }
  }
  if (archivePath) {
    const archiveName = cleanSegment(baseName(archivePath));
    if (archiveName) return archiveName;
  }
  return "";
}

function finalizeFolderGroups(summary: KitImportSummary): void {
  const counts = new Map<string, number>();
  for (const item of summary.imports) {
    const group = item.folderGroup?.trim();
    if (!group) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  summary.folderGroups = Array.from(counts.entries())
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group, undefined, { numeric: true }));
}

function sortImports(imports: ImportedStlFile[]): ImportedStlFile[] {
  return imports.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
}

/**
 * Prefer a loose folder STL over one extracted from a zip when basenames collide.
 * Among equals, keep the first seen.
 */
function preferIncoming(existing: ImportedStlFile, incoming: ImportedStlFile): boolean {
  if (existing.source === "zip" && incoming.source === "folder") return true;
  return false;
}

function rememberUnsupported(summary: KitImportSummary, relativePath: string): void {
  if (!summary.unsupportedArchives.includes(relativePath)) {
    summary.unsupportedArchives.push(relativePath);
  }
}

function addImport(summary: KitImportSummary, item: ImportedStlFile): void {
  const withGroup: ImportedStlFile = {
    ...item,
    folderGroup: item.folderGroup ?? inferFolderGroup(item.relativePath, item.archivePath),
  };
  const key = withGroup.fileName.toLowerCase();
  const existingIndex = summary.imports.findIndex((row) => row.fileName.toLowerCase() === key);
  if (existingIndex >= 0) {
    const existing = summary.imports[existingIndex]!;
    if (preferIncoming(existing, withGroup)) {
      summary.imports[existingIndex] = withGroup;
    }
    summary.duplicatesSkipped += 1;
    return;
  }
  summary.imports.push(withGroup);
  if (withGroup.source === "folder") summary.looseStlCount += 1;
  else summary.zipStlCount += 1;
}

async function extractStlsFromZip(
  zipFile: File,
  archivePath: string,
  summary: KitImportSummary,
  depth: number,
): Promise<void> {
  if (depth > MAX_ZIP_DEPTH) {
    rememberUnsupported(summary, `${archivePath} (nested too deep)`);
    return;
  }
  if (zipFile.size > MAX_ZIP_BYTES) {
    rememberUnsupported(summary, `${archivePath} (too large)`);
    return;
  }
  if (zipFile.size === 0) {
    rememberUnsupported(summary, `${archivePath} (empty file)`);
    return;
  }

  let entries: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await zipFile.arrayBuffer());
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      rememberUnsupported(summary, `${archivePath} (not a zip file)`);
      return;
    }
    // Do not use unzipSync filter — fflate throws on store/LZMA entries when filtered.
    entries = unzipSync(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "could not open";
    rememberUnsupported(summary, `${archivePath} (${reason})`);
    return;
  }

  if (!summary.archivesOpened.includes(archivePath)) {
    summary.archivesOpened.push(archivePath);
  }

  let stlOrZipSeen = 0;
  for (const [entryPath, data] of Object.entries(entries)) {
    if (!data) continue;
    const normalized = entryPath.replace(/\\/g, "/");
    if (normalized.endsWith("/")) continue;
    if (normalized.startsWith("__MACOSX/") || normalized.includes("/__MACOSX/")) continue;
    const fileName = baseName(normalized);
    const relativePath = `${archivePath}/${normalized}`.replace(/\/+/g, "/");

    if (isStlFileName(fileName)) {
      stlOrZipSeen += 1;
      const copy = new Uint8Array(data);
      const file = new File([copy], fileName, { type: "model/stl" });
      addImport(summary, {
        fileName,
        relativePath,
        file,
        sizeBytes: file.size,
        source: "zip",
        archivePath,
      });
      continue;
    }

    if (isZipFileName(fileName)) {
      stlOrZipSeen += 1;
      const copy = new Uint8Array(data);
      const nested = new File([copy], fileName, { type: "application/zip" });
      await extractStlsFromZip(nested, relativePath, summary, depth + 1);
      continue;
    }

    if (isUnsupportedArchiveName(fileName)) {
      rememberUnsupported(summary, relativePath);
    }
  }

  if (stlOrZipSeen === 0 && summary.imports.every((row) => row.archivePath !== archivePath)) {
    rememberUnsupported(summary, `${archivePath} (no .stl files inside)`);
  }
}

/**
 * Sync helper for plain FileList / loose STLs (no zip open).
 * Prefer {@link collectKitFilesFromFileList} when archives may be present.
 */
export function collectStlFilesFromFileList(list: FileList | File[]): ImportedStlFile[] {
  return collectKitFilesFromFileListSync(list).imports;
}

function collectKitFilesFromFileListSync(list: FileList | File[]): KitImportSummary {
  const summary = emptySummary();
  for (const file of Array.from(list)) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
    const fileName = baseName(relativePath);
    if (!isStlFileName(fileName)) {
      if (isUnsupportedArchiveName(fileName)) rememberUnsupported(summary, relativePath);
      continue;
    }
    addImport(summary, {
      fileName,
      relativePath,
      file,
      sizeBytes: file.size,
      source: "folder",
    });
  }
  summary.imports = sortImports(summary.imports);
  finalizeFolderGroups(summary);
  return summary;
}

/** Walk nested folders + open .zip archives found in the selection. */
export async function collectKitFilesFromFileList(
  list: FileList | File[],
): Promise<KitImportSummary> {
  const summary = emptySummary();
  const files = Array.from(list);

  for (const file of files) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
    const fileName = baseName(relativePath);

    if (isStlFileName(fileName)) {
      addImport(summary, {
        fileName,
        relativePath,
        file,
        sizeBytes: file.size,
        source: "folder",
      });
      continue;
    }

    if (isZipFileName(fileName)) {
      await extractStlsFromZip(file, relativePath, summary, 1);
      continue;
    }

    if (isUnsupportedArchiveName(fileName)) {
      rememberUnsupported(summary, relativePath);
    }
  }

  summary.imports = sortImports(summary.imports);
  summary.archivesOpened.sort((a, b) => a.localeCompare(b));
  summary.unsupportedArchives.sort((a, b) => a.localeCompare(b));
  finalizeFolderGroups(summary);
  return summary;
}

/** Best-effort kit name from folder path or zip basename. */
export function inferKitNameFromImports(imports: ImportedStlFile[]): string {
  for (const item of imports) {
    const parts = item.relativePath.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2) {
      const root = parts[0]!.replace(/@.*$/, "").replace(/\.zip$/i, "").trim();
      if (root) return root;
    }
  }
  for (const item of imports) {
    if (item.archivePath) {
      const archiveName = baseName(item.archivePath).replace(/\.zip$/i, "").trim();
      if (archiveName) return archiveName;
    }
  }
  return "Imported kit";
}

export function formatKitImportNote(summary: KitImportSummary, kitName: string): string {
  if (summary.imports.length === 0) {
    if (summary.unsupportedArchives.length > 0) {
      return `Could not load parts. ${summary.unsupportedArchives
        .slice(0, 4)
        .join("; ")}${summary.unsupportedArchives.length > 4 ? "…" : ""}. Use a .zip (or a folder of .stl files).`;
    }
    return "No .stl files found. Choose a folder that contains .stl parts, or a .zip of those parts.";
  }

  const parts: string[] = [
    `Loaded ${summary.imports.length} part${summary.imports.length === 1 ? "" : "s"} from “${kitName}”`,
  ];
  if (summary.looseStlCount > 0 && summary.zipStlCount > 0) {
    parts.push(`${summary.looseStlCount} from folders, ${summary.zipStlCount} from zip`);
  } else if (summary.zipStlCount > 0) {
    parts.push(`${summary.zipStlCount} from zip`);
  }
  if (summary.archivesOpened.length > 0) {
    parts.push(
      `opened ${summary.archivesOpened.length} archive${summary.archivesOpened.length === 1 ? "" : "s"}`,
    );
  }
  if (summary.folderGroups.length >= 2) {
    const preview = summary.folderGroups
      .slice(0, 4)
      .map((row) => `${row.group} (${row.count})`)
      .join(", ");
    parts.push(
      `grouped by ${summary.folderGroups.length} folders/zips: ${preview}${
        summary.folderGroups.length > 4 ? "…" : ""
      }`,
    );
  }
  if (summary.duplicatesSkipped > 0) {
    parts.push(`skipped ${summary.duplicatesSkipped} duplicate name${summary.duplicatesSkipped === 1 ? "" : "s"}`);
  }
  let note = `${parts.join(" · ")}. Select parts that still need printing, then make a plate.`;
  if (summary.unsupportedArchives.length > 0) {
    note += ` Skipped: ${summary.unsupportedArchives
      .slice(0, 4)
      .join(", ")}${summary.unsupportedArchives.length > 4 ? "…" : ""}.`;
  }
  return note;
}

/**
 * Collect File entries from a drop that may include directories and zips.
 * Uses webkitGetAsEntry when available (recursive subfolders).
 *
 * Important: call this (or {@link beginKitImportFromDataTransfer}) synchronously
 * during the drop event — browsers clear DataTransfer after the handler returns.
 */
export async function collectStlFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<ImportedStlFile[]> {
  const summary = await collectKitFilesFromDataTransfer(dataTransfer);
  return summary.imports;
}

type CapturedDropItem =
  | { kind: "entry"; entry: FileSystemEntry }
  | { kind: "file"; file: File };

/** Snapshot drop payloads before the browser clears DataTransfer. */
export function captureDataTransferItems(dataTransfer: DataTransfer): CapturedDropItem[] {
  const items = Array.from(dataTransfer.items || []);
  const captured: CapturedDropItem[] = [];

  for (const item of items) {
    const entry =
      typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) {
      captured.push({ kind: "entry", entry });
      continue;
    }
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) captured.push({ kind: "file", file });
    }
  }

  if (captured.length === 0 && dataTransfer.files?.length) {
    for (const file of Array.from(dataTransfer.files)) {
      captured.push({ kind: "file", file });
    }
  }

  return captured;
}

export function beginKitImportFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<KitImportSummary> {
  const captured = captureDataTransferItems(dataTransfer);
  return collectKitFilesFromCapturedItems(captured);
}

export async function collectKitFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<KitImportSummary> {
  return collectKitFilesFromCapturedItems(captureDataTransferItems(dataTransfer));
}

async function collectKitFilesFromCapturedItems(
  captured: CapturedDropItem[],
): Promise<KitImportSummary> {
  if (captured.length === 0) return emptySummary();

  const files: File[] = [];

  async function walkEntry(entry: FileSystemEntry | null): Promise<void> {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) {
        Object.defineProperty(file, "webkitRelativePath", {
          configurable: true,
          value: entry.fullPath.replace(/^\//, ""),
        });
        files.push(file);
      }
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = (): Promise<FileSystemEntry[]> =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const child of batch) await walkEntry(child);
        batch = await readBatch();
      }
    }
  }

  for (const item of captured) {
    if (item.kind === "entry") await walkEntry(item.entry);
    else files.push(item.file);
  }

  return collectKitFilesFromFileList(files);
}
