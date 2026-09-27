/**
 * One-time mesh from a CTB plate. Layers are decoded one at a time into a
 * cropped bit grid, then turned into a smooth surface. One job, ranged reads.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { walkCtbRle } from "../../shared/ctb-rle";
import {
  createBufferCtbReader,
  createPrefixCtbReader,
  ctbLayerEntries,
  ctbLayerPlan,
  readCtbLayerBytes,
  type CtbEncryptedSpan,
  type CtbLayerEntry,
  type CtbLayerPlan,
} from "./ctb";

const PREFIX_BYTES = 8 * 1024 * 1024;
/** About 0.35 mm, inside the 0.3–0.4 mm band. Coarsened only if the grid would exceed the chunk budget. */
export const MESH_VOXEL_MM = 0.35;
export const MESH_BYTE_BUDGET = 8 * 1024 * 1024;
/** Bumped when the mesher changes so backfill rebuilds plates marked ready by an older pass. */
export const PLATE_MESH_VERSION = 3;
const CHUNK = 32;
const CHUNK_BUDGET = 256 * 1024 * 1024;
const CHUNK_STRIDE = 1_000_000;

type RangeRead = (start: number, length: number) => Promise<Buffer | null>;

interface Grid {
  binX: number;
  binY: number;
  step: number;
  gx: number;
  gy: number;
  gz: number;
}

interface Origin {
  x: number;
  y: number;
  z: number;
}

class SparseBits {
  private readonly chunks = new Map<number, Uint32Array>();
  solids = 0;

  pack(): { keys: Float64Array; chunks: Uint32Array[] } {
    const keys = new Float64Array(this.chunks.size);
    const chunks: Uint32Array[] = [];
    let index = 0;
    for (const [key, chunk] of this.chunks) {
      keys[index] = key;
      chunks.push(chunk);
      index += 1;
    }
    return { keys, chunks };
  }

  set(x: number, y: number, z: number): void {
    if (x < 0 || y < 0 || z < 0) return;
    const cx = x >> 5;
    const cy = y >> 5;
    const cz = z >> 5;
    const key = cx + cy * CHUNK_STRIDE + cz * CHUNK_STRIDE * CHUNK_STRIDE;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (this.chunks.size * CHUNK * CHUNK * 4 >= CHUNK_BUDGET) return;
      chunk = new Uint32Array(CHUNK * CHUNK);
      this.chunks.set(key, chunk);
    }
    const bit = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
    const word = bit >> 5;
    const mask = 1 << (bit & 31);
    if ((chunk[word]! & mask) !== 0) return;
    chunk[word] = (chunk[word]! | mask) >>> 0;
    this.solids += 1;
  }

  get(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || z < 0) return false;
    const key = (x >> 5) + (y >> 5) * CHUNK_STRIDE + (z >> 5) * CHUNK_STRIDE * CHUNK_STRIDE;
    const chunk = this.chunks.get(key);
    if (!chunk) return false;
    const bit = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
    return (chunk[bit >> 5]! & (1 << (bit & 31))) !== 0;
  }

  forEach(visit: (x: number, y: number, z: number) => void): void {
    for (const [key, chunk] of this.chunks) {
      const cz = Math.floor(key / (CHUNK_STRIDE * CHUNK_STRIDE));
      const cy = Math.floor((key % (CHUNK_STRIDE * CHUNK_STRIDE)) / CHUNK_STRIDE);
      const cx = key % CHUNK_STRIDE;
      const ox = cx * CHUNK;
      const oy = cy * CHUNK;
      const oz = cz * CHUNK;
      for (let word = 0; word < chunk.length; word += 1) {
        let value = chunk[word]!;
        while (value) {
          const lowest = value & -value;
          const bit = 31 - Math.clz32(lowest);
          const index = word * 32 + bit;
          visit(ox + (index & 31), oy + ((index >> 5) & 31), oz + (index >> 10));
          value &= value - 1;
        }
      }
    }
  }
}

function chunkBytes(gx: number, gy: number, gz: number): number {
  const cells = Math.ceil(gx / CHUNK) * Math.ceil(gy / CHUNK) * Math.ceil(gz / CHUNK);
  if (!Number.isFinite(cells)) return Number.POSITIVE_INFINITY;
  return cells * CHUNK * CHUNK * 4;
}

function chooseGrid(width: number, height: number, layers: number, pixelMmX: number, pixelMmY: number, layerMm: number): Grid {
  let voxel = MESH_VOXEL_MM;
  let grid: Grid = { binX: 1, binY: 1, step: 1, gx: 1, gy: 1, gz: 1 };
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const binX = Math.max(1, Math.round(voxel / pixelMmX));
    const binY = Math.max(1, Math.round(voxel / pixelMmY));
    const step = Math.max(1, Math.round(voxel / layerMm));
    const gx = Math.max(1, Math.ceil(width / binX));
    const gy = Math.max(1, Math.ceil(height / binY));
    const gz = Math.max(1, Math.ceil(layers / step));
    grid = { binX, binY, step, gx, gy, gz };
    if (chunkBytes(gx, gy, gz) <= CHUNK_BUDGET) return grid;
    if (binX >= width && binY >= height && step >= layers) return grid;
    voxel *= 1.5;
  }
  return grid;
}

