/**
 * HeyGears Blueprint .ultx slice reader.
 *
 * Real Blueprint plates are WinZip AES-256 ZIP archives (compression method 99)
 * containing `parameters.ini`, `buildscript.ini`, preview PNGs, and per-layer
 * `S######_P*.png` images. Member payloads are encrypted; the central directory
 * filenames stay readable.
 *
 * Recovery strategy:
 * 1. Walk the ZIP central directory for layer filenames + member inventory
 * 2. Decrypt text members (`parameters.ini`, `buildscript.ini`, `.pp`/`.ucfg`)
 *    via WinZip AES using the first working password from:
 *      - explicit `options.password`
 *      - `ULTX_ZIP_PASSWORD`
 *      - `[Slice] password: …` lines in `ULTX_SLICE_LOG` (Blueprint Slice.log)
 *      - built-in Blueprint asset password `heygears008` (used by Studio UI zips;
 *        plate ULTX files usually use a Codex-derived password instead)
 * 3. Harvest print time / resin / exposure / machine keys from plaintext
 * 4. When the archive stays sealed, fill time/resin/layers from Blueprint
 *    Slice.log `Output: {…}` / `material cost` lines (`ULTX_SLICE_LOG` file or
 *    logs directory). Password is not logged in production Slice.log.
 * 5. Fall back to ASCII scans for any unencrypted sidecar-style containers
 * 6. Infer a printer profile from the file name when the archive stays sealed
 *
 * Future (deferred): optional PC → Railway Slice.log sync agent for multi-HeyGears
 * shops. Railway cannot read Windows AppData; a local watcher would POST logs into
 * a server cache and reuse the existing uploaded-`sliceLogText` harvest path.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
const MAX_CD_BYTES = 8 * 1024 * 1024;
const LAYER_NAME_RE = /^S(\d{1,8})_P\d+\.(png|bmp|tif|tiff)$/i;
const TEXT_MEMBER_RE = /\.(json|xml|txt|ini|cfg|conf|meta|info|param|params|pp|ucfg)$/i;
const TEXT_MEMBER_HINT_RE = /meta|param|info|config|print|script|material/i;

export interface UltxZipMember {
  name: string;
  method: number;
  flags: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
  encrypted: boolean;
  aesStrength: number | null;
  innerMethod: number | null;
}

function reasonable(value: number | null, min: number, max: number, digits = 3): number | null {
  if (value === null || !Number.isFinite(value) || value < min || value > max) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Accept "30µm", "44g", "03:27:37", "40.2 ml"
    const hms = trimmed.match(/^(\d{1,3}):([0-5]\d):([0-5]\d)$/);
    if (hms) {
      return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    }
    const parsed = Number(trimmed.replace(/[$,\s]/g, "").replace(/(µm|um|mm|ml|g|sec|s|min|kg)$/i, ""));
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

/** Password Blueprint's Electron UI uses for some encrypted studio asset zips. */
export const BLUEPRINT_ASSET_ZIP_PASSWORD = "heygears008";

/** Pull zip passwords logged by Blueprint while slicing (`[Slice] password: …`). */
export function extractPasswordsFromSliceLog(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[Slice\]\s*password\s*:\s*(.+?)\s*$/gim)) {
    const value = match[1]?.trim();
    if (!value || value === "{}" || value === "null" || value === "undefined") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    found.push(value);
  }
  return found;
}

/** Metrics Blueprint writes to Slice.log after a successful plate slice. */
export interface SliceLogUltxMetrics {
  sliceFileName: string;
  uuid: string | null;
  /** Epoch ms from the Slice.log line prefix when present. */
  loggedAtMs: number | null;
  printTimeSeconds: number | null;
  resinMassG: number | null;
  resinVolumeMl: number | null;
  layerCount: number | null;
}

const SLICE_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Blueprint export names: `P_20260806_232232-Plate01.rs.ultx`. */
const EXPORT_STAMP_RE = /(?:^|[/\\])P_(\d{8})_(\d{6})(?:-|_|\.|$)/i;
const MAX_SLICE_LOG_READ_BYTES = 8 * 1024 * 1024;
/** How close an export stamp must be to a Slice.log Output line. */
const EXPORT_STAMP_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

function basenameLower(fileName: string): string {
  return fileName.replace(/^.*[/\\]/, "").trim().toLowerCase();
}

function extractUuid(text: string): string | null {
  const match = text.match(SLICE_UUID_RE);
  return match ? match[0]!.toLowerCase() : null;
}

