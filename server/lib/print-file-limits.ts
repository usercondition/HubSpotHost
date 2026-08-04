const MEBIBYTE = 1024 * 1024;

/** Default allows Mega/Mighty 8K plates without a custom Railway variable. */
export const DEFAULT_PRINT_FILE_MAX_MB = 2048;
export const MIN_PRINT_FILE_MAX_MB = 64;
/** Hard ceiling. Uploads are stored on disk temporarily and only header ranges are read. */
export const MAX_PRINT_FILE_MAX_MB = 4096;

/**
 * CTB uploads land on disk temporarily while metadata ranges are read. Keep the
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
