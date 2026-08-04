/**
 * Best-effort HeyGears Blueprint .ultx slice reader.
 *
 * ULTX is a proprietary HeyGears format (not covered by UVtools). This parser:
 * 1. Treats ZIP containers as archives and reads text/JSON/XML members
 * 2. Scans binary/text for common metric keys (print time, layers, resin, machine)
 * 3. Always returns a metrics envelope so plates can still attach to fleet tracking
 *
 * When a field cannot be recovered, it stays null — owners still get a durable
 * job record under the HeyGears Reflex Turbo (or any machine name found in-file).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import type { PrintFileMetrics } from "../../shared/schema";

export class UltxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UltxParseError";
  }
}

const DEFAULT_HEYGEARS_PROFILE = "HeyGears Reflex Turbo";
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_MEMBER_BYTES = 2 * 1024 * 1024;

function reasonable(value: number | null, min: number, max: number, digits = 3): number | null {
  if (value === null || !Number.isFinite(value) || value < min || value > max) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sha256Prefix(buffer: Buffer): string {
  const hash = crypto.createHash("sha256");
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(buffer.length));
  hash.update(sizeBuf);
  hash.update(buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)));
  return hash.digest("hex");
}

function emptyMetrics(fileName: string, buffer: Buffer, revision: string): PrintFileMetrics {
  return {
    fileName,
    fileSizeBytes: buffer.length,
    sha256: sha256Prefix(buffer),
    format: "ULTX",
    formatRevision: revision,
    printTimeSeconds: null,
    resinVolumeMl: null,
    resinMassG: null,
    resinCost: null,
    resinCostSource: null,
    resinCostLabel: null,
    resinDensityGPerMl: null,
    layerCount: null,
    layerHeightMm: null,
    modelHeightMm: null,
    exposureSeconds: null,
    bottomExposureSeconds: null,
    lightOffSeconds: null,
    bottomLightOffSeconds: null,
    bottomLayerCount: null,
    liftDistanceMm: null,
    liftSpeedMmPerMin: null,
    bottomLiftDistanceMm: null,
    bottomLiftSpeedMmPerMin: null,
    retractSpeedMmPerMin: null,
    resolutionX: null,
    resolutionY: null,
    buildVolumeXmm: null,
    buildVolumeYmm: null,
    buildVolumeZmm: null,
    printerProfile: DEFAULT_HEYGEARS_PROFILE,
  };
}

function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function inflateZipMember(compressed: Buffer, method: number): Buffer | null {
  try {
    if (method === 0) return compressed;
    if (method === 8) return zlib.inflateRawSync(compressed);
  } catch {
    return null;
  }
  return null;
}

/** Minimal local-file ZIP walker — enough for small Blueprint metadata members. */
export function extractZipTextMembers(buffer: Buffer): string[] {
  const texts: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > buffer.length) break;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataStart + compSize);
    offset = dataStart + compSize;
    if (!/\.(json|xml|txt|ini|cfg|conf|meta|info|param|params)$/i.test(name) && !/meta|param|info|config|print/i.test(name)) {
      continue;
    }
    if (compSize > MAX_ZIP_MEMBER_BYTES) continue;
    const inflated = inflateZipMember(compressed, method);
    if (!inflated) continue;
    const text = inflated.toString("utf8");
    if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200)) && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("<")) {
      continue;
    }
    texts.push(text);
  }
  return texts;
}

function collectJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") objects.push(item as Record<string, unknown>);
        }
      } else if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* continue with regex harvest */
    }
  }

  const re = /\{[^{}]{8,4000}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* ignore */
    }
  }
  return objects;
}

