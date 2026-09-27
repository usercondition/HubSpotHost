/**
 * Read production-planning metadata from a Chitubox CTB slice file.
 *
 * Supports:
 * - Classic unencrypted CTB/CBDDLP headers (catibo layout)
 * - Encrypted CTB v4/v5 used by modern printers (e.g. Elegoo Mighty/Mega 8K),
 *   where the slicer settings block is AES-CBC encrypted
 *
 * Only header/settings byte ranges are inspected. Layer images are never
 * decoded. Large Mega 8K uploads can stay on disk and be sampled by offset
 * instead of loading the whole plate into RAM.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { PrintFileMetrics } from "../../shared/schema";
import { SLICE_FINGERPRINT_CHUNK, fingerprintPayload } from "../../shared/slice-fingerprint";

const CTB_MAGIC_PREFIX = 0x12fd;
export const CTB_ENCRYPTED_MAGIC = 0x12fd0107;
const HEADER_MIN_BYTES = 0x50;
const CLASSIC_HEADER_READ = 0x80;
const EXT_CONFIG_OFFSET = 0x54;
const EXT_CONFIG_SIZE_OFFSET = 0x58;
const EXT_CONFIG_2_OFFSET = 0x6c;
const EXT_CONFIG_2_SIZE_OFFSET = 0x70;
const MAX_MACHINE_TYPE_BYTES = 200;
const MAX_EXT_CONFIG_BYTES = 4_096;
const ENCRYPTED_HEADER_SIZE = 48;
const ENCRYPTED_SETTINGS_MIN = 168;
const HASH_CHUNK_BYTES = SLICE_FINGERPRINT_CHUNK;

/**
 * Fingerprint a plate from its size, the first 1 MiB, the last 1 MiB, and the
 * CTB header layer count and print time. Pass the full buffer as `head` when
 * the whole file is already in memory; otherwise pass the tail separately.
 */
export function sliceFingerprint(size: number, head: Buffer, tail?: Buffer): string {
  const tailBytes =
    tail ??
    (head.length >= size
      ? head.subarray(Math.max(0, size - Math.min(size, HASH_CHUNK_BYTES)), size)
      : Buffer.alloc(0));
  return crypto.createHash("sha256").update(fingerprintPayload(size, head, tailBytes)).digest("hex");
}

/**
 * Publicly documented CTB encrypted-settings AES material (community RE /
 * UVtools-compatible). Key and IV are derived by XOR of the published
 * base64 secrets with the fixed software token.
 */
const CTB_AES_SOFTWARE_TOKEN = "UVtools";
const CTB_AES_KEY_SECRET = "hQ36XB6yTk+zO02ysyiowt8yC1buK+nbLWyfY40EXoU=";
const CTB_AES_IV_SECRET = "Wld+ampndVJecmVjYH5cWQ==";

function xorWithToken(data: Buffer, token: string): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i]! ^ token.charCodeAt(i % token.length);
  }
  return out;
}

const CTB_AES_KEY = xorWithToken(Buffer.from(CTB_AES_KEY_SECRET, "base64"), CTB_AES_SOFTWARE_TOKEN);
const CTB_AES_IV = xorWithToken(Buffer.from(CTB_AES_IV_SECRET, "base64"), CTB_AES_SOFTWARE_TOKEN);

/** Random-access CTB reader: only requested ranges are loaded. */
export interface CtbReader {
  readonly size: number;
  read(offset: number, length: number): Buffer | null;
  sha256(): string;
  close(): void;
}

export function createBufferCtbReader(buffer: Buffer): CtbReader {
  return {
    size: buffer.length,
    read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) return null;
      if (offset + length > buffer.length) return null;
      return buffer.subarray(offset, offset + length);
    },
    sha256() {
      return sliceFingerprint(buffer.length, buffer);
    },
    close() {
      /* in-memory reader */
    },
  };
}

