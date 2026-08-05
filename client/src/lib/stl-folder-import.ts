/**
 * Browser-local STL folder import (drag-drop / choose folder).
 * Never reads arbitrary disk paths — only files the user selects.
 */

export type ImportedStlFile = {
  fileName: string;
  relativePath: string;
  file: File;
  sizeBytes: number;
};

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export function isStlFileName(name: string): boolean {
  return /\.stl$/i.test(name.trim());
}

export function collectStlFilesFromFileList(list: FileList | File[]): ImportedStlFile[] {
  const files = Array.from(list);
  const seen = new Set<string>();
  const out: ImportedStlFile[] = [];

  for (const file of files) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() || file.name;
    const fileName = baseName(relativePath);
    if (!isStlFileName(fileName)) continue;
    const key = fileName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fileName,
      relativePath,
      file,
      sizeBytes: file.size,
    });
  }

  return out.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
}

/** Best-effort folder name from webkitRelativePath (first path segment). */
export function inferKitNameFromImports(imports: ImportedStlFile[]): string {
  for (const item of imports) {
    const parts = item.relativePath.split(/[/\\]/).filter(Boolean);
    if (parts.length >= 2) return parts[0]!.replace(/@.*$/, "").trim() || "Imported kit";
  }
  return "Imported kit";
}

/**
 * Collect File entries from a drop that may include directories.
 * Uses webkitGetAsEntry when available.
 */
export async function collectStlFilesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<ImportedStlFile[]> {
  const items = Array.from(dataTransfer.items || []);
  if (items.length === 0 && dataTransfer.files?.length) {
    return collectStlFilesFromFileList(dataTransfer.files);
  }

  const files: File[] = [];

  async function walkEntry(entry: FileSystemEntry | null): Promise<void> {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
      });
      if (file) {
        // Preserve relative path for folder drops when possible.
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

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) await walkEntry(entry);
    else if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (files.length === 0 && dataTransfer.files?.length) {
    return collectStlFilesFromFileList(dataTransfer.files);
  }
  return collectStlFilesFromFileList(files);
}
