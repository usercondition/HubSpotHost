/**
 * A ~480MB plate addressed by range. The body is never allocated.
 * Run directly for peak RSS: `npx tsx tests/plate-mesh-stream.ts`
 */
import { buildPlateGlb } from "../server/lib/plate-mesh";

export const STREAM_PLATE_BYTES = 480 * 1024 * 1024;
const RANGE_CAP = 8 * 1024 * 1024;

export interface StreamMeasure {
  peakRss: number;
  startRss: number;
  maxRead: number;
  bytesRead: number;
  reads: number;
  glbBytes: number;
  ms: number;
}

function copyOverlap(dest: Buffer, destStart: number, src: Buffer, srcStart: number): void {
  const start = Math.max(destStart, srcStart);
  const end = Math.min(destStart + dest.length, srcStart + src.length);
  if (end <= start) return;
  src.copy(dest, start - destStart, start - srcStart, end - srcStart);
}

export async function streamLargePlate(): Promise<StreamMeasure> {
  const width = 64;
  const height = 48;
  const layerCount = 240;
  const tableOffset = 0x80;
  const payloads: Buffer[] = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    const inset = Math.min(16, Math.floor(layer / 10));
    const bytes: number[] = [];
    for (let y = 0; y < height; y += 1) {
      if (y < inset || y >= height - inset) bytes.push(0x80, width);
      else {
        const x0 = inset;
        const x1 = width - inset;
        if (x0 > 0) bytes.push(0x80, x0);
        bytes.push(0x80 | 0x7f, x1 - x0);
        if (width - x1 > 0) bytes.push(0x80, width - x1);
      }
    }
    payloads.push(Buffer.from(bytes));
  }
  const dataOrigin = 9 * 1024 * 1024;
  const gap = Math.floor((STREAM_PLATE_BYTES - dataOrigin - 1024) / layerCount);
  const offsets = payloads.map((_, index) => dataOrigin + index * gap);
  const header = Buffer.alloc(tableOffset + layerCount * 36);
  header.writeUInt32LE(0x12fd0086, 0);
  header.writeUInt32LE(width, 0x34);
  header.writeUInt32LE(height, 0x38);
  header.writeUInt32LE(tableOffset, 0x40);
  header.writeUInt32LE(layerCount, 0x44);
  payloads.forEach((layer, index) => {
    const at = tableOffset + index * 36;
    header.writeUInt32LE(offsets[index]!, at + 12);
    header.writeUInt32LE(layer.length, at + 16);
  });

  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  let maxRead = 0;
  let bytesRead = 0;
  let reads = 0;
  const started = Date.now();
  const glb = await buildPlateGlb(async (start, length) => {
    if (length > RANGE_CAP || length >= STREAM_PLATE_BYTES) {
      throw new Error(`range ${start}+${length} buffers the plate`);
    }
    reads += 1;
    bytesRead += length;
    if (length > maxRead) maxRead = length;
    const out = Buffer.alloc(length);
    copyOverlap(out, start, header, 0);
    for (let index = 0; index < payloads.length; index += 1) {
      copyOverlap(out, start, payloads[index]!, offsets[index]!);
    }
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
    return out;
  }, STREAM_PLATE_BYTES);
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  if (glb.length < 100 || glb.subarray(0, 4).toString() !== "glTF") throw new Error("empty mesh");
  return { peakRss, startRss, maxRead, bytesRead, reads, glbBytes: glb.length, ms: Date.now() - started };
}

const direct = process.argv[1]?.endsWith("plate-mesh-stream.ts") === true;
if (direct) {
  streamLargePlate()
    .then((result) => {
      console.log(JSON.stringify(result));
      const budget = 300 * 1024 * 1024;
      if (result.peakRss > budget || result.maxRead > RANGE_CAP || result.bytesRead > 32 * 1024 * 1024) {
        process.exit(1);
      }
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