function lineLoggedAtMs(line: string): number | null {
  const match = line.match(/^(\d{11,16})\|/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 1_000_000_000_000 ? value : null;
}

/** Local-time epoch ms for Blueprint `P_YYYYMMDD_HHMMSS-…` export filenames. */
export function parseUltxExportStampMs(fileName: string): number | null {
  const match = EXPORT_STAMP_RE.exec(fileName);
  if (!match) return null;
  const date = match[1]!;
  const time = match[2]!;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  if (
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse Blueprint Slice.log for per-plate `Output: {…}` JSON and
 * `material cost` / Techbag volume lines. Production logs include estimates
 * but not the WinZip AES password.
 */
export function extractUltxMetricsFromSliceLog(text: string): SliceLogUltxMetrics[] {
  type Acc = SliceLogUltxMetrics & { order: number };
  const byKey = new Map<string, Acc>();
  let order = 0;

  const upsert = (
    partial: Partial<SliceLogUltxMetrics> & { sliceFileName?: string; uuid?: string | null },
    options?: { prefer?: boolean },
  ) => {
    const uuid = partial.uuid?.toLowerCase() || extractUuid(partial.sliceFileName || "") || null;
    const sliceFileName = partial.sliceFileName?.trim() || (uuid ? `Slice-${uuid}.ultx` : "");
    if (!sliceFileName && !uuid) return;
    const key = uuid || basenameLower(sliceFileName);
    const prev = byKey.get(key);
    const prefer = options?.prefer === true;
    // Output JSON uses prefer=true so printEstimateTime wins over rounded material-cost ms.
    const pick = <T,>(incoming: T | null | undefined, existing: T | null | undefined): T | null => {
      if (prefer) return (incoming ?? existing ?? null) as T | null;
      return (existing ?? incoming ?? null) as T | null;
    };
    const next: Acc = {
      sliceFileName: sliceFileName || prev?.sliceFileName || "",
      uuid: uuid || prev?.uuid || null,
      // Prefer the newest line timestamp (Output is usually last for a plate).
      loggedAtMs: partial.loggedAtMs ?? prev?.loggedAtMs ?? null,
      printTimeSeconds: pick(partial.printTimeSeconds, prev?.printTimeSeconds),
      resinMassG: pick(partial.resinMassG, prev?.resinMassG),
      resinVolumeMl: pick(partial.resinVolumeMl, prev?.resinVolumeMl),
      layerCount: pick(partial.layerCount, prev?.layerCount),
      order: prev?.order ?? order++,
    };
    if (partial.sliceFileName) next.sliceFileName = partial.sliceFileName.trim();
    byKey.set(key, next);
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("[Slice]")) continue;
    const loggedAtMs = lineLoggedAtMs(line);

    const outputMatch = line.match(/\[Slice\]\s*Output:\s*(\{.*\})(?:\||$)/i);
    if (outputMatch?.[1]) {
      try {
        const parsed = JSON.parse(outputMatch[1]) as Record<string, unknown>;
        const sliceFileName = typeof parsed.sliceFileName === "string" ? parsed.sliceFileName : "";
        const uuid = extractUuid(sliceFileName) || extractUuid(String(parsed.previewFilePath ?? ""));
        const printEstimateTime = asNumber(parsed.printEstimateTime);
        const materials = asNumber(parsed.printEstimateMaterials);
        const layers = asNumber(parsed.numberOfSlices);
        // printEstimateTime is seconds (UI clock); ignore sliceTotalTime (slicer wall-clock ms).
        upsert(
          {
            sliceFileName: sliceFileName || undefined,
            uuid,
            loggedAtMs,
            printTimeSeconds: printEstimateTime != null ? Math.round(printEstimateTime) : null,
            resinMassG: materials != null ? reasonable(materials, 0.01, 100_000, 3) : null,
            layerCount: layers != null ? Math.floor(layers) : null,
          },
          { prefer: true },
        );
      } catch {
        /* ignore malformed Output JSON */
      }
      continue;
    }

    const materialMatch = line.match(
      /\[Slice\]\s*material\s+cost:\s*(\d+(?:\.\d+)?)\s*g\s*,\s*print\s+time\s+cost:\s*(\d+(?:\.\d+)?)\s*ms/i,
    );
    if (materialMatch) {
      const mass = asNumber(materialMatch[1]);
      const timeMs = asNumber(materialMatch[2]);
      upsert({
        uuid: extractUuid(line),
        loggedAtMs,
        resinMassG: mass != null ? reasonable(mass, 0.01, 100_000, 3) : null,
        printTimeSeconds: timeMs != null ? Math.round(timeMs / 1000) : null,
      });
      continue;
    }

    const volumeMatch = line.match(/\[Slice\]\s*Techbag\s+file\s+volume:\s*(\d+(?:\.\d+)?)/i);
    if (volumeMatch) {
      const volume = asNumber(volumeMatch[1]);
      upsert({
        uuid: extractUuid(line),
        loggedAtMs,
        resinVolumeMl: volume != null ? reasonable(volume, 0.01, 100_000, 3) : null,
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);
}

/** Prefer exact name, UUID, export timestamp, then a unique layer-count match. */
export function matchSliceLogMetrics(
  entries: SliceLogUltxMetrics[],
  fileName: string,
  layerCount?: number | null,
): SliceLogUltxMetrics | null {
  if (!entries.length) return null;
  const base = basenameLower(fileName);
  const fileUuid = extractUuid(fileName);

  const exact = [...entries].reverse().find((entry) => basenameLower(entry.sliceFileName) === base);
  if (exact) return exact;

  if (fileUuid) {
    const byUuid = [...entries].reverse().find((entry) => entry.uuid === fileUuid);
    if (byUuid) return byUuid;
  }

  const exportMs = parseUltxExportStampMs(fileName);
  if (exportMs != null) {
    const timed = entries
      .filter((entry) => entry.loggedAtMs != null)
      .map((entry) => ({
        entry,
        delta: Math.abs(entry.loggedAtMs! - exportMs),
      }))
      .filter((row) => row.delta <= EXPORT_STAMP_MATCH_WINDOW_MS)
      .sort((a, b) => a.delta - b.delta);

    if (timed.length) {
      if (layerCount != null && layerCount > 0) {
        const layerFit = timed.filter((row) => row.entry.layerCount === layerCount);
        if (layerFit.length) return layerFit[0]!.entry;
      }
      // Unique nearest hit, or clear winner (>2× closer than runner-up).
      if (timed.length === 1) return timed[0]!.entry;
      if (timed[0]!.delta * 2 < timed[1]!.delta) return timed[0]!.entry;
      if (layerCount != null && layerCount > 0) {
        const uniqueLayer = entries.filter((entry) => entry.layerCount === layerCount);
        if (uniqueLayer.length === 1) return uniqueLayer[0]!;
      }
    }
  }

  if (layerCount != null && layerCount > 0) {
    const layerMatches = entries.filter((entry) => entry.layerCount === layerCount);
    if (layerMatches.length === 1) return layerMatches[0]!;
  }

  return null;
}

function readTextFileTail(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, maxBytes);
  if (size <= 0) return "";
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Collect Slice.log text from `ULTX_SLICE_LOG` (file path or logs directory). */
export function readUltxSliceLogText(): string {
  const logPath = process.env.ULTX_SLICE_LOG?.trim();
  if (!logPath) return "";
  try {
    if (!fs.existsSync(logPath)) return "";
    const stat = fs.statSync(logPath);
    if (stat.isFile()) {
      return readTextFileTail(logPath, MAX_SLICE_LOG_READ_BYTES);
    }
    if (!stat.isDirectory()) return "";

    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || files.length >= 40) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && /^slice(?:-.*)?\.log$/i.test(entry.name)) {
          files.push(full);
        }
      }
    };
    walk(logPath, 0);
    // Prefer newest Slice.log files — Output lines for recent plates land there.
    files.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    const chunks: string[] = [];
    let remaining = MAX_SLICE_LOG_READ_BYTES;
    for (const file of files) {
      if (remaining <= 0) break;
      const text = readTextFileTail(file, Math.min(2 * 1024 * 1024, remaining));
      if (!text) continue;
      chunks.push(text);
      remaining -= Buffer.byteLength(text, "utf8");
    }
    return chunks.join("\n");
  } catch {
    return "";
  }
}

/** Prefer an uploaded Slice.log body; otherwise fall back to `ULTX_SLICE_LOG`. */
export function resolveUltxSliceLogText(override?: string | null): string {
  const uploaded = override?.trim();
  if (uploaded) {
    if (Buffer.byteLength(uploaded, "utf8") <= MAX_SLICE_LOG_READ_BYTES) return uploaded;
    // Keep the newest tail — Output lines for recent plates are at the end.
    let start = Math.max(0, uploaded.length - MAX_SLICE_LOG_READ_BYTES);
    while (start < uploaded.length && uploaded[start] !== "\n") start += 1;
    return uploaded.slice(start);
  }
  return readUltxSliceLogText();
}

function readSliceLogPasswords(sliceLogText?: string | null): string[] {
  const text = resolveUltxSliceLogText(sliceLogText);
  return text ? extractPasswordsFromSliceLog(text) : [];
}

function readSliceLogMetricsForFile(
  fileName: string,
  layerCount?: number | null,
  sliceLogText?: string | null,
): SliceLogUltxMetrics | null {
  const text = resolveUltxSliceLogText(sliceLogText);
  if (!text) return null;
  return matchSliceLogMetrics(extractUltxMetricsFromSliceLog(text), fileName, layerCount);
}

function collectZipPasswordCandidates(
  explicit?: string | null,
  sliceLogText?: string | null,
): Array<string | null> {
  const ordered: Array<string | null> = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null) {
      if (!seen.has("__null__")) {
        seen.add("__null__");
        ordered.push(null);
      }
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  if (explicit !== undefined) push(explicit);
  push(process.env.ULTX_ZIP_PASSWORD);
  for (const fromLog of readSliceLogPasswords(sliceLogText)) push(fromLog);
  push(BLUEPRINT_ASSET_ZIP_PASSWORD);
  // Always attempt a sealed/no-password pass last so layer-count recovery still runs.
  push(null);
  return ordered;
}

function readZipPassword(): string | null {
  const fromEnv = process.env.ULTX_ZIP_PASSWORD?.trim();
  return fromEnv ? fromEnv : null;
}

function parseAesExtra(extra: Buffer): { strength: number; innerMethod: number } | null {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extra.length) break;
    if (id === 0x9901 && size >= 7) {
      const vendor = extra.toString("ascii", dataStart + 2, dataStart + 4);
      if (vendor === "AE") {
        return {
          strength: extra[dataStart + 4]!,
          innerMethod: extra.readUInt16LE(dataStart + 5),
        };
      }
    }
    offset = dataEnd;
  }
  return null;
}

