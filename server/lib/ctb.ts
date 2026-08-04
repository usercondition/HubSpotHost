/**
 * Read the stable, non-image header fields from a Chitubox CTB slice file.
 *
 * CTB is a binary, little-endian format. We intentionally inspect only the
 * fixed header and extension records needed for production planning, never
 * decode or retain the layer images. This keeps uploads quick and prevents
 * large slice files from being stored on the server.
 *
 * Header offsets are based on the public CTB/CBDDLP layout documented by
 * catibo and are guarded carefully because CTB files in the wild vary in
 * revision and may contain optional extension records.
 */
import crypto from "node:crypto";
import type { PrintFileMetrics } from "../../shared/schema";

const CTB_MAGIC_PREFIX = 0x12fd;
const HEADER_MIN_BYTES = 0x50;
const EXT_CONFIG_OFFSET = 0x54;
const EXT_CONFIG_SIZE_OFFSET = 0x58;
const EXT_CONFIG_2_OFFSET = 0x6c;
const MAX_MACHINE_TYPE_BYTES = 200;

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
    fileName: fileName.slice(0, 260),
    fileSizeBytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    format: "CTB",
    formatRevision: `CTB header ${version ?? "unknown"} · 0x${magic.toString(16)}`,
    printTimeSeconds:
      printTimeSeconds !== null && printTimeSeconds > 0 && printTimeSeconds <= 7 * 24 * 60 * 60
        ? printTimeSeconds
        : null,
    resinVolumeMl,
    resinMassG,
    resinCost,
    resinDensityGPerMl: densityFromMassVolume(resinMassG, resinVolumeMl),
    layerCount: layerCount !== null && layerCount > 0 && layerCount <= 2_000_000 ? layerCount : null,
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
