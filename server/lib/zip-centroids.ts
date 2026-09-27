/**
 * US ZIP / city centroids bundled from GeoNames (CC BY 4.0, www.geonames.org).
 * Loaded from disk. Customer addresses are never sent out to geocode.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexZipRows, type ZipIndex } from "../../shared/order-origins";

let cached: ZipIndex | null = null;

function bundleDir(): string | null {
  try {
    if (typeof import.meta.url === "string") return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  return null;
}

function centroidFile(): string | null {
  const here = bundleDir();
  const candidates = [
    here ? path.join(here, "us-zip-centroids.json") : "",
    path.join(process.cwd(), "shared/geo/us-zip-centroids.json"),
    path.join(process.cwd(), "dist/us-zip-centroids.json"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function loadUsZipCentroids(): ZipIndex {
  if (cached) return cached;
  const file = centroidFile();
  if (!file) return indexZipRows([]);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, [string, string, number, number]>;
  const rows: Array<[string, string, string, number, number]> = [];
  for (const zip of Object.keys(raw)) {
    const row = raw[zip];
    if (!row) continue;
    rows.push([zip, row[0], row[1], row[2], row[3]]);
  }
  cached = indexZipRows(rows);
  return cached;
}
