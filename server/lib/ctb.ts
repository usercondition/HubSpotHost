/**
 * Read production-planning metadata from a Chitubox CTB slice file.
 *
 * Supports:
 * - Classic unencrypted CTB/CBDDLP headers (catibo layout)
 * - Encrypted CTB v4/v5 used by modern printers (e.g. Elegoo Mighty 8K),
 *   where the slicer settings block is AES-CBC encrypted
 *
 * Only header/settings fields are inspected. Layer images are never decoded
 * or retained, so large uploads stay in memory briefly and are discarded.
 */
import crypto from "node:crypto";
import type { PrintFileMetrics } from "../../shared/schema";

const CTB_MAGIC_PREFIX = 0x12fd;
const CTB_ENCRYPTED_MAGIC = 0x12fd0107;
const HEADER_MIN_BYTES = 0x50;
const EXT_CONFIG_OFFSET = 0x54;
const EXT_CONFIG_SIZE_OFFSET = 0x58;
const EXT_CONFIG_2_OFFSET = 0x6c;
const MAX_MACHINE_TYPE_BYTES = 200;
const ENCRYPTED_HEADER_SIZE = 48;
const ENCRYPTED_SETTINGS_MIN = 168;

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

function hasRange(buffer: Buffer, offset: number, length: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && length >= 0 && offset + length <= buffer.length;
}

function u32(buffer: Buffer, offset: number): number | null {
  return hasRange(buffer, offset, 4) ? buffer.readUInt32LE(offset) : null;
}

function f32(buffer: Buffer, offset: number): number | null {
  if (!hasRange(buffer, offset, 4)) return null;
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
  return reasonable(f32(buffer, extOffset + fieldOffset), min, max, digits);
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
  return reasonableUInt(u32(buffer, extOffset + fieldOffset), min, max);
}