/** Locate EOCD and list central-directory members (names readable even when encrypted). */
export function listUltxZipMembers(buffer: Buffer): UltxZipMember[] {
  if (buffer.length < 22) return [];
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 65_535 - 22);
  for (let i = buffer.length - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buffer.length || cdSize > MAX_CD_BYTES) return [];

  const members: UltxZipMember[] = [];
  let offset = cdOffset;
  for (let index = 0; index < totalEntries && offset + 46 <= cdOffset + cdSize; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const extra = buffer.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
    const aes = parseAesExtra(extra);
    members.push({
      name,
      method,
      flags,
      compSize,
      uncompSize,
      localOffset,
      encrypted: Boolean(flags & 0x1) || method === 99,
      aesStrength: aes?.strength ?? null,
      innerMethod: aes?.innerMethod ?? null,
    });
    offset = nameStart + nameLen + extraLen + commentLen;
  }
  return members;
}

export function countUltxLayersFromMembers(members: UltxZipMember[]): number | null {
  const layers = new Set<number>();
  for (const member of members) {
    const base = member.name.split(/[/\\]/).pop() ?? member.name;
    const match = LAYER_NAME_RE.exec(base);
    if (!match) continue;
    layers.add(Number(match[1]));
  }
  return layers.size > 0 ? layers.size : null;
}

