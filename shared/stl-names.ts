/**
 * Shared STL path / filename helpers for order parts and plate bits.
 * Keep server + client import paths consistent from this module.
 */

/** Last path segment from a relative or archive path. */
export function pathBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** Display label from an STL filename (drops extension). */
export function labelFromStlFileName(fileName: string): string {
  return fileName.replace(/\.stl$/i, "").trim() || fileName;
}

/** Return a basename STL filename, or null if the path is not an .stl. */
export function normalizeStlFileName(raw: string): string | null {
  const name = pathBaseName(raw).trim();
  if (!name || !/\.stl$/i.test(name)) return null;
  return name;
}