function safeAscii(buffer: Buffer, offset: number | null, length: number | null): string | null {
  if (
    offset === null ||
    length === null ||
    length < 1 ||
    length > MAX_MACHINE_TYPE_BYTES ||
    !hasRange(buffer, offset, length)
  ) {
    return null;
  }
  const value = buffer
    .subarray(offset, offset + length)
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

function printTimeOrNull(value: number | null): number | null {
  return value !== null && value > 0 && value <= 7 * 24 * 60 * 60 ? value : null;
}

function layerCountOrNull(value: number | null): number | null {
  return value !== null && value > 0 && value <= 2_000_000 ? value : null;
}

function baseMetrics(fileName: string, buffer: Buffer): Pick<
  PrintFileMetrics,
  "fileName" | "fileSizeBytes" | "sha256" | "format"
> {
  return {
    fileName: fileName.slice(0, 260),
    fileSizeBytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
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

function parseEncryptedCtb(fileName: string, buffer: Buffer, magic: number): PrintFileMetrics {
  if (buffer.length < ENCRYPTED_HEADER_SIZE) {
    throw new CtbParseError("This encrypted CTB header is incomplete");
  }

  const settingsSize = u32(buffer, 0x04);
  const settingsOffset = u32(buffer, 0x08);
  const version = u32(buffer, 0x10);

  if (
    settingsSize === null ||
    settingsOffset === null ||
    settingsSize < ENCRYPTED_SETTINGS_MIN ||
    settingsSize > 4_096 ||
    !hasRange(buffer, settingsOffset, settingsSize)
  ) {
    throw new CtbParseError("That encrypted CTB file has an unreadable settings block");
  }

  let settings: Buffer;
  try {
    settings = decryptCtbSettingsBlock(buffer.subarray(settingsOffset, settingsOffset + settingsSize));
  } catch {
    throw new CtbParseError("That encrypted CTB settings block could not be decrypted");
  }

  if (settings.length < ENCRYPTED_SETTINGS_MIN) {
    throw new CtbParseError("Decrypted CTB settings were shorter than expected");
  }

  // Offsets into the decrypted SlicerSettings structure (UVtools / community layout).
  const resinVolumeMl = reasonable(f32(settings, 104), 0.001, 100_000);
  const resinMassG = reasonable(f32(settings, 108), 0.001, 100_000);
  const resinCost = reasonable(f32(settings, 112), 0, 1_000_000, 2);
  const machineNameOffset = u32(settings, 160);
  const machineNameSize = u32(settings, 164);

  return {
    ...baseMetrics(fileName, buffer),
    formatRevision: `CTB encrypted v${version ?? "unknown"} · 0x${magic.toString(16)}`,
    printTimeSeconds: printTimeOrNull(u32(settings, 76)),
    resinVolumeMl,
    resinMassG,
    resinCost,
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
    printerProfile: safeAscii(buffer, machineNameOffset, machineNameSize),
  };
}

function parseClassicCtb(fileName: string, buffer: Buffer, magic: number): PrintFileMetrics {
  const version = u32(buffer, 0x04);
  const layerCount = u32(buffer, 0x44);
  const printTimeSeconds = u32(buffer, 0x4c);
  const extConfigOffset = u32(buffer, EXT_CONFIG_OFFSET);
  const extConfigSize = u32(buffer, EXT_CONFIG_SIZE_OFFSET);
  const extConfig2Offset = u32(buffer, EXT_CONFIG_2_OFFSET);

  const headerBottomLayerCount = reasonableUInt(u32(buffer, 0x30), 0, 10_000);
  const resinVolumeMl = extFloat(buffer, extConfigOffset, extConfigSize, 0x14, 0.001, 100_000);
  const resinMassG = extFloat(buffer, extConfigOffset, extConfigSize, 0x18, 0.001, 100_000);
  const resinCost = extFloat(buffer, extConfigOffset, extConfigSize, 0x1c, 0, 1_000_000, 2);
  const extBottomLayerCount = extUInt(buffer, extConfigOffset, extConfigSize, 0x28, 0, 10_000);

  const machineTypeOffset =
    extConfig2Offset !== null && hasRange(buffer, extConfig2Offset + 0x1c, 4)
      ? u32(buffer, extConfig2Offset + 0x1c)
      : null;
  const machineTypeLength =
    extConfig2Offset !== null && hasRange(buffer, extConfig2Offset + 0x20, 4)
      ? u32(buffer, extConfig2Offset + 0x20)
      : null;

  return {
    ...baseMetrics(fileName, buffer),
    formatRevision: `CTB header ${version ?? "unknown"} · 0x${magic.toString(16)}`,
    printTimeSeconds: printTimeOrNull(printTimeSeconds),
    resinVolumeMl,
    resinMassG,
    resinCost,
    resinDensityGPerMl: densityFromMassVolume(resinMassG, resinVolumeMl),
    layerCount: layerCountOrNull(layerCount),
    layerHeightMm: reasonable(f32(buffer, 0x20), 0.001, 1, 4),
    modelHeightMm: reasonable(f32(buffer, 0x1c), 0.001, 2_000, 3),
    exposureSeconds: reasonable(f32(buffer, 0x24), 0.05, 600, 3),
    bottomExposureSeconds: reasonable(f32(buffer, 0x28), 0.05, 600, 3),
    lightOffSeconds: reasonable(
      extFloat(buffer, extConfigOffset, extConfigSize, 0x24, 0, 600, 3) ?? f32(buffer, 0x2c),
      0,
      600,
      3,
    ),
    bottomLightOffSeconds: extFloat(buffer, extConfigOffset, extConfigSize, 0x20, 0, 600, 3),
    bottomLayerCount: extBottomLayerCount ?? headerBottomLayerCount,
    liftDistanceMm: extFloat(buffer, extConfigOffset, extConfigSize, 0x08, 0, 500, 3),
    liftSpeedMmPerMin: extFloat(buffer, extConfigOffset, extConfigSize, 0x0c, 0, 1_000, 2),
    bottomLiftDistanceMm: extFloat(buffer, extConfigOffset, extConfigSize, 0x00, 0, 500, 3),
    bottomLiftSpeedMmPerMin: extFloat(buffer, extConfigOffset, extConfigSize, 0x04, 0, 1_000, 2),
    retractSpeedMmPerMin: extFloat(buffer, extConfigOffset, extConfigSize, 0x10, 0, 1_000, 2),
    resolutionX: reasonableUInt(u32(buffer, 0x34), 1, 65_536),
    resolutionY: reasonableUInt(u32(buffer, 0x38), 1, 65_536),
    buildVolumeXmm: reasonable(f32(buffer, 0x08), 1, 2_000),
    buildVolumeYmm: reasonable(f32(buffer, 0x0c), 1, 2_000),
    buildVolumeZmm: reasonable(f32(buffer, 0x10), 1, 2_000),
    printerProfile: safeAscii(buffer, machineTypeOffset, machineTypeLength),
  };
}

export class CtbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbParseError";
  }
}

/**
 * Parse one CTB file's planning metadata. The values describe the whole plate,
 * so the caller should attach a file only to an order that owns that plate.
 */
export function parseCtbFile(fileName: string, buffer: Buffer): PrintFileMetrics {
  if (buffer.length < HEADER_MIN_BYTES) {
    throw new CtbParseError("This file is too small to be a Chitubox CTB slice file");
  }

  const magic = u32(buffer, 0);
  if (magic === null || (magic >>> 16) !== CTB_MAGIC_PREFIX) {
    throw new CtbParseError("That file does not have a recognized Chitubox CTB header");
  }

  if (magic === CTB_ENCRYPTED_MAGIC) {
    return parseEncryptedCtb(fileName, buffer, magic);
  }

  return parseClassicCtb(fileName, buffer, magic);
}