function paintRun(bits: SparseBits, start: number, stride: number, width: number, grid: Grid, origin: Origin, z: number): void {
  const end = start + stride;
  const yLimit = origin.y + grid.gy * grid.binY;
  let cursor = start;
  while (cursor < end) {
    const x = cursor % width;
    const y = (cursor / width) | 0;
    const rowEnd = Math.min(end, (y + 1) * width);
    if (y < origin.y || y >= yLimit || x >= origin.x + grid.gx * grid.binX) {
      cursor = rowEnd;
      continue;
    }
    if (x < origin.x) {
      cursor = Math.min(rowEnd, cursor + (origin.x - x));
      continue;
    }
    const bx = ((x - origin.x) / grid.binX) | 0;
    const by = ((y - origin.y) / grid.binY) | 0;
    if (bx >= 0 && by >= 0 && bx < grid.gx && by < grid.gy) bits.set(bx, by, z);
    const nextPixel = origin.x + (bx + 1) * grid.binX;
    cursor = Math.min(rowEnd, cursor + Math.max(1, nextPixel - x));
  }
}

let yieldedAt = 0;

async function breathe(): Promise<void> {
  const now = Date.now();
  if (yieldedAt !== 0 && now - yieldedAt < 40) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  yieldedAt = Date.now();
}

async function raster(
  readRange: RangeRead,
  plan: CtbLayerPlan,
  entries: CtbLayerEntry[],
  spans: Map<number, CtbEncryptedSpan>,
  bits: SparseBits,
  grid: Grid,
  origin: Origin,
): Promise<void> {
  const paint = async (layer: number) => {
    await breathe();
    const z = Math.floor((layer - origin.z) / grid.step);
    if (z < 0 || z >= grid.gz) return;
    const bytes = await readCtbLayerBytes(readRange, plan, entries, spans, layer);
    walkCtbRle(bytes, plan.width * plan.height, (start, stride, gray) => {
      if (gray === 0 || stride < 1) return;
      paintRun(bits, start, Math.min(stride, plan.width * plan.height - start), plan.width, grid, origin, z);
    });
  };
  for (let layer = origin.z; layer < plan.layerCount; layer += grid.step) await paint(layer);
  const last = plan.layerCount - 1;
  if (last > origin.z && (last - origin.z) % grid.step !== 0) await paint(last);
}

interface PixelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minL: number;
  maxL: number;
}

async function scanBounds(
  readRange: RangeRead,
  plan: CtbLayerPlan,
  entries: CtbLayerEntry[],
  spans: Map<number, CtbEncryptedSpan>,
  step: number,
): Promise<PixelBounds | null> {
  const bounds: PixelBounds = { minX: Infinity, maxX: -1, minY: Infinity, maxY: -1, minL: Infinity, maxL: -1 };
  const touch = (layer: number) => async () => {
    await breathe();
    const bytes = await readCtbLayerBytes(readRange, plan, entries, spans, layer);
    let hit = false;
    walkCtbRle(bytes, plan.width * plan.height, (start, stride, gray) => {
      if (gray === 0 || stride < 1) return;
      hit = true;
      const end = Math.min(plan.width * plan.height - 1, start + stride - 1);
      const y0 = (start / plan.width) | 0;
      const y1 = (end / plan.width) | 0;
      const x0 = start % plan.width;
      const x1 = end % plan.width;
      if (y0 === y1) {
        if (x0 < bounds.minX) bounds.minX = x0;
        if (x1 > bounds.maxX) bounds.maxX = x1;
      } else {
        bounds.minX = 0;
        bounds.maxX = plan.width - 1;
      }
      if (y0 < bounds.minY) bounds.minY = y0;
      if (y1 > bounds.maxY) bounds.maxY = y1;
    });
    if (!hit) return;
    if (layer < bounds.minL) bounds.minL = layer;
    if (layer > bounds.maxL) bounds.maxL = layer;
  };
  for (let layer = 0; layer < plan.layerCount; layer += step) await touch(layer)();
  const last = plan.layerCount - 1;
  if (last > 0 && last % step !== 0) await touch(last)();
  if (bounds.maxX < 0) return null;
  return bounds;
}