function flattenKeys(
  value: unknown,
  prefix = "",
  out: Array<{ key: string; value: unknown }> = [],
): Array<{ key: string; value: unknown }> {
  if (value === null || value === undefined) return out;
  if (typeof value !== "object") {
    out.push({ key: prefix, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.slice(0, 40).forEach((item, index) => flattenKeys(item, `${prefix}[${index}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    flattenKeys(child, next, out);
  }
  return out;
}

function keyMatches(key: string, patterns: RegExp[]): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return patterns.some((pattern) => pattern.test(normalized));
}

function pickNumber(
  entries: Array<{ key: string; value: unknown }>,
  patterns: RegExp[],
  min: number,
  max: number,
): number | null {
  for (const entry of entries) {
    if (!keyMatches(entry.key, patterns)) continue;
    const value = asNumber(entry.value);
    const bounded = reasonable(value, min, max, 3);
    if (bounded != null) return bounded;
  }
  return null;
}

function pickString(
  entries: Array<{ key: string; value: unknown }>,
  patterns: RegExp[],
): string | null {
  for (const entry of entries) {
    if (!keyMatches(entry.key, patterns)) continue;
    const value = String(entry.value ?? "").trim();
    if (value.length >= 2 && value.length <= 200) return value;
  }
  return null;
}

function harvestFromText(text: string): Partial<PrintFileMetrics> {
  const objects = collectJsonObjects(text);
  const entries = objects.flatMap((object) => flattenKeys(object));

  // Also harvest simple key=value / key: value lines.
  for (const line of text.split(/\r?\n/).slice(0, 2_000)) {
    const match = line.match(/^\s*([A-Za-z0-9_./-]{2,80})\s*[:=]\s*(.+?)\s*$/);
    if (!match) continue;
    entries.push({ key: match[1]!, value: match[2]! });
  }

  let printTimeSeconds = pickNumber(entries, [/printtime/, /estimatedtime/, /totaltime/, /durationsec/], 1, 7 * 24 * 3600);
  const printTimeMinutes = pickNumber(entries, [/printtimemin/, /estimatedtimemin/], 0.1, 7 * 24 * 60);
  if (printTimeSeconds == null && printTimeMinutes != null) {
    printTimeSeconds = Math.round(printTimeMinutes * 60);
  }

  const layerCount = pickNumber(entries, [/layercount/, /layers$/, /totallayers/, /numlayers/], 1, 2_000_000);
  const resinVolumeMl = pickNumber(entries, [/resinvolume/, /volume_?ml/, /resinml/, /^volume$/], 0.01, 100_000);
  const resinMassG = pickNumber(entries, [/resinmass/, /weightg/, /resing/, /^weight$/], 0.01, 100_000);
  const resinCost = pickNumber(entries, [/resincost/, /materialcost/, /^cost$/], 0.01, 100_000);
  const layerHeightMm = pickNumber(entries, [/layerheight/, /layerthickness/], 0.001, 1);
  const exposureSeconds = pickNumber(entries, [/exposuretime/, /normalexposure/, /layerexposure/], 0.05, 120);
  const bottomExposureSeconds = pickNumber(entries, [/bottomexposure/, /bottoms?/], 0.05, 300);
  const bottomLayerCount = pickNumber(entries, [/bottomlayers/, /bottomlayercount/], 1, 1000);
  const resolutionX = pickNumber(entries, [/resolutionx/, /resx/, /pixelx/], 100, 30_000);
  const resolutionY = pickNumber(entries, [/resolutiony/, /resy/, /pixely/], 100, 30_000);
  const machine =
    pickString(entries, [/machinename/, /printername/, /printermodel/, /devicename/, /printerprofile/]) ||
    null;

  return {
    printTimeSeconds: printTimeSeconds != null ? Math.round(printTimeSeconds) : null,
    layerCount: layerCount != null ? Math.floor(layerCount) : null,
    resinVolumeMl,
    resinMassG,
    resinCost,
    resinCostSource: resinCost != null ? "ultx" : null,
    resinCostLabel: resinCost != null ? "Recovered from ULTX metadata" : null,
    layerHeightMm,
    exposureSeconds,
    bottomExposureSeconds,
    bottomLayerCount: bottomLayerCount != null ? Math.floor(bottomLayerCount) : null,
    resolutionX: resolutionX != null ? Math.floor(resolutionX) : null,
    resolutionY: resolutionY != null ? Math.floor(resolutionY) : null,
    printerProfile: machine,
  };
}

function scanBinaryAscii(buffer: Buffer): string {
  const slice = buffer.subarray(0, Math.min(buffer.length, MAX_SCAN_BYTES));
  const chunks: string[] = [];
  let current = "";
  for (let i = 0; i < slice.length; i += 1) {
    const code = slice[i]!;
    if (code >= 0x20 && code <= 0x7e) {
      current += String.fromCharCode(code);
      continue;
    }
    if (current.length >= 8) chunks.push(current);
    current = "";
  }
  if (current.length >= 8) chunks.push(current);
  return chunks.join("\n");
}

function mergeMetrics(base: PrintFileMetrics, patch: Partial<PrintFileMetrics>): PrintFileMetrics {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== null && value !== undefined && value !== ""),
    ),
  } as PrintFileMetrics;
}

export function parseUltxFile(fileName: string, buffer: Buffer): PrintFileMetrics {
  if (!buffer.length) {
    throw new UltxParseError("The ULTX file is empty");
  }

  let metrics = emptyMetrics(fileName, buffer, "HeyGears ULTX (best-effort)");
  const texts: string[] = [];

  if (looksLikeZip(buffer)) {
    texts.push(...extractZipTextMembers(buffer));
    metrics = {
      ...metrics,
      formatRevision: texts.length
        ? `HeyGears ULTX zip · ${texts.length} metadata member${texts.length === 1 ? "" : "s"}`
        : "HeyGears ULTX zip container",
    };
  }

  texts.push(scanBinaryAscii(buffer));
  for (const text of texts) {
    metrics = mergeMetrics(metrics, harvestFromText(text));
  }

  if (!metrics.printerProfile?.trim()) {
    metrics.printerProfile = DEFAULT_HEYGEARS_PROFILE;
  }

  // Density when both mass and volume are known.
  if (
    metrics.resinMassG != null &&
    metrics.resinVolumeMl != null &&
    metrics.resinVolumeMl > 0 &&
    metrics.resinDensityGPerMl == null
  ) {
    metrics.resinDensityGPerMl = reasonable(metrics.resinMassG / metrics.resinVolumeMl, 0.2, 3, 3);
  }

  return metrics;
}

export function parseUltxFileFromPath(fileName: string, filePath: string): PrintFileMetrics {
  const buffer = fs.readFileSync(filePath);
  return parseUltxFile(fileName, buffer);
}
