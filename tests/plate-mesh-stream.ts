/**
 * A ~480MB plate addressed by range. The body is never allocated.
 * Geometry is several separated parts plus a thin support, at a real pixel pitch.
 * Run directly for peak RSS: `npx tsx tests/plate-mesh-stream.ts`
 */
import { buildPlateGlb } from "../server/lib/plate-mesh";

export const STREAM_PLATE_BYTES = 480 * 1024 * 1024;
const RANGE_CAP = 8 * 1024 * 1024;
const PIXEL_MM = 0.05;
const LAYER_MM = 0.05;

export interface StreamMeasure {
  peakRss: number;
  startRss: number;
  maxRead: number;
  bytesRead: number;
  reads: number;
  glbBytes: number;
  triangles: number;
  components: number;
  thinSupports: number;
  agreement: number;
  manifold: number;
  ms: number;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

function rle(white: boolean, length: number): number[] {
  if (length < 1) return [];
  const head = 0x80 | (white ? 0x7f : 0);
  if (length < 0x80) return [head, length];
  if (length < 0x4000) return [head, 0x80 | (length >> 8), length & 0xff];
  return [head, 0xc0 | ((length >> 16) & 0x1f), (length >> 8) & 0xff, length & 0xff];
}

function px(mm: number): number {
  return Math.round(mm / PIXEL_MM);
}

function layerRle(width: number, height: number, layer: number, boxes: Box[]): Buffer {
  const bytes: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const spans: Array<[number, number]> = [];
    for (const box of boxes) {
      if (layer < box.z0 || layer >= box.z1 || y < box.y0 || y >= box.y1) continue;
      spans.push([box.x0, box.x1]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (!last || span[0] > last[1]) merged.push([span[0], span[1]]);
      else last[1] = Math.max(last[1], span[1]);
    }
    let cursor = 0;
    for (const [x0, x1] of merged) {
      if (x0 > cursor) bytes.push(...rle(false, x0 - cursor));
      bytes.push(...rle(true, x1 - x0));
      cursor = x1;
    }
    if (cursor < width) bytes.push(...rle(false, width - cursor));
  }
  return Buffer.from(bytes);
}

/** Feet, a shoulder turret, a side panel, connected supports, and one free 0.8 mm pillar. */
function plateBoxes(): { width: number; height: number; layers: number; boxes: Box[] } {
  const width = px(90);
  const height = px(60);
  const layers = Math.round(8 / LAYER_MM);
  const pillar = px(0.8);
  const boxes: Box[] = [
    { x0: px(4), x1: px(20), y0: px(4), y1: px(16), z0: Math.round(2 / LAYER_MM), z1: layers },
    { x0: px(36), x1: px(48), y0: px(6), y1: px(16), z0: Math.round(2.4 / LAYER_MM), z1: layers - 4 },
    { x0: px(58), x1: px(82), y0: px(28), y1: px(31.2), z0: Math.round(1.6 / LAYER_MM), z1: layers - 2 },
    { x0: px(8), x1: px(8) + pillar, y0: px(8), y1: px(8) + pillar, z0: 0, z1: Math.round(2.6 / LAYER_MM) },
    { x0: px(14), x1: px(14) + pillar, y0: px(12), y1: px(12) + pillar, z0: 0, z1: Math.round(2.6 / LAYER_MM) },
    { x0: px(40), x1: px(40) + pillar, y0: px(10), y1: px(10) + pillar, z0: 0, z1: Math.round(3 / LAYER_MM) },
    { x0: px(70), x1: px(70) + pillar, y0: px(40), y1: px(40) + pillar, z0: 0, z1: Math.round(3 / LAYER_MM) },
  ];
  return { width, height, layers, boxes };
}

function copyOverlap(dest: Buffer, destStart: number, src: Buffer, srcStart: number): void {
  const start = Math.max(destStart, srcStart);
  const end = Math.min(destStart + dest.length, srcStart + src.length);
  if (end <= start) return;
  src.copy(dest, start - destStart, start - srcStart, end - srcStart);
}

export function inspectGlb(glb: Buffer): {
  triangles: number;
  components: number;
  thinSupports: number;
  hasNormals: boolean;
  agreement: number;
  manifold: number;
} {
  const jsonLen = glb.readUInt32LE(12);
  const doc = JSON.parse(glb.subarray(20, 20 + jsonLen).toString()) as {
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number; NORMAL?: number }; indices: number }> }>;
    accessors: Array<{ bufferView: number; count: number }>;
    bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
  };
  const primitive = doc.meshes[0]!.primitives[0]!;
  const position = doc.accessors[primitive.attributes.POSITION]!;
  const index = doc.accessors[primitive.indices]!;
  const indexView = doc.bufferViews[index.bufferView]!;
  const binAt = 20 + jsonLen + 8;
  const idxBytes = glb.subarray(binAt + (indexView.byteOffset ?? 0), binAt + (indexView.byteOffset ?? 0) + indexView.byteLength);
  const indices = new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, index.count);
  const posView = doc.bufferViews[position.bufferView]!;
  const posBytes = glb.subarray(binAt + (posView.byteOffset ?? 0), binAt + (posView.byteOffset ?? 0) + posView.byteLength);
  const positions = new Float32Array(posBytes.buffer, posBytes.byteOffset, position.count * 3);
  const parent = new Int32Array(position.count);
  for (let i = 0; i < parent.length; i += 1) parent[i] = i;
  const find = (v: number) => {
    let cursor = v;
    while (parent[cursor] !== cursor) cursor = parent[cursor]!;
    let root = v;
    while (parent[root] !== cursor) {
      const next = parent[root]!;
      parent[root] = cursor;
      root = next;
    }
    return cursor;
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(indices[i]!);
    const b = find(indices[i + 1]!);
    const c = find(indices[i + 2]!);
    parent[b] = a;
    parent[c] = a;
  }
  const bounds = new Map<number, { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }>();
  for (let v = 0; v < position.count; v += 1) {
    const root = find(v);
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const box = bounds.get(root);
    if (!box) {
      bounds.set(root, { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z });
      continue;
    }
    if (x < box.minX) box.minX = x;
    if (y < box.minY) box.minY = y;
    if (z < box.minZ) box.minZ = z;
    if (x > box.maxX) box.maxX = x;
    if (y > box.maxY) box.maxY = y;
    if (z > box.maxZ) box.maxZ = z;
  }
  let thinSupports = 0;
  for (const box of bounds.values()) {
    const across = Math.max(box.maxX - box.minX, box.maxZ - box.minZ);
    const along = Math.min(box.maxX - box.minX, box.maxZ - box.minZ);
    const tall = box.maxY - box.minY;
    if (across < 1.6 && along > 0.35 && tall > 1.4) thinSupports += 1;
  }
  const edges = new Map<string, { faces: number; forward: number; back: number }>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    for (let edge = 0; edge < 3; edge += 1) {
      const u = tri[edge]!;
      const v = tri[(edge + 1) % 3]!;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      let record = edges.get(key);
      if (!record) {
        record = { faces: 0, forward: 0, back: 0 };
        edges.set(key, record);
      }
      record.faces += 1;
      if (u < v) record.forward += 1;
      else record.back += 1;
    }
  }
  let pairs = 0;
  let agree = 0;
  let closed = 0;
  for (const record of edges.values()) {
    if (record.faces === 2) {
      pairs += 1;
      closed += 1;
      if (record.forward === 1 && record.back === 1) agree += 1;
    }
  }
  return {
    triangles: index.count / 3,
    components: bounds.size,
    thinSupports,
    hasNormals: primitive.attributes.NORMAL !== undefined,
    agreement: pairs > 0 ? agree / pairs : 0,
    manifold: edges.size > 0 ? closed / edges.size : 0,
  };
}