const meshWorkerFile: Promise<string> = (async () => {
  const source = typeof import.meta.url === "string" ? import.meta.url : "";
  if (!source.includes("/server/lib/plate-mesh.ts")) return join(process.cwd(), "dist", "plate-mesh-worker.cjs");
  const outfile = join(tmpdir(), `plate-mesh-worker-${process.pid}.cjs`);
  const specifier = "es" + "build";
  const compiler = (await import(specifier)) as { build(options: object): Promise<unknown> };
  await compiler.build({
    entryPoints: [fileURLToPath(new URL("./plate-mesh-worker.ts", source))],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  return outfile;
})();

function openMeshWorker(file: string): Worker {
  return new Worker(file, { execArgv: [] });
}

function surfaceOnWorker(bits: SparseBits, plan: CtbLayerPlan, grid: Grid, origin: Origin): Promise<Buffer> {
  if (bits.solids < 1) return Promise.resolve(Buffer.alloc(0));
  const packed = bits.pack();
  return meshWorkerFile.then(
    (file) =>
      new Promise((resolve, reject) => {
        const worker = openMeshWorker(file);
        let settled = false;
        const timer = setTimeout(() => finish(() => reject(new Error("mesh worker timed out"))), 8 * 60 * 1000);
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
          void worker.terminate();
        };
        worker.once("message", (message: Uint8Array | { error?: string }) => {
          if (message && typeof message === "object" && "error" in message && message.error) {
            finish(() => reject(new Error(message.error)));
            return;
          }
          const bytes = Buffer.from(message as Uint8Array);
          finish(() => resolve(bytes.length > 20 ? bytes : Buffer.alloc(0)));
        });
        worker.once("error", (error) => finish(() => reject(error)));
        worker.once("exit", (code) => {
          if (!settled && code !== 0) finish(() => reject(new Error(`mesh worker exited ${code}`)));
        });
        const transfers: ArrayBuffer[] = [packed.keys.buffer as ArrayBuffer];
        for (const chunk of packed.chunks) transfers.push(chunk.buffer as ArrayBuffer);
        worker.postMessage(
          {
            keys: packed.keys,
            chunks: packed.chunks,
            scale: {
              binX: grid.binX,
              binY: grid.binY,
              step: grid.step,
              pixelMmX: plan.pixelMmX,
              pixelMmY: plan.pixelMmY,
              layerMm: plan.layerMm,
              originX: origin.x,
              originY: origin.y,
              originZ: origin.z,
            },
            gx: grid.gx,
            gy: grid.gy,
            gz: grid.gz,
            plateMmX: plan.plateMmX,
            plateMmY: plan.plateMmY,
            budget: MESH_BYTE_BUDGET,
          },
          transfers,
        );
      }),
  );
}

async function loadLayerIndex(readRange: RangeRead, size: number): Promise<{ plan: CtbLayerPlan; entries: CtbLayerEntry[] }> {
  const prefixLen = Math.min(PREFIX_BYTES, Math.max(0, size));
  const prefix = await readRange(0, prefixLen);
  if (!prefix || prefix.length < 0x50) throw new Error("That plate has no layer preview.");
  const reader = prefix.length >= size ? createBufferCtbReader(prefix.subarray(0, size)) : createPrefixCtbReader(prefix, size);
  const plan = ctbLayerPlan(reader);
  let table = reader.read(plan.tableOffset, plan.tableBytes);
  if (!table) {
    const fetched = await readRange(plan.tableOffset, plan.tableBytes);
    if (!fetched || fetched.length < plan.tableBytes) throw new Error("That plate has no layer preview.");
    table = fetched;
  }
  return { plan, entries: ctbLayerEntries(plan, table, size) };
}

/** Decode sampled layers into a GLB. An empty plate returns a zero-length buffer. */
export async function buildPlateGlb(readRange: RangeRead, size: number): Promise<Buffer> {
  yieldedAt = 0;
  const { plan, entries } = await loadLayerIndex(readRange, size);
  const spans = new Map<number, CtbEncryptedSpan>();
  const full = chooseGrid(plan.width, plan.height, plan.layerCount, plan.pixelMmX, plan.pixelMmY, plan.layerMm);
  const origin: Origin = { x: 0, y: 0, z: 0 };
  if (chunkBytes(full.gx, full.gy, full.gz) <= CHUNK_BUDGET) {
    const bits = new SparseBits();
    await raster(readRange, plan, entries, spans, bits, full, origin);
    return surfaceOnWorker(bits, plan, full, origin);
  }
  const bounds = await scanBounds(readRange, plan, entries, spans, full.step);
  if (!bounds) return Buffer.alloc(0);
  const cropped = chooseGrid(
    bounds.maxX - bounds.minX + 1,
    bounds.maxY - bounds.minY + 1,
    bounds.maxL - bounds.minL + 1,
    plan.pixelMmX,
    plan.pixelMmY,
    plan.layerMm,
  );
  const cropOrigin: Origin = { x: bounds.minX, y: bounds.minY, z: bounds.minL };
  const bits = new SparseBits();
  await raster(readRange, plan, entries, spans, bits, cropped, cropOrigin);
  return surfaceOnWorker(bits, plan, cropped, cropOrigin);
}