function inferPrinterProfileFromFileName(fileName: string): string | null {
  const base = fileName.toLowerCase();
  if (/\.rs\.ultx$/.test(base) || /(?:^|[_\-.])rs(?:[_\-.]|$)/.test(base.replace(/\.ultx$/, ""))) {
    if (/turbo/.test(base)) return "HeyGears Reflex Turbo";
    return "Reflex RS";
  }
  if (/turbo/.test(base)) return "HeyGears Reflex Turbo";
  if (/reflex/.test(base)) return "HeyGears Reflex Turbo";
  return null;
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

function aesKeyBytes(strength: number): number {
  if (strength === 1) return 16;
  if (strength === 2) return 24;
  return 32;
}

function decryptWinZipAes(payload: Buffer, password: string, strength: number): Buffer | null {
  const keyLen = aesKeyBytes(strength);
  const saltLen = keyLen / 2;
  if (payload.length < saltLen + 2 + 10) return null;
  const salt = payload.subarray(0, saltLen);
  const pwv = payload.subarray(saltLen, saltLen + 2);
  const cipher = payload.subarray(saltLen + 2, payload.length - 10);
  const mac = payload.subarray(payload.length - 10);
  const derived = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, 2 * keyLen + 2, "sha1");
  if (!derived.subarray(2 * keyLen).equals(pwv)) return null;
  const encKey = derived.subarray(0, keyLen);
  const macKey = derived.subarray(keyLen, 2 * keyLen);
  const expectedMac = crypto.createHmac("sha1", macKey).update(cipher).digest().subarray(0, 10);
  if (!expectedMac.equals(mac)) return null;

  // WinZip AES-CTR: little-endian 128-bit counter starting at 1.
  const out = Buffer.allocUnsafe(cipher.length);
  let counter = 1n;
  for (let offset = 0; offset < cipher.length; offset += 16) {
    const counterBlock = Buffer.alloc(16);
    counterBlock.writeBigUInt64LE(counter, 0);
    const cipherIv = crypto.createCipheriv(`aes-${keyLen * 8}-ecb`, encKey, Buffer.alloc(0));
    cipherIv.setAutoPadding(false);
    const keystream = Buffer.concat([cipherIv.update(counterBlock), cipherIv.final()]);
    const block = cipher.subarray(offset, Math.min(offset + 16, cipher.length));
    for (let i = 0; i < block.length; i += 1) {
      out[offset + i] = block[i]! ^ keystream[i]!;
    }
    counter += 1n;
  }
  return out;
}

