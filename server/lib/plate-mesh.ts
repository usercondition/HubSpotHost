/**
 * One-time mesh from a CTB plate. Layers are decoded one at a time into a coarse grid.
 * The layer walker is the same one the scanner uses.
 */
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
export const MESH_LONG_SIDE = 192;
export const MESH_BYTE_BUDGET = 4 * 1024 * 1024;

type RangeRead = (start: number, length: number) => Promise<Buffer | null>;

function fillLayer(
  voxels: Uint8Array,
  rle: Uint8Array,
  width: number,
  height: number,
  gx: number,
  gy: number,
  bin: number,
  z: number,
): void {
  walkCtbRle(rle, width * height, (start, stride, gray) => {
    if (gray === 0 || stride < 1) return;
    const end = Math.min(start + stride, width * height);
    let cursor = start;
    while (cursor < end) {
      const x = cursor % width;
      const y = (cursor / width) | 0;
      const bx = Math.min(gx - 1, (x / bin) | 0);
      const by = Math.min(gy - 1, (y / bin) | 0);
      voxels[bx + by * gx + z * gx * gy] = 1;
      const nextX = Math.min(width, (bx + 1) * bin);
      const rowEnd = (y + 1) * width;
      const jump = Math.max(1, nextX - x);
      cursor = cursor + jump >= rowEnd ? rowEnd : cursor + jump;
    }
  });
}

function greedyQuads(voxels: Uint8Array, dims: [number, number, number], zScale: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const mask = new Int8Array(Math.max(dims[0] * dims[1], dims[1] * dims[2], dims[0] * dims[2]));
  const at = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return 0;
    return voxels[x + dims[0] * (y + dims[1] * z)] ? 1 : 0;
  };
  for (let d = 0; d < 3; d += 1) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const dimsU = dims[u]!;
    const dimsV = dims[v]!;
    const cursor = [0, 0, 0];
    for (cursor[d] = -1; cursor[d]! < dims[d]!; ) {
      let n = 0;
      for (cursor[v] = 0; cursor[v]! < dimsV; cursor[v]! += 1) {
        for (cursor[u] = 0; cursor[u]! < dimsU; cursor[u]! += 1) {
          const a = cursor[d]! >= 0 ? at(cursor[0]!, cursor[1]!, cursor[2]!) : 0;
          const ahead = [cursor[0]!, cursor[1]!, cursor[2]!];
          ahead[d] = (ahead[d] ?? 0) + 1;
          const b = ahead[d]! < dims[d]! ? at(ahead[0]!, ahead[1]!, ahead[2]!) : 0;
          mask[n] = a === b ? 0 : a ? 1 : -1;
          n += 1;
        }
      }
      cursor[d]! += 1;
      n = 0;
      for (let j = 0; j < dimsV; j += 1) {
        for (let i = 0; i < dimsU; ) {
          const c = mask[n] ?? 0;
          if (c === 0) {
            i += 1;
            n += 1;
            continue;
          }
          let w = 1;
          while (i + w < dimsU && mask[n + w] === c) w += 1;
          let h = 1;
          while (j + h < dimsV) {
            let same = true;
            for (let k = 0; k < w; k += 1) {
              if (mask[n + k + h * dimsU] !== c) {
                same = false;
                break;
              }
            }
            if (!same) break;
            h += 1;
          }
          const origin = [0, 0, 0];
          origin[d] = cursor[d]!;
          origin[u] = i;
          origin[v] = j;
          const du = [0, 0, 0];
          du[u] = w;
          const dv = [0, 0, 0];
          dv[v] = h;
          const corner = (ox: number, oy: number, oz: number): [number, number, number] => [ox, oz * zScale, oy];
          const v0 = corner(origin[0]!, origin[1]!, origin[2]!);
          const v1 = corner(origin[0]! + du[0]!, origin[1]! + du[1]!, origin[2]! + du[2]!);
          const v2 = corner(origin[0]! + du[0]! + dv[0]!, origin[1]! + du[1]! + dv[1]!, origin[2]! + du[2]! + dv[2]!);
          const v3 = corner(origin[0]! + dv[0]!, origin[1]! + dv[1]!, origin[2]! + dv[2]!);
          const base = positions.length / 3;
          for (const vert of [v0, v1, v2, v3]) positions.push(vert[0], vert[1], vert[2]);
          if (c > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          else indices.push(base, base + 3, base + 2, base, base + 2, base + 1);
          for (let l = 0; l < h; l += 1) {
            for (let k = 0; k < w; k += 1) mask[n + k + l * dimsU] = 0;
          }
          i += w;
          n += w;
        }
      }
    }
  }
  return { positions, indices };
}