export function createFileCtbReader(filePath: string): CtbReader {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(fd);
  };

  return {
    size: stat.size,
    read(offset, length) {
      if (closed) return null;
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) return null;
      if (offset + length > stat.size) return null;
      const out = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, out, read, length - read, offset + read);
        if (n <= 0) return null;
        read += n;
      }
      return out;
    },
    sha256() {
      if (closed) return sliceFingerprint(0, Buffer.alloc(0), Buffer.alloc(0));
      const headLen = Math.min(stat.size, HASH_CHUNK_BYTES);
      const head = Buffer.alloc(headLen);
      let read = 0;
      while (read < headLen) {
        const n = fs.readSync(fd, head, read, headLen - read, read);
        if (n <= 0) break;
        read += n;
      }
      const tailLen = Math.min(stat.size, HASH_CHUNK_BYTES);
      const tail = Buffer.alloc(tailLen);
      let tailRead = 0;
      const tailStart = Math.max(0, stat.size - tailLen);
      while (tailRead < tailLen) {
        const n = fs.readSync(fd, tail, tailRead, tailLen - tailRead, tailStart + tailRead);
        if (n <= 0) break;
        tailRead += n;
      }
      return sliceFingerprint(stat.size, head.subarray(0, read), tail.subarray(0, tailRead));
    },
    close,
  };
}

/**
 * Analyze a CTB using only an uploaded prefix of the real plate file.
 * `fullFileSize` is the on-disk plate size from the owner's machine; the
 * fingerprint matches `createFileCtbReader` (size, first 1 MiB, last 1 MiB, header tags).
 * Bytes past the prefix are missing, not an error: layers, time, and resin still
 * parse when the settings block is inside the prefix. A printer name or thumbnail
 * past that prefix stays blank.
 */
export function createPrefixCtbReader(prefix: Buffer, fullFileSize: number, tail?: Buffer): CtbReader {
  if (!Number.isFinite(fullFileSize) || fullFileSize < prefix.length || fullFileSize < HEADER_MIN_BYTES) {
    throw new CtbParseError("That CTB prefix does not match the reported plate size");
  }

  return {
    size: fullFileSize,
    read(offset, length) {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) return null;
      if (offset + length > fullFileSize) return null;
      if (offset + length > prefix.length) return null;
      return prefix.subarray(offset, offset + length);
    },
    sha256() {
      const head = prefix.subarray(0, Math.min(fullFileSize, HASH_CHUNK_BYTES, prefix.length));
      const derivedTail =
        tail && tail.length > 0
          ? tail
          : prefix.length >= fullFileSize
            ? prefix.subarray(Math.max(0, fullFileSize - Math.min(fullFileSize, HASH_CHUNK_BYTES)), fullFileSize)
            : Buffer.alloc(0);
      return sliceFingerprint(fullFileSize, head, derivedTail);
    },
    close() {
      /* prefix buffer */
    },
  };
}

function u32At(reader: CtbReader, offset: number): number | null {
  const bytes = reader.read(offset, 4);
  return bytes ? bytes.readUInt32LE(0) : null;
}

function f32At(reader: CtbReader, offset: number): number | null {
  const bytes = reader.read(offset, 4);
  if (!bytes) return null;
  const value = bytes.readFloatLE(0);
  return Number.isFinite(value) ? value : null;
}

