/**
 * Chitubox preview thumbnails. Large and small images are RGB565 RLE and stay
 * readable on encrypted CTB v4/v5. Layer bitmaps are not decoded here.
 */
import zlib from "node:zlib";
import { CTB_ENCRYPTED_MAGIC, createBufferCtbReader, createPrefixCtbReader, decryptCtbSettingsBlock, type CtbReader } from "./ctb";

const CLASSIC_LARGE_OFFSET = 0x3c;
const CLASSIC_SMALL_OFFSET = 0x48;
const ENCRYPTED_LARGE_OFFSET = 68;
const ENCRYPTED_SMALL_OFFSET = 72;
const MAX_EDGE = 1024;
const MAX_IMAGE_BYTES = 2_000_000;
const REPEAT_MASK = 0x20;

export interface DecodedPreview {
  width: number;
  height: number;
  png: Buffer;
}

function u32(buffer: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c ^= buffer[i]!;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodeRgbPng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgb.copy(raw, row + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode a Chitubox RGB565 run-length preview into RGB bytes. */
export function decodeRgb565Rle(data: Buffer, width: number, height: number): Buffer | null {
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) return null;
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  let src = 0;
  let pixel = 0;
  while (src + 1 < data.length && pixel < pixels) {
    const dot = data[src]! | (data[src + 1]! << 8);
    src += 2;
    const red = ((dot >> 11) & 0x1f) << 3;
    const green = ((dot >> 6) & 0x1f) << 3;
    const blue = (dot & 0x1f) << 3;
    let repeat = 1;
    if ((dot & REPEAT_MASK) === REPEAT_MASK) {
      if (src + 1 >= data.length) return null;
      repeat += data[src]! | ((data[src + 1]! & 0x0f) << 8);
      src += 2;
    }
    if (repeat < 1 || pixel + repeat > pixels) return null;
    for (let n = 0; n < repeat; n += 1) {
      const at = pixel * 3;
      rgb[at] = red;
      rgb[at + 1] = green;
      rgb[at + 2] = blue;
      pixel += 1;
    }
  }
  if (pixel === 0) return null;
  return encodeRgbPng(width, height, rgb);
}

function previewAt(reader: CtbReader, headerOffset: number): DecodedPreview | null {
  if (!Number.isInteger(headerOffset) || headerOffset < 0) return null;
  const header = reader.read(headerOffset, 16);
  if (!header) return null;
  const width = u32(header, 0);
  const height = u32(header, 4);
  const imageOffset = u32(header, 8);
  const imageLength = u32(header, 12);
  if (
    width === null ||
    height === null ||
    imageOffset === null ||
    imageLength === null ||
    width < 1 ||
    height < 1 ||
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    imageLength < 2 ||
    imageLength > MAX_IMAGE_BYTES
  ) {
    return null;
  }
  const encoded = reader.read(imageOffset, imageLength);
  if (!encoded) return null;
  const png = decodeRgb565Rle(encoded, width, height);
  return png ? { width, height, png } : null;
}

function encryptedPreviewOffsets(reader: CtbReader): number[] {
  const header = reader.read(0, 0x30);
  if (!header) return [];
  const settingsSize = u32(header, 0x04);
  const settingsOffset = u32(header, 0x08);
  if (
    settingsSize === null ||
    settingsOffset === null ||
    settingsSize < ENCRYPTED_SMALL_OFFSET + 4 ||
    settingsSize > 8192
  ) {
    return [];
  }
  const encrypted = reader.read(settingsOffset, settingsSize);
  if (!encrypted) return [];
  let settings: Buffer;
  try {
    settings = decryptCtbSettingsBlock(encrypted);
  } catch {
    return [];
  }
  const large = u32(settings, ENCRYPTED_LARGE_OFFSET);
  const small = u32(settings, ENCRYPTED_SMALL_OFFSET);
  return [large, small].filter((offset): offset is number => offset !== null && offset > 0);
}

export function extractCtbPreview(reader: CtbReader): DecodedPreview | null {
  const magic = u32(reader.read(0, 4) ?? Buffer.alloc(0), 0);
  const offsets = magic === CTB_ENCRYPTED_MAGIC ? encryptedPreviewOffsets(reader) : classicOffsets(reader);
  for (const offset of offsets) {
    try {
      const preview = previewAt(reader, offset);
      if (preview) return preview;
    } catch {
      /* try the other thumbnail */
    }
  }
  return null;
}

function classicOffsets(reader: CtbReader): number[] {
  const header = reader.read(0, CLASSIC_SMALL_OFFSET + 4);
  if (!header) return [];
  const large = u32(header, CLASSIC_LARGE_OFFSET);
  const small = u32(header, CLASSIC_SMALL_OFFSET);
  return [large, small].filter((offset): offset is number => offset !== null && offset > 0);
}

export function extractCtbPreviewFromPrefix(prefix: Buffer, fullFileSize: number): DecodedPreview | null {
  try {
    const reader = fullFileSize > prefix.length ? createPrefixCtbReader(prefix, fullFileSize) : createBufferCtbReader(prefix);
    try {
      return extractCtbPreview(reader);
    } finally {
      reader.close();
    }
  } catch {
    return null;
  }
}

/** HeyGears archives sometimes carry a stored PNG. Encrypted members are skipped. */
export function extractUltxPreviewPng(buffer: Buffer): Buffer | null {
  const start = buffer.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (start < 0) return null;
  const end = buffer.indexOf(Buffer.from("IEND"), start);
  if (end < 0 || end + 8 > buffer.length) return null;
  const png = buffer.subarray(start, end + 8);
  if (png.length < 32 || png.length > MAX_IMAGE_BYTES) return null;
  return Buffer.from(png);
}