function readLocalPayload(buffer: Buffer, member: UltxZipMember): Buffer | null {
  const off = member.localOffset;
  if (off + 30 > buffer.length) return null;
  if (buffer.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + member.compSize > buffer.length) return null;
  if (member.compSize > MAX_ZIP_MEMBER_BYTES) return null;
  return buffer.subarray(dataStart, dataStart + member.compSize);
}

function isTexty(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 200)).toString("utf8");
  if (sample.trimStart().startsWith("{") || sample.trimStart().startsWith("<") || sample.trimStart().startsWith("[")) {
    return true;
  }
  if (/[\x00-\x08\x0e-\x1f]/.test(sample)) return false;
  return true;
}

function extractMemberText(buffer: Buffer, member: UltxZipMember, password: string | null): string | null {
  const base = member.name.split(/[/\\]/).pop() ?? member.name;
  if (!TEXT_MEMBER_RE.test(base) && !TEXT_MEMBER_HINT_RE.test(base)) return null;
  if (member.uncompSize > MAX_ZIP_MEMBER_BYTES) return null;
  const payload = readLocalPayload(buffer, member);
  if (!payload) return null;

  let inflated: Buffer | null = null;
  if (member.method === 99 || (member.encrypted && member.aesStrength != null)) {
    if (!password || member.aesStrength == null) return null;
    const plainCompressed = decryptWinZipAes(payload, password, member.aesStrength);
    if (!plainCompressed) return null;
    const inner = member.innerMethod ?? 8;
    inflated = inflateZipMember(plainCompressed, inner);
  } else if (!member.encrypted) {
    inflated = inflateZipMember(payload, member.method);
  }
  if (!inflated || !isTexty(inflated)) return null;
  return inflated.toString("utf8");
}