/** Many separated mini-sized parts, large enough that decimation has to run. */
export function separatedMinisCtb(): Buffer {
  const pitch = 11;
  const cols = 8;
  const rows = 9;
  const width = px(cols * pitch);
  const height = px(rows * pitch);
  const layers = Math.round(8 / LAYER_MM);
  const boxes: Box[] = [];
  for (let i = 0; i < cols * rows; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const size = 8;
    const x = col * pitch + (pitch - size) / 2;
    const y = row * pitch + (pitch - size) / 2;
    boxes.push({
      x0: px(x),
      x1: px(x + size),
      y0: px(y),
      y1: px(y + size),
      z0: Math.round(1.2 / LAYER_MM),
      z1: Math.round((1.2 + size * 0.85) / LAYER_MM),
    });
    if (i % 3 !== 0) continue;
    const pillar = px(0.8);
    const cx = px(x + size / 2);
    const cy = px(y + size / 2);
    boxes.push({
      x0: cx - (pillar >> 1),
      x1: cx + Math.max(1, pillar >> 1),
      y0: cy - (pillar >> 1),
      y1: cy + Math.max(1, pillar >> 1),
      z0: 0,
      z1: Math.round(1.5 / LAYER_MM),
    });
  }
  const tableOffset = 0x80;
  const payloads = Array.from({ length: layers }, (_, layer) => layerRle(width, height, layer, boxes));
  const dataStart = tableOffset + layers * 36;
  const file = Buffer.alloc(dataStart + payloads.reduce((sum, layer) => sum + layer.length, 0));
  file.writeUInt32LE(0x12fd0086, 0);
  file.writeFloatLE(width * PIXEL_MM, 0x08);
  file.writeFloatLE(height * PIXEL_MM, 0x0c);
  file.writeFloatLE(layers * LAYER_MM, 0x10);
  file.writeFloatLE(LAYER_MM, 0x20);
  file.writeUInt32LE(width, 0x34);
  file.writeUInt32LE(height, 0x38);
  file.writeUInt32LE(tableOffset, 0x40);
  file.writeUInt32LE(layers, 0x44);
  let cursor = dataStart;
  payloads.forEach((layer, index) => {
    const at = tableOffset + index * 36;
    file.writeUInt32LE(cursor, at + 12);
    file.writeUInt32LE(layer.length, at + 16);
    layer.copy(file, cursor);
    cursor += layer.length;
  });
  return file;
}

