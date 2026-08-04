const MEBIBYTE = 1024 * 1024;

export const DEFAULT_PRINT_FILE_MAX_MB = 512;
export const MIN_PRINT_FILE_MAX_MB = 64;
export const MAX_PRINT_FILE_MAX_MB = 1024;

/**
 * CTB uploads are held in memory only while their metadata is read. Keep the
 * upper bound configurable without allowing a malformed Railway variable to
 * unexpectedly make the service accept an unsafe upload size.
 */
export function getPrintFileMaxMb(value = process.env.PRINT_FILE_MAX_MB): number {
  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_PRINT_FILE_MAX_MB ||
    parsed > MAX_PRINT_FILE_MAX_MB
  ) {
    return DEFAULT_PRINT_FILE_MAX_MB;
  }

  return parsed;
}

export const PRINT_FILE_MAX_MB = getPrintFileMaxMb();
export const PRINT_FILE_MAX_BYTES = PRINT_FILE_MAX_MB * MEBIBYTE;
export const PRINT_FILE_MAX_LABEL = `${PRINT_FILE_MAX_MB} MB`;