function pad4(bytes: Buffer, fill: number): Buffer {
  const extra = (4 - (bytes.length % 4)) % 4;
  if (extra === 0) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(extra, fill)]);
}

function glbFromSurface(gx: number, gy: number, positions: number[], indices: number[]): Buffer {
  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!;
    const y = pos[i + 1]!;
    const z = pos[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const posBytes = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);
  const idxBytes = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength);
  const bin = Buffer.concat([posBytes, idxBytes]);
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { plate: [gx, gy] } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [
      {
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.55, 0.62, 0.52, 1],
          metallicFactor: 0.05,
          roughnessFactor: 0.7,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: pos.length / 3,
        type: "VEC3",
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  });
  const jsonChunk = pad4(Buffer.from(json), 0x20);
  const binChunk = pad4(bin, 0);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const binAt = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binAt);
  out.writeUInt32LE(0x004e4942, binAt + 4);
  binChunk.copy(out, binAt + 8);
  return out;
}

async function meshPass(
  readRange: RangeRead,
  plan: CtbLayerPlan,
  entries: CtbLayerEntry[],
  spans: Map<number, CtbEncryptedSpan>,
  longSide: number,
): Promise<Buffer> {
  const bin = Math.max(1, Math.ceil(Math.max(plan.width, plan.height) / longSide));
  const gx = Math.max(1, Math.ceil(plan.width / bin));
  const gy = Math.max(1, Math.ceil(plan.height / bin));
  const step = Math.max(1, Math.ceil(plan.layerCount / longSide));
  const gz = Math.max(1, Math.ceil(plan.layerCount / step));
  const voxels = new Uint8Array(gx * gy * gz);
  const zScale = step / bin;
  for (let layer = 0; layer < plan.layerCount; layer += step) {
    const z = Math.min(gz - 1, Math.floor(layer / step));
    const bytes = await readCtbLayerBytes(readRange, plan, entries, spans, layer);
    fillLayer(voxels, bytes, plan.width, plan.height, gx, gy, bin, z);
  }
  const last = plan.layerCount - 1;
  if (last > 0 && last % step !== 0) {
    const bytes = await readCtbLayerBytes(readRange, plan, entries, spans, last);
    fillLayer(voxels, bytes, plan.width, plan.height, gx, gy, bin, gz - 1);
  }
  let any = false;
  for (let i = 0; i < voxels.length; i += 1) {
    if (voxels[i]) {
      any = true;
      break;
    }
  }
  if (!any) return Buffer.alloc(0);
  const surface = greedyQuads(voxels, [gx, gy, gz], zScale);
  if (surface.indices.length < 3) return Buffer.alloc(0);
  return glbFromSurface(gx, gy, surface.positions, surface.indices);
}

/** Decode sampled layers into a GLB. An empty plate returns a zero-length buffer. */
export async function buildPlateGlb(readRange: RangeRead, size: number, longSide = MESH_LONG_SIDE): Promise<Buffer> {
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
  const entries = ctbLayerEntries(plan, table, size);
  const spans = new Map<number, CtbEncryptedSpan>();
  const first = await meshPass(readRange, plan, entries, spans, longSide);
  if (first.length === 0 || first.length <= MESH_BYTE_BUDGET) return first;
  const coarser = await meshPass(readRange, plan, entries, spans, Math.max(48, Math.floor(longSide / 2)));
  if (coarser.length > 0 && coarser.length < first.length) return coarser;
  return first;
}
