/**
 * OCR fallback for image-only shipping label PDFs (ShipStation / ShipEngine exports).
 * Extracts an embedded FlateDecode Indexed image when present, tries rotations, runs tesseract.
 */
import fs from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";

const OCR_TIMEOUT_MS = 45_000;

function parsePdfLiteralString(buf: Buffer, openParenIndex: number): Buffer {
  let i = openParenIndex + 1;
  const out: number[] = [];
  let depth = 1;
  while (i < buf.length && depth > 0) {
    const b = buf[i]!;
    if (b === 0x5c) {
      const n = buf[i + 1];
      if (n == null) break;
      if (n >= 0x30 && n <= 0x37) {
        let oct = String.fromCharCode(n);
        i += 2;
        for (let k = 0; k < 2 && i < buf.length && buf[i]! >= 0x30 && buf[i]! <= 0x37; k += 1, i += 1) {
          oct += String.fromCharCode(buf[i]!);
        }
        out.push(parseInt(oct, 8) & 0xff);
        continue;
      }
      const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      out.push(map[String.fromCharCode(n)] ?? n);
      i += 2;
      continue;
    }
    if (b === 0x28) {
      depth += 1;
      out.push(b);
      i += 1;
      continue;
    }
    if (b === 0x29) {
      depth -= 1;
      if (depth === 0) break;
      out.push(b);
      i += 1;
      continue;
    }
    out.push(b);
    i += 1;
  }
  return Buffer.from(out);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function encodePngRgb(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function rotateRgb90Cw(width: number, height: number, rgb: Buffer): { width: number; height: number; rgb: Buffer } {
  const rw = height;
  const rh = width;
  const out = Buffer.alloc(rw * rh * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = height - 1 - y;
      const ny = x;
      const si = (y * width + x) * 3;
      const di = (ny * rw + nx) * 3;
      out[di] = rgb[si]!;
      out[di + 1] = rgb[si + 1]!;
      out[di + 2] = rgb[si + 2]!;
    }
  }
  return { width: rw, height: rh, rgb: out };
}

function rotateRgb180(width: number, height: number, rgb: Buffer): { width: number; height: number; rgb: Buffer } {
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = width - 1 - x;
      const ny = height - 1 - y;
      const si = (y * width + x) * 3;
      const di = (ny * width + nx) * 3;
      out[di] = rgb[si]!;
      out[di + 1] = rgb[si + 1]!;
      out[di + 2] = rgb[si + 2]!;
    }
  }
  return { width, height, rgb: out };
}

/** Pull the first FlateDecode Indexed/DeviceRGB image from a simple ShipStation-style label PDF. */
export function extractIndexedImageFromPdf(buffer: Buffer): {
  width: number;
  height: number;
  rgb: Buffer;
} | null {
  const latin = buffer.toString("latin1");
  const imageAt = latin.search(/\/Subtype\s*\/Image/);
  if (imageAt < 0) return null;
  const dictStart = latin.lastIndexOf("obj", imageAt);
  const streamKeyword = latin.indexOf("stream", imageAt);
  if (dictStart < 0 || streamKeyword < 0) return null;
  const dict = latin.slice(dictStart, streamKeyword);
  const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1] ?? 0);
  const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1] ?? 0);
  const length = Number(dict.match(/\/Length\s+(\d+)/)?.[1] ?? 0);
  if (!width || !height || !length || width * height > 12_000_000) return null;
  if (!/\/Indexed\s*\/DeviceRGB/i.test(dict) && !/\/Indexed\/DeviceRGB/i.test(dict)) return null;

  const marker = Buffer.from("/Indexed/DeviceRGB");
  const markerAt = buffer.indexOf(marker);
  if (markerAt < 0) return null;
  const parenAt = buffer.indexOf(0x28, markerAt);
  if (parenAt < 0) return null;
  const palette = parsePdfLiteralString(buffer, parenAt);
  if (palette.length < 768) return null;

  let dataStart = streamKeyword + "stream".length;
  if (buffer[dataStart] === 0x0d) dataStart += 1;
  if (buffer[dataStart] === 0x0a) dataStart += 1;
  let indexed: Buffer;
  try {
    indexed = inflateSync(buffer.subarray(dataStart, dataStart + length));
  } catch {
    return null;
  }
  if (indexed.length < width * height) return null;

  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const idx = indexed[i]!;
    rgb[i * 3] = palette[idx * 3]!;
    rgb[i * 3 + 1] = palette[idx * 3 + 1]!;
    rgb[i * 3 + 2] = palette[idx * 3 + 2]!;
  }
  return { width, height, rgb };
}

function scoreOcrText(text: string): number {
  let score = 0;
  if (/1Z[0-9A-Z\s]{16,24}/i.test(text)) score += 50;
  if (/(?:94|93|92|91|95)\d{18}/.test(text.replace(/\s+/g, ""))) score += 40;
  if (/ship\s*to/i.test(text)) score += 15;
  if (/tracking\s*#/i.test(text)) score += 20;
  if (/\bUPS\b/i.test(text) || /ground/i.test(text)) score += 5;
  if (/[A-Z]{2}\s+\d{5}/.test(text)) score += 10;
  score += Math.min(20, Math.floor(text.replace(/\s+/g, "").length / 40));
  return score;
}

async function ocrPngBuffer(png: Buffer): Promise<string> {
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, { logger: () => undefined });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
    });
    const recognize = worker.recognize(png);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OCR timed out")), OCR_TIMEOUT_MS);
    });
    const result = await Promise.race([recognize, timeout]);
    return String(result.data?.text ?? "").trim();
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

/**
 * Best-effort OCR text from an image-only shipping label PDF.
 * Returns empty string when extraction/OCR is unavailable.
 */
export async function ocrShippingLabelPdf(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const image = extractIndexedImageFromPdf(buffer);
  if (!image) return "";

  const orientations: Array<{ width: number; height: number; rgb: Buffer }> = [
    image,
    rotateRgb90Cw(image.width, image.height, image.rgb),
  ];
  orientations.push(rotateRgb180(image.width, image.height, image.rgb));
  orientations.push(
    rotateRgb90Cw(orientations[1]!.width, orientations[1]!.height, orientations[1]!.rgb),
  );

  let bestText = "";
  let bestScore = -1;
  for (const orient of orientations) {
    const png = encodePngRgb(orient.width, orient.height, orient.rgb);
    try {
      const text = await ocrPngBuffer(png);
      const score = scoreOcrText(text);
      if (score > bestScore) {
        bestScore = score;
        bestText = text;
      }
      if (score >= 60) break;
    } catch {
      // try next orientation
    }
  }
  return bestText;
}