/** Minimal local-file ZIP walker — enough for small Blueprint metadata members. */
export function extractZipTextMembers(buffer: Buffer, password: string | null = readZipPassword()): string[] {
  const fromCd = listUltxZipMembers(buffer);
  if (fromCd.length) {
    const texts: string[] = [];
    for (const member of fromCd) {
      const text = extractMemberText(buffer, member, password);
      if (text) texts.push(text);
    }
    if (texts.length) return texts;
  }

  // Legacy local-header walk for truncated / header-only fixtures used in tests.
  const texts: string[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const flags = buffer.readUInt16LE(offset + 6);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > buffer.length) break;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataStart + compSize);
    const extra = buffer.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
    offset = dataStart + compSize;
    if (!TEXT_MEMBER_RE.test(name) && !TEXT_MEMBER_HINT_RE.test(name)) continue;
    if (compSize > MAX_ZIP_MEMBER_BYTES) continue;

    let inflated: Buffer | null = null;
    if (method === 99 || flags & 0x1) {
      const aes = parseAesExtra(extra);
      if (!password || !aes) continue;
      const plain = decryptWinZipAes(compressed, password, aes.strength);
      if (!plain) continue;
      inflated = inflateZipMember(plain, aes.innerMethod);
    } else {
      inflated = inflateZipMember(compressed, method);
    }
    if (!inflated || !isTexty(inflated)) continue;
    texts.push(inflated.toString("utf8"));
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

  // Also harvest simple key=value / key: value lines (ini + Blueprint dumps / Slice.log).
  // Allow spaces in keys so "Time Cost: 03:27:37" and "Techbag file volume: 161.7" match.
  for (const line of text.split(/\r?\n/).slice(0, 4_000)) {
    const match = line.match(/^\s*([A-Za-z0-9_./][A-Za-z0-9_./ -]{1,79})\s*[:=]\s*(.+?)\s*$/);
    if (!match) continue;
    entries.push({ key: match[1]!.trim(), value: match[2]! });
  }

  // Free-form Blueprint log phrases that are not strict key/value pairs.
  if (/\bUse\s+open\s+material\b/i.test(text)) {
    entries.push({ key: "useOpenMaterial", value: 1 });
  }
  const massPhrase = text.match(/\b(?:material\s*weight|resin(?:\s*consumption)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g\b/i);
  if (massPhrase) entries.push({ key: "materialWeight", value: massPhrase[1]! });
  const timePhrase = text.match(/\b(?:time\s*cost|print\s*time)\s*[:=]?\s*(\d{1,3}:[0-5]\d:[0-5]\d)\b/i);
  if (timePhrase) entries.push({ key: "TimeCost", value: timePhrase[1]! });

  // Avoid matching Blueprint slicer timings (sliceTotalTime / compressTime / calcMValueTime).
  let printTimeSeconds = pickNumber(
    entries,
    [
      /^printtime/,
      /printtimecost/,
      /printestimatetime/,
      /^timecost$/,
      /estimatedprinttime/,
      /^estimatedtime$/,
      /durationsec/,
      /^time$/,
    ],
    1,
    7 * 24 * 3600,
  );
  const printTimeMinutes = pickNumber(entries, [/printtimemin/, /estimatedtimemin/], 0.1, 7 * 24 * 60);
  if (printTimeSeconds == null && printTimeMinutes != null) {
    printTimeSeconds = Math.round(printTimeMinutes * 60);
  }

  const layerCount = pickNumber(
    entries,
    [/layercount/, /layers$/, /totallayers/, /numlayers/, /slicecount/, /numberofslices/],
    1,
    2_000_000,
  );

  // Blueprint UI "resinConsumption" is typically volume; materialWeight is grams.
  // Slice.log also emits "Techbag file volume: <ml>".
  let resinVolumeMl = pickNumber(
    entries,
    [/resinconsumption/, /resinvolume/, /volume_?ml/, /resinml/, /techbag.*volume/, /filevolume/, /^volume$/],
    0.01,
    100_000,
  );
  let resinMassG = pickNumber(
    entries,
    [/materialweight/, /printestimatematerials/, /resinmass/, /weightg/, /resing/, /^weight$/],
    0.01,
    100_000,
  );

  // If only one mass/volume-like value exists under a generic resin key, prefer mass when unit hints say g.
  const resinGeneric = pickNumber(entries, [/^resin$/, /resinuse/, /resinamount/], 0.01, 100_000);
  if (resinMassG == null && resinGeneric != null && /g\b|gram/i.test(text)) {
    resinMassG = resinGeneric;
  } else if (resinVolumeMl == null && resinGeneric != null) {
    resinVolumeMl = resinGeneric;
  }

  // "material cost: 43.5 g" is mass, not currency — only accept currency-like keys here.
  const resinCost = pickNumber(entries, [/resincost/, /materialpricecost/, /^cost$/], 0.01, 100_000);

  let layerHeightMm = pickNumber(entries, [/layerheight/, /layerthickness/, /layerheightmm/], 0.001, 1);
  // Blueprint `layerPrecision` is often microns (e.g. 30 → 0.03 mm).
  if (layerHeightMm == null) {
    const precisionUm = pickNumber(entries, [/layerprecision/, /layerprecisionen/], 1, 500);
    if (precisionUm != null) layerHeightMm = reasonable(precisionUm / 1000, 0.001, 1, 3);
  }

  const exposureSeconds = pickNumber(
    entries,
    [/exposuretime/, /normalexposure/, /normallayerexposure/, /layerexposure/],
    0.05,
    120,
  );
  // openMaterialConfig exposures are often stored in milliseconds.
  const exposureMs = pickNumber(entries, [/normallayerexposure/], 50, 120_000);
  let normalizedExposure = exposureSeconds;
  if (normalizedExposure == null && exposureMs != null && exposureMs > 120) {
    normalizedExposure = reasonable(exposureMs / 1000, 0.05, 120, 3);
  }

  const bottomExposureSeconds = pickNumber(
    entries,
    [/bottomexposure/, /firstlayerexposure/, /secondlayerexposure/],
    0.05,
    300,
  );
  const bottomExposureMs = pickNumber(entries, [/firstlayerexposure/, /bottomlayerexposure/], 50, 300_000);
  let normalizedBottom = bottomExposureSeconds;
  if (normalizedBottom == null && bottomExposureMs != null && bottomExposureMs > 300) {
    normalizedBottom = reasonable(bottomExposureMs / 1000, 0.05, 300, 3);
  } else if (normalizedBottom != null && normalizedBottom > 120 && normalizedBottom <= 300_000) {
    // Likely milliseconds stored without unit key.
    normalizedBottom = reasonable(normalizedBottom / 1000, 0.05, 300, 3);
  }

  const bottomLayerCount = pickNumber(entries, [/bottomlayers/, /bottomlayercount/], 1, 1000);
  const resolutionX = pickNumber(entries, [/resolutionx/, /resx/, /pixelx/], 0.001, 30_000);
  const resolutionY = pickNumber(entries, [/resolutiony/, /resy/, /pixely/], 0.001, 30_000);
  // HeyGears sometimes stores resolution as mm/pixel (0.0297) instead of pixel count.
  const resX = resolutionX != null && resolutionX < 2 ? null : resolutionX != null ? Math.floor(resolutionX) : null;
  const resY = resolutionY != null && resolutionY < 2 ? null : resolutionY != null ? Math.floor(resolutionY) : null;

  const buildVolumeXmm = pickNumber(entries, [/buildvolumex/, /platformsizex/, /formatx/], 1, 2000);
  const buildVolumeYmm = pickNumber(entries, [/buildvolumey/, /platformsizey/, /formaty/], 1, 2000);
  const buildVolumeZmm = pickNumber(entries, [/buildvolumez/, /platformsizez/, /formatz/], 1, 2000);

  const machine =
    pickString(entries, [/machinename/, /printername/, /printermodel/, /devicename/, /printerprofile/]) || null;

  const openMaterial = pickString(entries, [/openmaterial/, /openmaterialconfig/]);
  const openMaterialFlag = pickNumber(entries, [/^openmaterial$/, /useopenmaterial/], 0, 1);

  return {
    printTimeSeconds: printTimeSeconds != null ? Math.round(printTimeSeconds) : null,
    layerCount: layerCount != null ? Math.floor(layerCount) : null,
    resinVolumeMl,
    resinMassG,
    resinCost,
    resinCostSource: resinCost != null ? "ultx" : null,
    resinCostLabel:
      resinCost != null
        ? "Recovered from ULTX metadata"
        : openMaterial || openMaterialFlag === 1
          ? "Open Material"
          : null,
    layerHeightMm,
    exposureSeconds: normalizedExposure,
    bottomExposureSeconds: normalizedBottom,
    bottomLayerCount: bottomLayerCount != null ? Math.floor(bottomLayerCount) : null,
    resolutionX: resX,
    resolutionY: resY,
    buildVolumeXmm,
    buildVolumeYmm,
    buildVolumeZmm,
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

export interface ParseUltxOptions {
  password?: string | null;
  /** Blueprint Slice.log text uploaded with the plate (preferred over env path). */
  sliceLogText?: string | null;
}

export function parseUltxFile(
  fileName: string,
  buffer: Buffer,
  options?: ParseUltxOptions,
): PrintFileMetrics {
  if (!buffer.length) {
    throw new UltxParseError("The ULTX file is empty");
  }

  const sliceLogText = options?.sliceLogText;
  const passwordCandidates = collectZipPasswordCandidates(
    options && "password" in options ? options.password : undefined,
    sliceLogText,
  );
  let metrics = emptyMetrics(fileName, buffer, "HeyGears ULTX (best-effort)");
  const texts: string[] = [];
  let members: UltxZipMember[] = [];
  let usedPassword: string | null = null;

  if (looksLikeZip(buffer)) {
    members = listUltxZipMembers(buffer);
    const layerCount = countUltxLayersFromMembers(members);
    const encryptedCount = members.filter((member) => member.encrypted || member.method === 99).length;

    let decrypted: string[] = [];
    for (const candidate of passwordCandidates) {
      decrypted = extractZipTextMembers(buffer, candidate);
      if (decrypted.length) {
        usedPassword = candidate;
        break;
      }
    }
    texts.push(...decrypted);

    if (layerCount != null) {
      metrics.layerCount = layerCount;
    }

    if (members.length) {
      if (encryptedCount === members.length && !decrypted.length) {
        metrics.formatRevision = `HeyGears ULTX AES-encrypted zip · ${members.length} members · ${layerCount ?? 0} layers (metadata sealed)`;
      } else if (encryptedCount && decrypted.length) {
        const via = usedPassword === BLUEPRINT_ASSET_ZIP_PASSWORD ? "via heygears008" : "decrypted";
        metrics.formatRevision = `HeyGears ULTX AES zip · ${via} ${decrypted.length} metadata member${decrypted.length === 1 ? "" : "s"} · ${layerCount ?? "?"} layers`;
      } else if (decrypted.length) {
        metrics.formatRevision = `HeyGears ULTX zip · ${decrypted.length} metadata member${decrypted.length === 1 ? "" : "s"}`;
      } else {
        metrics.formatRevision = "HeyGears ULTX zip container";
      }
    } else {
      // Truncated local-header-only fixtures.
      for (const candidate of passwordCandidates) {
        const legacy = extractZipTextMembers(buffer, candidate);
        if (legacy.length) {
          texts.push(...legacy);
          usedPassword = candidate;
          break;
        }
      }
      metrics = {
        ...metrics,
        formatRevision: texts.length
          ? `HeyGears ULTX zip · ${texts.length} metadata member${texts.length === 1 ? "" : "s"}`
          : "HeyGears ULTX zip container",
      };
    }
  }

  texts.push(scanBinaryAscii(buffer));
  for (const text of texts) {
    metrics = mergeMetrics(metrics, harvestFromText(text));
  }

  // PNG inventory is the ground truth for how many layers the plate will print.
  const cdLayers = countUltxLayersFromMembers(members);
  if (cdLayers != null) {
    metrics.layerCount = cdLayers;
  }

  // Sealed AES plates: pull print estimates from Blueprint Slice.log when available.
  const sealedMissingEstimates =
    metrics.printTimeSeconds == null || metrics.resinMassG == null || metrics.resinVolumeMl == null;
  const sealed = /metadata sealed|AES-encrypted/i.test(metrics.formatRevision || "");
  if (sealedMissingEstimates) {
    const sliceLogConfigured = Boolean(
      sliceLogText?.trim() || process.env.ULTX_SLICE_LOG?.trim(),
    );
    const fromLog = readSliceLogMetricsForFile(fileName, metrics.layerCount, sliceLogText);
    if (fromLog) {
      const beforeTime = metrics.printTimeSeconds;
      const beforeMass = metrics.resinMassG;
      const beforeVolume = metrics.resinVolumeMl;
      metrics = mergeMetrics(metrics, {
        printTimeSeconds: fromLog.printTimeSeconds,
        resinMassG: fromLog.resinMassG,
        resinVolumeMl: fromLog.resinVolumeMl,
        layerCount: metrics.layerCount ?? fromLog.layerCount,
      });
      const filled =
        (beforeTime == null && metrics.printTimeSeconds != null) ||
        (beforeMass == null && metrics.resinMassG != null) ||
        (beforeVolume == null && metrics.resinVolumeMl != null);
      if (filled) {
        metrics.formatRevision = sealed
          ? `${metrics.formatRevision} · estimates from Slice.log`
          : `HeyGears ULTX · estimates from Slice.log · ${metrics.layerCount ?? "?"} layers`;
      } else if (sealed && sliceLogConfigured) {
        metrics.formatRevision = `${metrics.formatRevision} · Slice.log provided but no matching Output line`;
      }
    } else if (sealed && !sliceLogConfigured) {
      metrics.formatRevision = `${metrics.formatRevision} · drop Slice.log with the plate for time/resin`;
    } else if (sealed && sliceLogConfigured) {
      metrics.formatRevision = `${metrics.formatRevision} · Slice.log provided but no matching Output line`;
    }
  }

  if (metrics.layerCount != null && metrics.layerHeightMm != null && metrics.modelHeightMm == null) {
    metrics.modelHeightMm = reasonable(metrics.layerCount * metrics.layerHeightMm, 0.01, 1000, 3);
  }

  const inferred = inferPrinterProfileFromFileName(fileName);
  if (!metrics.printerProfile?.trim() || metrics.printerProfile === DEFAULT_HEYGEARS_PROFILE) {
    if (inferred) metrics.printerProfile = inferred;
  }
  if (!metrics.printerProfile?.trim()) {
    metrics.printerProfile = DEFAULT_HEYGEARS_PROFILE;
  }

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

export function parseUltxFileFromPath(
  fileName: string,
  filePath: string,
  options?: ParseUltxOptions,
): PrintFileMetrics {
  const buffer = fs.readFileSync(filePath);
  return parseUltxFile(fileName, buffer, options);
}
