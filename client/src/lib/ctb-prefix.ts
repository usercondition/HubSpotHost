/**
 * Browser helper: sample only the start of a Mega/Mighty 8K CTB so we never
 * push a multi-hundred-MB plate through the reverse proxy.
 *
 * The server reconstructs a range reader from this prefix + the real file size.
 * CTB planning metadata (classic + encrypted) lives in early header/settings
 * blocks, well within the first couple of megabytes.
 */
export const CTB_ANALYZE_PREFIX_BYTES = 2 * 1024 * 1024;

export function isCtbFileName(fileName: string): boolean {
  return /\.ctb$/i.test(fileName.trim());
}

export function ctbPrefixBlob(file: File): {
  blob: Blob;
  fullFileSize: number;
  truncated: boolean;
} {
  const fullFileSize = file.size;
  const take = Math.min(fullFileSize, CTB_ANALYZE_PREFIX_BYTES);
  return {
    blob: file.slice(0, take),
    fullFileSize,
    truncated: fullFileSize > take,
  };
}

export function describeCtbUploadPlan(file: File): string {
  const mb = file.size / (1024 * 1024);
  if (file.size <= CTB_ANALYZE_PREFIX_BYTES) {
    return `Reading ${mb.toFixed(0)} MB plate locally…`;
  }
  return `Sampling first ${CTB_ANALYZE_PREFIX_BYTES / (1024 * 1024)} MB of ${mb.toFixed(0)} MB Mega plate (no full upload)…`;
}