function u32(buffer: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function f32(buffer: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  const value = buffer.readFloatLE(offset);
  return Number.isFinite(value) ? value : null;
}

function reasonable(value: number | null, min: number, max: number, digits = 3): number | null {
  if (value === null || value < min || value > max) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function reasonableUInt(value: number | null, min: number, max: number): number | null {
  if (value === null || value < min || value > max) return null;
  return Math.floor(value);
}

function extFloat(
  buffer: Buffer,
  extOffset: number | null,
  extSize: number | null,
  fieldOffset: number,
  min: number,
  max: number,
  digits = 3,
): number | null {
  if (extOffset === null) return null;
  if (extSize !== null && extSize > 0 && fieldOffset + 4 > extSize) return null;
  return reasonable(f32(buffer, fieldOffset), min, max, digits);
}

function extUInt(
  buffer: Buffer,
  extOffset: number | null,
  extSize: number | null,
  fieldOffset: number,
  min: number,
  max: number,
): number | null {
  if (extOffset === null) return null;
  if (extSize !== null && extSize > 0 && fieldOffset + 4 > extSize) return null;
  return reasonableUInt(u32(buffer, fieldOffset), min, max);
}

function safeAscii(buffer: Buffer | null): string | null {
  if (!buffer || buffer.length < 1 || buffer.length > MAX_MACHINE_TYPE_BYTES) return null;
  const value = buffer
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return value || null;
}

function densityFromMassVolume(
  resinMassG: number | null,
  resinVolumeMl: number | null,
): number | null {
  if (resinMassG === null || resinVolumeMl === null || resinVolumeMl <= 0) return null;
  return reasonable(resinMassG / resinVolumeMl, 0.2, 3, 3);
}

function costOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function printTimeOrNull(value: number | null): number | null {
  return value !== null && value > 0 && value <= 7 * 24 * 60 * 60 ? value : null;
}

function layerCountOrNull(value: number | null): number | null {
  return value !== null && value > 0 && value <= 2_000_000 ? value : null;
}

function baseMetrics(fileName: string, reader: CtbReader): Pick<
  PrintFileMetrics,
  "fileName" | "fileSizeBytes" | "sha256" | "format"
> {
  return {
    fileName: fileName.slice(0, 260),
    fileSizeBytes: reader.size,
    sha256: reader.sha256(),
    format: "CTB",
  };
}

/** Decrypt the encrypted CTB slicer-settings block (AES-256-CBC, no padding). */
export function decryptCtbSettingsBlock(encrypted: Buffer): Buffer {
  if (encrypted.length === 0) {
    throw new CtbParseError("Encrypted CTB settings block is empty");
  }
  const padded =
    encrypted.length % 16 === 0
      ? encrypted
      : Buffer.concat([encrypted, Buffer.alloc(16 - (encrypted.length % 16))]);
  const decipher = crypto.createDecipheriv("aes-256-cbc", CTB_AES_KEY, CTB_AES_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(padded), decipher.final()]);
}

/** Encrypt a plaintext settings block for synthetic fixtures / round-trips. */
export function encryptCtbSettingsBlock(plain: Buffer): Buffer {
  const padded =
    plain.length % 16 === 0 ? plain : Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16))]);
  const cipher = crypto.createCipheriv("aes-256-cbc", CTB_AES_KEY, CTB_AES_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function parseEncryptedCtb(fileName: string, reader: CtbReader, magic: number): PrintFileMetrics {
  const header = reader.read(0, ENCRYPTED_HEADER_SIZE);
  if (!header) {
    throw new CtbParseError("This encrypted CTB header is incomplete");
  }

  const settingsSize = u32(header, 0x04);
  const settingsOffset = u32(header, 0x08);
  const version = u32(header, 0x10);

  if (
    settingsSize === null ||
    settingsOffset === null ||
    settingsSize < ENCRYPTED_SETTINGS_MIN ||
    settingsSize > MAX_EXT_CONFIG_BYTES ||
    settingsOffset + settingsSize > reader.size
  ) {
    throw new CtbParseError("That encrypted CTB file has an unreadable settings block");
  }

  const encryptedSettings = reader.read(settingsOffset, settingsSize);
  if (!encryptedSettings) {
    throw new CtbParseError("That encrypted CTB settings block could not be read");
  }

  let settings: Buffer;
  try {
    settings = decryptCtbSettingsBlock(encryptedSettings);
  } catch {
    throw new CtbParseError("That encrypted CTB settings block could not be decrypted");
  }

  if (settings.length < ENCRYPTED_SETTINGS_MIN) {
    throw new CtbParseError("Decrypted CTB settings were shorter than expected");
  }

  const resinVolumeMl = reasonable(f32(settings, 104), 0.001, 100_000);
  const resinMassG = reasonable(f32(settings, 108), 0.001, 100_000);
  const resinCost = reasonable(f32(settings, 112), 0, 1_000_000, 2);
  const machineNameOffset = u32(settings, 160);
  const machineNameSize = u32(settings, 164);
  const machineName =
    machineNameOffset !== null &&
    machineNameSize !== null &&
    machineNameSize > 0 &&
    machineNameSize <= MAX_MACHINE_TYPE_BYTES
      ? safeAscii(reader.read(machineNameOffset, machineNameSize))
      : null;

  return {
    ...baseMetrics(fileName, reader),
    formatRevision: `CTB encrypted v${version ?? "unknown"} · 0x${magic.toString(16)}`,
    printTimeSeconds: printTimeOrNull(u32(settings, 76)),
    resinVolumeMl,
    resinMassG,
    resinCost: costOrNull(resinCost),
    resinCostSource: null,
    resinCostLabel: null,
    resinDensityGPerMl: densityFromMassVolume(resinMassG, resinVolumeMl),
    layerCount: layerCountOrNull(u32(settings, 64)),
    layerHeightMm: reasonable(f32(settings, 36), 0.001, 1, 4),
    modelHeightMm: reasonable(f32(settings, 32), 0.001, 2_000, 3),
    exposureSeconds: reasonable(f32(settings, 40), 0.05, 600, 3),
    bottomExposureSeconds: reasonable(f32(settings, 44), 0.05, 600, 3),
    lightOffSeconds: reasonable(f32(settings, 48), 0, 600, 3),
    bottomLightOffSeconds: reasonable(f32(settings, 116), 0, 600, 3),
    bottomLayerCount: reasonableUInt(u32(settings, 52), 0, 10_000),
    liftDistanceMm: reasonable(f32(settings, 92), 0, 500, 3),
    liftSpeedMmPerMin: reasonable(f32(settings, 96), 0, 1_000, 2),
    bottomLiftDistanceMm: reasonable(f32(settings, 84), 0, 500, 3),
    bottomLiftSpeedMmPerMin: reasonable(f32(settings, 88), 0, 1_000, 2),
    retractSpeedMmPerMin: reasonable(f32(settings, 100), 0, 1_000, 2),
    resolutionX: reasonableUInt(u32(settings, 56), 1, 65_536),
    resolutionY: reasonableUInt(u32(settings, 60), 1, 65_536),
    buildVolumeXmm: reasonable(f32(settings, 12), 1, 2_000),
    buildVolumeYmm: reasonable(f32(settings, 16), 1, 2_000),
    buildVolumeZmm: reasonable(f32(settings, 20), 1, 2_000),
    printerProfile: machineName,
  };
}

function parseClassicCtb(fileName: string, reader: CtbReader, magic: number): PrintFileMetrics {
  const header = reader.read(0, Math.min(CLASSIC_HEADER_READ, reader.size));
  if (!header || header.length < HEADER_MIN_BYTES) {
    throw new CtbParseError("This file is too small to be a Chitubox CTB slice file");
  }

  const version = u32(header, 0x04);
  const layerCount = u32(header, 0x44);
  const printTimeSeconds = u32(header, 0x4c);
  const extConfigOffset = u32(header, EXT_CONFIG_OFFSET);
  const extConfigSizeRaw = u32(header, EXT_CONFIG_SIZE_OFFSET);
  const extConfig2Offset = u32(header, EXT_CONFIG_2_OFFSET);
  const extConfig2SizeRaw = u32(header, EXT_CONFIG_2_SIZE_OFFSET);

  const extConfigSize =
    extConfigSizeRaw !== null && extConfigSizeRaw > 0 && extConfigSizeRaw <= MAX_EXT_CONFIG_BYTES
      ? extConfigSizeRaw
      : 0x40;
  const extConfig =
    extConfigOffset !== null ? reader.read(extConfigOffset, extConfigSize) : null;

  const headerBottomLayerCount = reasonableUInt(u32(header, 0x30), 0, 10_000);
  const resinVolumeMl = extFloat(extConfig ?? Buffer.alloc(0), extConfigOffset, extConfigSize, 0x14, 0.001, 100_000);
  const resinMassG = extFloat(extConfig ?? Buffer.alloc(0), extConfigOffset, extConfigSize, 0x18, 0.001, 100_000);
  const resinCost = extFloat(extConfig ?? Buffer.alloc(0), extConfigOffset, extConfigSize, 0x1c, 0, 1_000_000, 2);
  const extBottomLayerCount = extUInt(extConfig ?? Buffer.alloc(0), extConfigOffset, extConfigSize, 0x28, 0, 10_000);

  const extConfig2Size =
    extConfig2SizeRaw !== null && extConfig2SizeRaw > 0 && extConfig2SizeRaw <= MAX_EXT_CONFIG_BYTES
      ? extConfig2SizeRaw
      : 0x40;
  const extConfig2 =
    extConfig2Offset !== null ? reader.read(extConfig2Offset, extConfig2Size) : null;
  const machineTypeOffset =
    extConfig2 && extConfig2.length >= 0x20 ? u32(extConfig2, 0x1c) : null;
  const machineTypeLength =
    extConfig2 && extConfig2.length >= 0x24 ? u32(extConfig2, 0x20) : null;
  const printerProfile =
    machineTypeOffset !== null &&
    machineTypeLength !== null &&
    machineTypeLength > 0 &&
    machineTypeLength <= MAX_MACHINE_TYPE_BYTES
      ? safeAscii(reader.read(machineTypeOffset, machineTypeLength))
      : null;

  return {
    ...baseMetrics(fileName, reader),
    formatRevision: `CTB header ${version ?? "unknown"} · 0x${magic.toString(16)}`,
    printTimeSeconds: printTimeOrNull(printTimeSeconds),
    resinVolumeMl: extConfig ? resinVolumeMl : null,
    resinMassG: extConfig ? resinMassG : null,
    resinCost: extConfig ? costOrNull(resinCost) : null,
    resinCostSource: null,
    resinCostLabel: null,
    resinDensityGPerMl: densityFromMassVolume(
      extConfig ? resinMassG : null,
      extConfig ? resinVolumeMl : null,
    ),
    layerCount: layerCountOrNull(layerCount),
    layerHeightMm: reasonable(f32(header, 0x20), 0.001, 1, 4),
    modelHeightMm: reasonable(f32(header, 0x1c), 0.001, 2_000, 3),
    exposureSeconds: reasonable(f32(header, 0x24), 0.05, 600, 3),
    bottomExposureSeconds: reasonable(f32(header, 0x28), 0.05, 600, 3),
    lightOffSeconds: reasonable(
      (extConfig
        ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x24, 0, 600, 3)
        : null) ?? f32(header, 0x2c),
      0,
      600,
      3,
    ),
    bottomLightOffSeconds: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x20, 0, 600, 3)
      : null,
    bottomLayerCount: (extConfig ? extBottomLayerCount : null) ?? headerBottomLayerCount,
    liftDistanceMm: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x08, 0, 500, 3)
      : null,
    liftSpeedMmPerMin: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x0c, 0, 1_000, 2)
      : null,
    bottomLiftDistanceMm: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x00, 0, 500, 3)
      : null,
    bottomLiftSpeedMmPerMin: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x04, 0, 1_000, 2)
      : null,
    retractSpeedMmPerMin: extConfig
      ? extFloat(extConfig, extConfigOffset, extConfigSize, 0x10, 0, 1_000, 2)
      : null,
    resolutionX: reasonableUInt(u32(header, 0x34), 1, 65_536),
    resolutionY: reasonableUInt(u32(header, 0x38), 1, 65_536),
    buildVolumeXmm: reasonable(f32(header, 0x08), 1, 2_000),
    buildVolumeYmm: reasonable(f32(header, 0x0c), 1, 2_000),
    buildVolumeZmm: reasonable(f32(header, 0x10), 1, 2_000),
    printerProfile,
  };
}