export async function streamLargePlate(): Promise<StreamMeasure> {
  const { width, height, layers, boxes } = plateBoxes();
  const tableOffset = 0x80;
  const payloads = Array.from({ length: layers }, (_, layer) => layerRle(width, height, layer, boxes));
  const dataOrigin = 9 * 1024 * 1024;
  const gap = Math.floor((STREAM_PLATE_BYTES - dataOrigin - 1024) / layers);
  const offsets = payloads.map((_, index) => dataOrigin + index * gap);
  const header = Buffer.alloc(tableOffset + layers * 36);
  header.writeUInt32LE(0x12fd0086, 0);
  header.writeFloatLE(width * PIXEL_MM, 0x08);
  header.writeFloatLE(height * PIXEL_MM, 0x0c);
  header.writeFloatLE(layers * LAYER_MM, 0x10);
  header.writeFloatLE(LAYER_MM, 0x20);
  header.writeUInt32LE(width, 0x34);
  header.writeUInt32LE(height, 0x38);
  header.writeUInt32LE(tableOffset, 0x40);
  header.writeUInt32LE(layers, 0x44);
  payloads.forEach((layer, index) => {
    const at = tableOffset + index * 36;
    header.writeUInt32LE(offsets[index]!, at + 12);
    header.writeUInt32LE(layer.length, at + 16);
  });

  const startRss = process.memoryUsage().rss;
  let peakRss = startRss;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  const timer = setInterval(sample, 15);
  let maxRead = 0;
  let bytesRead = 0;
  let reads = 0;
  const started = Date.now();
  try {
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
      sample();
      return out;
    }, STREAM_PLATE_BYTES);
    sample();
    if (glb.length < 100 || glb.subarray(0, 4).toString() !== "glTF") throw new Error("empty mesh");
    const inspected = inspectGlb(glb);
    return {
      peakRss,
      startRss,
      maxRead,
      bytesRead,
      reads,
      glbBytes: glb.length,
      triangles: inspected.triangles,
      components: inspected.components,
      thinSupports: inspected.thinSupports,
      agreement: inspected.agreement,
      manifold: inspected.manifold,
      ms: Date.now() - started,
    };
  } finally {
    clearInterval(timer);
  }
}

const direct = process.argv[1]?.endsWith("plate-mesh-stream.ts") === true;
if (direct) {
  streamLargePlate()
    .then((result) => {
      console.log(JSON.stringify(result));
      const budget = 1024 * 1024 * 1024;
      if (
        result.peakRss > budget ||
        result.maxRead > RANGE_CAP ||
        result.bytesRead > 32 * 1024 * 1024 ||
        result.glbBytes > 8 * 1024 * 1024 ||
        result.triangles < 1_000 ||
        result.components < 3 ||
        result.thinSupports < 1
      ) {
        process.exit(1);
      }
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