export class CtbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbParseError";
  }
}

function parseCtbReader(fileName: string, reader: CtbReader): PrintFileMetrics {
  if (reader.size < HEADER_MIN_BYTES) {
    throw new CtbParseError("This file is too small to be a Chitubox CTB slice file");
  }

  const magic = u32At(reader, 0);
  if (magic === null || (magic >>> 16) !== CTB_MAGIC_PREFIX) {
    throw new CtbParseError("That file does not have a recognized Chitubox CTB header");
  }

  if (magic === CTB_ENCRYPTED_MAGIC) {
    return parseEncryptedCtb(fileName, reader, magic);
  }

  return parseClassicCtb(fileName, reader, magic);
}

/**
 * Parse one CTB file's planning metadata from an in-memory buffer.
 * Prefer `parseCtbFileFromPath` for large Mega 8K uploads.
 */
export function parseCtbFile(fileName: string, buffer: Buffer): PrintFileMetrics {
  return parseCtbReader(fileName, createBufferCtbReader(buffer));
}

/**
 * Parse CTB metadata by reading only the needed header/settings ranges from
 * disk. The raw plate file is never fully loaded into memory.
 */
export function parseCtbFileFromPath(fileName: string, filePath: string): PrintFileMetrics {
  const reader = createFileCtbReader(filePath);
  try {
    return parseCtbReader(fileName, reader);
  } catch (error) {
    if (error instanceof CtbParseError) throw error;
    throw new CtbParseError("That CTB file could not be read from disk");
  } finally {
    reader.close();
  }
}

/**
 * Parse CTB metadata from a sampled prefix of a larger on-disk plate.
 * Used when the browser uploads only the first few MB to dodge proxy limits.
 */
export function parseCtbFileFromPrefix(
  fileName: string,
  prefix: Buffer,
  fullFileSize: number,
  tail?: Buffer,
): PrintFileMetrics {
  const reader = createPrefixCtbReader(prefix, fullFileSize, tail);
  try {
    return parseCtbReader(fileName, reader);
  } catch (error) {
    if (error instanceof CtbParseError) throw error;
    throw new CtbParseError("That CTB prefix could not be read");
  } finally {
    reader.close();
  }
}
