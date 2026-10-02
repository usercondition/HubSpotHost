/**
 * Surface nets, one crease-preserving smooth, and quadric simplification.
 * The mesh worker is the only caller. GLBs are meshopt-compressed.
 */
import { MeshoptEncoder } from "meshoptimizer/encoder";

const CHUNK = 32;
const CHUNK_STRIDE = 1_000_000;
/** Faces whose normals differ by more than this stay split, so bolts and panel edges stay crisp. */
const CREASE_DOT = Math.cos((40 * Math.PI) / 180);
const SMOOTH_FACTOR = 0.15;
/** A few million keeps a desktop view sharp without making the viewer struggle. The byte cap still applies. */
const TARGET_TRIS = 4_000_000;

export interface Occupancy {
  forEach(visit: (x: number, y: number, z: number) => void): void;
  get(x: number, y: number, z: number): boolean;
}

export interface MeshScale {
  binX: number;
  binY: number;
  step: number;
  pixelMmX: number;
  pixelMmY: number;
  layerMm: number;
  originX: number;
  originY: number;
  originZ: number;
}

export interface PlateSurface {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

interface RawMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Read-only sorted view of the chunked bit grid. No JS Map grows with a full plate. */
export function occupancyFromChunks(keys: ArrayLike<number>, chunks: Uint32Array[]): Occupancy {
  const find = (key: number): number => {
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = keys[mid]!;
      if (value === key) return mid;
      if (value < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };
  const get = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0) return false;
    const key = (x >> 5) + (y >> 5) * CHUNK_STRIDE + (z >> 5) * CHUNK_STRIDE * CHUNK_STRIDE;
    const index = find(key);
    const chunk = index < 0 ? undefined : chunks[index];
    if (!chunk) return false;
    const bit = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
    return (chunk[bit >> 5]! & (1 << (bit & 31))) !== 0;
  };
  return {
    get,
    forEach(visit) {
      for (let chunkIndex = 0; chunkIndex < keys.length; chunkIndex += 1) {
        const key = keys[chunkIndex]!;
        const chunk = chunks[chunkIndex]!;
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
    },
  };
}

export function meshSurface(occupancy: Occupancy, scale: MeshScale, gx: number, gy: number, gz: number, smooth = true): RawMesh | null {
  const raw = surfaceNets(occupancy, gx, gy, gz);
  if (!raw || raw.indices.length < 3) return null;
  if (smooth) smoothCrease(raw.positions, raw.indices);
  toMillimeters(raw.positions, scale);
  return raw;
}

const MAX_SURFACE_CELLS = 8_000_000;

/** Open-addressed typed lookup for sparse surface cells. Keys are safe integer grid offsets. */
class SparseCellIndex {
  private keys = new Float64Array(1024);
  private values = new Int32Array(1024);
  private used = 0;

  constructor() {
    this.keys.fill(Number.NaN);
    this.values.fill(-1);
  }

  private slot(key: number, keys = this.keys): number {
    const mask = keys.length - 1;
    const low = Math.floor(key % keys.length);
    const high = Math.floor(key / keys.length) % keys.length;
    let slot = Math.imul(low ^ high, 0x9e3779b1) & mask;
    while (!Number.isNaN(keys[slot]!) && keys[slot] !== key) slot = (slot + 1) & mask;
    return slot;
  }

  get(key: number): number {
    const slot = this.slot(key);
    return this.keys[slot] === key ? this.values[slot]! : -1;
  }

  set(key: number, value: number): void {
    if (this.used >= MAX_SURFACE_CELLS) throw new Error("Plate mesh surface exceeds its typed-cell budget.");
    if ((this.used + 1) * 10 >= this.keys.length * 7) this.grow();
    const slot = this.slot(key);
    if (Number.isNaN(this.keys[slot]!)) this.used += 1;
    this.keys[slot] = key;
    this.values[slot] = value;
  }

  private grow(): void {
    if (this.used >= MAX_SURFACE_CELLS) throw new Error("Plate mesh surface exceeds its typed-cell budget.");
    const next = new Float64Array(this.keys.length * 2);
    const values = new Int32Array(next.length);
    next.fill(Number.NaN);
    values.fill(-1);
    const oldKeys = this.keys;
    const oldValues = this.values;
    this.keys = next;
    this.values = values;
    for (let index = 0; index < oldKeys.length; index += 1) {
      const key = oldKeys[index]!;
      if (Number.isNaN(key)) continue;
      const slot = this.slot(key, next);
      next[slot] = key;
      values[slot] = oldValues[index]!;
    }
  }
}

function surfaceNets(occupancy: Occupancy, gx: number, gy: number, gz: number): RawMesh | null {
  const strideY = gx + 4;
  const strideZ = strideY * (gy + 4);
  /** Sparse typed hash: indexes surface cells, never the full CTB volume or a JS Map. */
  const cellOf = new SparseCellIndex();
  let sx = new Float64Array(256);
  let sy = new Float64Array(256);
  let sz = new Float64Array(256);
  let sn = new Uint8Array(256);
  let cells = 0;
  let quads = new Uint32Array(1024);
  let qn = 0;

  const growCells = () => {
    const n = sx.length * 2;
    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    const nz = new Float64Array(n);
    const nn = new Uint8Array(n);
    nx.set(sx);
    ny.set(sy);
    nz.set(sz);
    nn.set(sn);
    sx = nx;
    sy = ny;
    sz = nz;
    sn = nn;
  };

  const cell = (x: number, y: number, z: number): number => {
    const key = x + 1 + (y + 1) * strideY + (z + 1) * strideZ;
    const found = cellOf.get(key);
    if (found >= 0) return found;
    const index = cells;
    cells += 1;
    if (index >= sx.length) growCells();
    cellOf.set(key, index);
    return index;
  };

  const pushQuad = (a: number, b: number, c: number, d: number) => {
    if (a === b || a === c || a === d || b === c || b === d || c === d) return;
    if (qn + 4 > quads.length) {
      const next = new Uint32Array(quads.length * 2);
      next.set(quads);
      quads = next;
    }
    quads[qn] = a;
    quads[qn + 1] = b;
    quads[qn + 2] = c;
    quads[qn + 3] = d;
    qn += 4;
  };

  const addEdge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const mz = (az + bz) / 2;
    const x0 = Math.min(ax, bx);
    const y0 = Math.min(ay, by);
    const z0 = Math.min(az, bz);
    const around: Array<[number, number, number]> =
      ax !== bx
        ? [
            [x0, y0, z0],
            [x0, y0 - 1, z0],
            [x0, y0, z0 - 1],
            [x0, y0 - 1, z0 - 1],
          ]
        : ay !== by
          ? [
              [x0, y0, z0],
              [x0 - 1, y0, z0],
              [x0, y0, z0 - 1],
              [x0 - 1, y0, z0 - 1],
            ]
          : [
              [x0, y0, z0],
              [x0 - 1, y0, z0],
              [x0, y0 - 1, z0],
              [x0 - 1, y0 - 1, z0],
            ];
    const corners = windOutward(around, bx - ax, by - ay, bz - az, mx, my, mz);
    const ids = corners.map(([x, y, z]) => {
      const index = cell(x, y, z);
      sx[index] = (sx[index] ?? 0) + mx;
      sy[index] = (sy[index] ?? 0) + my;
      sz[index] = (sz[index] ?? 0) + mz;
      sn[index] = ((sn[index] ?? 0) + 1) as number;
      return index;
    });
    pushQuad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
  };

  const dirs: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  occupancy.forEach((x, y, z) => {
    for (const [dx, dy, dz] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx >= 0 && ny >= 0 && nz >= 0 && nx < gx && ny < gy && nz < gz && occupancy.get(nx, ny, nz)) continue;
      addEdge(x, y, z, nx, ny, nz);
    }
  });
  if (cells < 4 || qn < 4) return null;

  const positions = new Float32Array(cells * 3);
  for (let i = 0; i < cells; i += 1) {
    const n = sn[i] || 1;
    positions[i * 3] = (sx[i] ?? 0) / n;
    positions[i * 3 + 1] = (sy[i] ?? 0) / n;
    positions[i * 3 + 2] = (sz[i] ?? 0) / n;
  }
  const quadCount = qn / 4;
  const indices = new Uint32Array(quadCount * 6);
  let t = 0;
  for (let q = 0; q < qn; q += 4) {
    const a = quads[q]!;
    const b = quads[q + 1]!;
    const c = quads[q + 2]!;
    const d = quads[q + 3]!;
    indices[t] = a;
    indices[t + 1] = b;
    indices[t + 2] = c;
    indices[t + 3] = a;
    indices[t + 4] = c;
    indices[t + 5] = d;
    t += 6;
  }
  return { positions, indices };
}

/** Order the four cells around a crossing so the quad normal points toward empty space. */
function windOutward(
  cells: Array<[number, number, number]>,
  ox: number,
  oy: number,
  oz: number,
  ex: number,
  ey: number,
  ez: number,
): Array<[number, number, number]> {
  let ux = 0;
  let uy = 0;
  let uz = 0;
  if (Math.abs(ox) > 0.5) uy = 1;
  else ux = 1;
  const vx = oy * uz - oz * uy;
  const vy = oz * ux - ox * uz;
  const vz = ox * uy - oy * ux;
  const ordered = cells
    .map((cell) => {
      const dx = cell[0] + 0.5 - ex;
      const dy = cell[1] + 0.5 - ey;
      const dz = cell[2] + 0.5 - ez;
      return { cell, ang: Math.atan2(dx * vx + dy * vy + dz * vz, dx * ux + dy * uy + dz * uz) };
    })
    .sort((left, right) => left.ang - right.ang)
    .map((item) => item.cell);
  const a = ordered[0]!;
  const b = ordered[1]!;
  const c = ordered[2]!;
  const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (nx * ox + ny * oy + nz * oz < 0) ordered.reverse();
  return ordered;
}

function triangleNormal(positions: Float32Array, indices: Uint32Array, triangle: number): [number, number, number] {
  const a = indices[triangle * 3]! * 3;
  const b = indices[triangle * 3 + 1]! * 3;
  const c = indices[triangle * 3 + 2]! * 3;
  const abx = (positions[b] ?? 0) - (positions[a] ?? 0);
  const aby = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0);
  const abz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0);
  const acx = (positions[c] ?? 0) - (positions[a] ?? 0);
  const acy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0);
  const acz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** One light laplacian pass. Edges sharper than the crease angle are left alone. */
function smoothCrease(positions: Float32Array, indices: Uint32Array): void {
  const verts = positions.length / 3;
  const tris = indices.length / 3;
  const face = new Float32Array(tris * 3);
  const edgeFace = new Map<number, number>();
  const edgeMate = new Map<number, number>();
  for (let t = 0; t < tris; t += 1) {
    const normal = triangleNormal(positions, indices, t);
    face[t * 3] = normal[0];
    face[t * 3 + 1] = normal[1];
    face[t * 3 + 2] = normal[2];
    const tri = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!];
    for (let e = 0; e < 3; e += 1) {
      let a = tri[e]!;
      let b = tri[(e + 1) % 3]!;
      if (a > b) {
        const swap = a;
        a = b;
        b = swap;
      }
      const key = a + b * verts;
      if (!edgeFace.has(key)) edgeFace.set(key, t);
      else edgeMate.set(key, t);
    }
  }
  const acc = new Float32Array(positions.length);
  const counts = new Int32Array(verts);
  for (const [key, t0] of edgeFace) {
    const t1 = edgeMate.get(key);
    if (t1 === undefined) continue;
    const dot =
      (face[t0 * 3] ?? 0) * (face[t1 * 3] ?? 0) +
      (face[t0 * 3 + 1] ?? 0) * (face[t1 * 3 + 1] ?? 0) +
      (face[t0 * 3 + 2] ?? 0) * (face[t1 * 3 + 2] ?? 0);
    if (dot < CREASE_DOT) continue;
    const a = key % verts;
    const b = (key - a) / verts;
    acc[a * 3] = (acc[a * 3] ?? 0) + (positions[b * 3] ?? 0);
    acc[a * 3 + 1] = (acc[a * 3 + 1] ?? 0) + (positions[b * 3 + 1] ?? 0);
    acc[a * 3 + 2] = (acc[a * 3 + 2] ?? 0) + (positions[b * 3 + 2] ?? 0);
    acc[b * 3] = (acc[b * 3] ?? 0) + (positions[a * 3] ?? 0);
    acc[b * 3 + 1] = (acc[b * 3 + 1] ?? 0) + (positions[a * 3 + 1] ?? 0);
    acc[b * 3 + 2] = (acc[b * 3 + 2] ?? 0) + (positions[a * 3 + 2] ?? 0);
    counts[a] = (counts[a] ?? 0) + 1;
    counts[b] = (counts[b] ?? 0) + 1;
  }
  for (let v = 0; v < verts; v += 1) {
    const n = counts[v] ?? 0;
    if (n < 1) continue;
    positions[v * 3] = (positions[v * 3] ?? 0) * (1 - SMOOTH_FACTOR) + ((acc[v * 3] ?? 0) / n) * SMOOTH_FACTOR;
    positions[v * 3 + 1] = (positions[v * 3 + 1] ?? 0) * (1 - SMOOTH_FACTOR) + ((acc[v * 3 + 1] ?? 0) / n) * SMOOTH_FACTOR;
    positions[v * 3 + 2] = (positions[v * 3 + 2] ?? 0) * (1 - SMOOTH_FACTOR) + ((acc[v * 3 + 2] ?? 0) / n) * SMOOTH_FACTOR;
  }
}

function toMillimeters(positions: Float32Array, scale: MeshScale): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    positions[i] = (scale.originX + x * scale.binX) * scale.pixelMmX;
    positions[i + 1] = (scale.originZ + z * scale.step) * scale.layerMm;
    positions[i + 2] = (scale.originY + y * scale.binY) * scale.pixelMmY;
  }
}

function quadricDecimate(mesh: RawMesh, targetTris: number): RawMesh {
  const srcPos = mesh.positions;
  const vertCount = srcPos.length / 3;
  const triCount = mesh.indices.length / 3;
  if (triCount <= targetTris || vertCount < 8) return mesh;
  const px = new Float64Array(srcPos);
  const Q = new Float64Array(vertCount * 10);
  const tris = Int32Array.from(mesh.indices);
  const deadTri = new Uint8Array(triCount);
  const deadVert = new Uint8Array(vertCount);
  const adj: number[][] = Array.from({ length: vertCount }, () => []);
  let live = triCount;

  const addPlane = (v: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-12) return;
    nx /= area;
    ny /= area;
    nz /= area;
    const d = -(nx * ax + ny * ay + nz * az);
    const o = v * 10;
    Q[o] = (Q[o] ?? 0) + area * nx * nx;
    Q[o + 1] = (Q[o + 1] ?? 0) + area * nx * ny;
    Q[o + 2] = (Q[o + 2] ?? 0) + area * nx * nz;
    Q[o + 3] = (Q[o + 3] ?? 0) + area * nx * d;
    Q[o + 4] = (Q[o + 4] ?? 0) + area * ny * ny;
    Q[o + 5] = (Q[o + 5] ?? 0) + area * ny * nz;
    Q[o + 6] = (Q[o + 6] ?? 0) + area * ny * d;
    Q[o + 7] = (Q[o + 7] ?? 0) + area * nz * nz;
    Q[o + 8] = (Q[o + 8] ?? 0) + area * nz * d;
    Q[o + 9] = (Q[o + 9] ?? 0) + area * d * d;
  };

  for (let t = 0; t < triCount; t += 1) {
    const a = tris[t * 3]!;
    const b = tris[t * 3 + 1]!;
    const c = tris[t * 3 + 2]!;
    adj[a]!.push(t);
    adj[b]!.push(t);
    adj[c]!.push(t);
    addPlane(
      a,
      px[a * 3]!,
      px[a * 3 + 1]!,
      px[a * 3 + 2]!,
      px[b * 3]!,
      px[b * 3 + 1]!,
      px[b * 3 + 2]!,
      px[c * 3]!,
      px[c * 3 + 1]!,
      px[c * 3 + 2]!,
    );
    addPlane(
      b,
      px[a * 3]!,
      px[a * 3 + 1]!,
      px[a * 3 + 2]!,
      px[b * 3]!,
      px[b * 3 + 1]!,
      px[b * 3 + 2]!,
      px[c * 3]!,
      px[c * 3 + 1]!,
      px[c * 3 + 2]!,
    );
    addPlane(
      c,
      px[a * 3]!,
      px[a * 3 + 1]!,
      px[a * 3 + 2]!,
      px[b * 3]!,
      px[b * 3 + 1]!,
      px[b * 3 + 2]!,
      px[c * 3]!,
      px[c * 3 + 1]!,
      px[c * 3 + 2]!,
    );
  }

  const combined = new Float64Array(10);
  const errorAt = (a: number, b: number): number => {
    for (let k = 0; k < 10; k += 1) combined[k] = (Q[a * 10 + k] ?? 0) + (Q[b * 10 + k] ?? 0);
    const x = (px[a * 3]! + px[b * 3]!) / 2;
    const y = (px[a * 3 + 1]! + px[b * 3 + 1]!) / 2;
    const z = (px[a * 3 + 2]! + px[b * 3 + 2]!) / 2;
    const q00 = combined[0]!;
    const q01 = combined[1]!;
    const q02 = combined[2]!;
    const q03 = combined[3]!;
    const q11 = combined[4]!;
    const q12 = combined[5]!;
    const q13 = combined[6]!;
    const q22 = combined[7]!;
    const q23 = combined[8]!;
    const q33 = combined[9]!;
    let err =
      q00 * x * x +
      2 * q01 * x * y +
      2 * q02 * x * z +
      2 * q03 * x +
      q11 * y * y +
      2 * q12 * y * z +
      2 * q13 * y +
      q22 * z * z +
      2 * q23 * z +
      q33;
    return err;
  };

  const contains = (t: number, v: number) => {
    const o = t * 3;
    return tris[o] === v || tris[o + 1] === v || tris[o + 2] === v;
  };

  function sharedFaces(a: number, b: number): number {
    let n = 0;
    const list = adj[a]!;
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i]!;
      if (!deadTri[t] && contains(t, b)) n += 1;
    }
    return n;
  }

  const mark = new Int32Array(vertCount);
  let markId = 1;
  const linkOk = (a: number, b: number): boolean => {
    markId += 1;
    if (markId > 2_000_000_000) {
      mark.fill(0);
      markId = 1;
    }
    const stamp = (v: number) => {
      const list = adj[v]!;
      for (let i = 0; i < list.length; i += 1) {
        const t = list[i]!;
        if (deadTri[t]) continue;
        const o = t * 3;
        const ids = [tris[o]!, tris[o + 1]!, tris[o + 2]!];
        for (const id of ids) {
          if (id !== v) mark[id] = markId;
        }
      }
    };
    stamp(a);
    const common: number[] = [];
    const seen = new Set<number>();
    const listB = adj[b]!;
    for (let i = 0; i < listB.length; i += 1) {
      const t = listB[i]!;
      if (deadTri[t]) continue;
      const o = t * 3;
      const ids = [tris[o]!, tris[o + 1]!, tris[o + 2]!];
      for (const id of ids) {
        if (id !== b && mark[id] === markId && !seen.has(id)) {
          seen.add(id);
          common.push(id);
        }
      }
    }
    const opp = new Set<number>();
    const listA = adj[a]!;
    for (let i = 0; i < listA.length; i += 1) {
      const t = listA[i]!;
      if (deadTri[t] || !contains(t, b)) continue;
      const o = t * 3;
      const ids = [tris[o]!, tris[o + 1]!, tris[o + 2]!];
      for (const id of ids) {
        if (id !== a && id !== b) opp.add(id);
      }
    }
    if (common.length !== opp.size) return false;
    for (const id of common) {
      if (!opp.has(id)) return false;
    }
    return true;
  };

  const faceNormal = (t: number, ax: number, ay: number, az: number, replace: number): [number, number, number] => {
    const o = t * 3;
    const ids = [tris[o]!, tris[o + 1]!, tris[o + 2]!];
    const at = (id: number, axis: number) => (id === replace ? [ax, ay, az][axis]! : px[id * 3 + axis]!);
    const abx = at(ids[1]!, 0) - at(ids[0]!, 0);
    const aby = at(ids[1]!, 1) - at(ids[0]!, 1);
    const abz = at(ids[1]!, 2) - at(ids[0]!, 2);
    const acx = at(ids[2]!, 0) - at(ids[0]!, 0);
    const acy = at(ids[2]!, 1) - at(ids[0]!, 1);
    const acz = at(ids[2]!, 2) - at(ids[0]!, 2);
    return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
  };

  const flips = (a: number, b: number, mx: number, my: number, mz: number): boolean => {
    const check = (v: number, other: number) => {
      const list = adj[v]!;
      for (let i = 0; i < list.length; i += 1) {
        const t = list[i]!;
        if (deadTri[t] || contains(t, other)) continue;
        const before = faceNormal(t, 0, 0, 0, -1);
        const after = faceNormal(t, mx, my, mz, v);
        const span = before[0] * before[0] + before[1] * before[1] + before[2] * before[2];
        if (span < 1e-12) continue;
        if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) return true;
      }
      return false;
    };
    return check(a, b) || check(b, a);
  };

  const collapse = (a: number, b: number): boolean => {
    if (deadVert[a] || deadVert[b] || a === b) return false;
    const faces = sharedFaces(a, b);
    if (faces !== 2) return false;
    if (!linkOk(a, b)) return false;
    const mx = (px[a * 3]! + px[b * 3]!) / 2;
    const my = (px[a * 3 + 1]! + px[b * 3 + 1]!) / 2;
    const mz = (px[a * 3 + 2]! + px[b * 3 + 2]!) / 2;
    if (flips(a, b, mx, my, mz)) return false;
    const next: number[] = [];
    const keep = (t: number, from: number) => {
      if (deadTri[t]) return;
      if (contains(t, from === a ? b : a)) {
        deadTri[t] = 1;
        live -= 1;
        return;
      }
      if (from === b) {
        const o = t * 3;
        for (let k = 0; k < 3; k += 1) {
          if (tris[o + k] === b) tris[o + k] = a;
        }
        const i0 = tris[o]!;
        const i1 = tris[o + 1]!;
        const i2 = tris[o + 2]!;
        if (i0 === i1 || i1 === i2 || i0 === i2) {
          deadTri[t] = 1;
          live -= 1;
          return;
        }
      }
      next.push(t);
    };
    for (const t of adj[a]!) keep(t, a);
    for (const t of adj[b]!) keep(t, b);
    adj[a] = next;
    adj[b] = [];
    deadVert[b] = 1;
    px[a * 3] = mx;
    px[a * 3 + 1] = my;
    px[a * 3 + 2] = mz;
    for (let k = 0; k < 10; k += 1) Q[a * 10 + k] = (Q[a * 10 + k] ?? 0) + (Q[b * 10 + k] ?? 0);
    return true;
  };

  for (let pass = 0; pass < 14 && live > targetTris; pass += 1) {
    const edges: Array<[number, number, number]> = [];
    const seen = new Set<number>();
    for (let v = 0; v < vertCount; v += 1) {
      if (deadVert[v]) continue;
      const list = adj[v]!;
      for (let i = 0; i < list.length; i += 1) {
        const t = list[i]!;
        if (deadTri[t]) continue;
        const o = t * 3;
        const ids = [tris[o]!, tris[o + 1]!, tris[o + 2]!];
        for (let e = 0; e < 3; e += 1) {
          let a = ids[e]!;
          let b = ids[(e + 1) % 3]!;
          if (deadVert[a] || deadVert[b]) continue;
          if (a > b) {
            const swap = a;
            a = b;
            b = swap;
          }
          const key = a + b * vertCount;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push([a, b, errorAt(a, b)]);
        }
      }
    }
    edges.sort((left, right) => left[2] - right[2]);
    const touched = new Uint8Array(vertCount);
    let collapsed = 0;
    for (const [a, b] of edges) {
      if (live <= targetTris) break;
      if (touched[a] || touched[b]) continue;
      if (!collapse(a, b)) continue;
      touched[a] = 1;
      touched[b] = 1;
      collapsed += 1;
    }
    if (collapsed < 1) break;
  }

  const remap = new Int32Array(vertCount).fill(-1);
  const packed: number[] = [];
  for (let v = 0; v < vertCount; v += 1) {
    if (deadVert[v]) continue;
    remap[v] = packed.length / 3;
    packed.push(px[v * 3]!, px[v * 3 + 1]!, px[v * 3 + 2]!);
  }
  const out: number[] = [];
  for (let t = 0; t < triCount; t += 1) {
    if (deadTri[t]) continue;
    const a = remap[tris[t * 3]!]!;
    const b = remap[tris[t * 3 + 1]!]!;
    const c = remap[tris[t * 3 + 2]!]!;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  if (out.length < 3) return mesh;
  return { positions: Float32Array.from(packed), indices: Uint32Array.from(out) };
}

/** Duplicate vertices where incident faces exceed the crease angle, and give each fan its own normal. */
function splitCreases(positions: Float32Array, indices: Uint32Array): PlateSurface {
  const tris = indices.length / 3;
  const verts = positions.length / 3;
  const fnx = new Float32Array(tris);
  const fny = new Float32Array(tris);
  const fnz = new Float32Array(tris);
  for (let t = 0; t < tris; t += 1) {
    const normal = triangleNormal(positions, indices, t);
    fnx[t] = normal[0];
    fny[t] = normal[1];
    fnz[t] = normal[2];
  }
  const groups: number[][] = Array.from({ length: verts }, () => []);
  for (let corner = 0; corner < indices.length; corner += 1) groups[indices[corner]!]!.push(corner);
  const outI = new Uint32Array(indices.length);
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const nx: number[] = [];
  const ny: number[] = [];
  const nz: number[] = [];
  for (let v = 0; v < verts; v += 1) {
    const corners = groups[v]!;
    if (corners.length < 1) continue;
    const fans: number[][] = [];
    const rx: number[] = [];
    const ry: number[] = [];
    const rz: number[] = [];
    for (const corner of corners) {
      const t = (corner / 3) | 0;
      let placed = -1;
      for (let fan = 0; fan < fans.length; fan += 1) {
        const dot = (fnx[t] ?? 0) * (rx[fan] ?? 0) + (fny[t] ?? 0) * (ry[fan] ?? 0) + (fnz[t] ?? 0) * (rz[fan] ?? 0);
        if (dot >= CREASE_DOT) {
          placed = fan;
          break;
        }
      }
      if (placed < 0) {
        placed = fans.length;
        fans.push([]);
        rx.push(fnx[t] ?? 0);
        ry.push(fny[t] ?? 0);
        rz.push(fnz[t] ?? 0);
      }
      fans[placed]!.push(corner);
    }
    const x = positions[v * 3] ?? 0;
    const y = positions[v * 3 + 1] ?? 0;
    const z = positions[v * 3 + 2] ?? 0;
    for (const fan of fans) {
      const id = px.length;
      px.push(x);
      py.push(y);
      pz.push(z);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const corner of fan) {
        const t = (corner / 3) | 0;
        sx += fnx[t] ?? 0;
        sy += fny[t] ?? 0;
        sz += fnz[t] ?? 0;
        outI[corner] = id;
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      nx.push(sx / len);
      ny.push(sy / len);
      nz.push(sz / len);
    }
  }
  const outPos = new Float32Array(px.length * 3);
  const outNrm = new Float32Array(nx.length * 3);
  for (let i = 0; i < px.length; i += 1) {
    outPos[i * 3] = px[i] ?? 0;
    outPos[i * 3 + 1] = py[i] ?? 0;
    outPos[i * 3 + 2] = pz[i] ?? 0;
    outNrm[i * 3] = nx[i] ?? 0;
    outNrm[i * 3 + 1] = ny[i] ?? 0;
    outNrm[i * 3 + 2] = nz[i] ?? 0;
  }
  return { positions: outPos, normals: outNrm, indices: outI };
}

export async function glbFromSurface(
  plateMmX: number,
  plateMmY: number,
  welded: RawMesh,
  budget: number,
  voxelMm: number,
): Promise<Buffer> {
  let mesh = welded.indices.length / 3 > TARGET_TRIS ? quadricDecimate(welded, TARGET_TRIS) : welded;
  let glb = await encodeCompressed(plateMmX, plateMmY, splitCreases(mesh.positions, mesh.indices), voxelMm);
  for (let attempt = 0; attempt < 3 && glb.length > budget; attempt += 1) {
    const tris = mesh.indices.length / 3;
    const next = Math.max(2_000, Math.floor(((tris * budget) / glb.length) * 0.85));
    if (next >= tris) break;
    mesh = quadricDecimate(welded, next);
    glb = await encodeCompressed(plateMmX, plateMmY, splitCreases(mesh.positions, mesh.indices), voxelMm);
  }
  return glb;
}

async function encodeCompressed(plateMmX: number, plateMmY: number, surface: PlateSurface, voxelMm: number): Promise<Buffer> {
  await MeshoptEncoder.ready;
  const { positions, normals, indices } = surface;
  const vertices = positions.length / 3;
  const posPacked = MeshoptEncoder.encodeGltfBuffer(
    MeshoptEncoder.encodeFilterExp(positions, vertices, 12, 16, "Clamped"),
    vertices,
    12,
    "ATTRIBUTES",
  );
  const n4 = new Float32Array(vertices * 4);
  for (let i = 0; i < vertices; i += 1) {
    n4[i * 4] = normals[i * 3] ?? 0;
    n4[i * 4 + 1] = normals[i * 3 + 1] ?? 0;
    n4[i * 4 + 2] = normals[i * 3 + 2] ?? 0;
  }
  const nrmPacked = MeshoptEncoder.encodeGltfBuffer(MeshoptEncoder.encodeFilterOct(n4, vertices, 4, 8), vertices, 4, "ATTRIBUTES");
  const idxSrc = new Uint8Array(indices.byteLength);
  idxSrc.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
  const idxPacked = MeshoptEncoder.encodeGltfBuffer(idxSrc, indices.length, 4, "TRIANGLES");
  const packed = [posPacked, nrmPacked, idxPacked];
  let cursor = 0;
  const offsets = packed.map((chunk) => {
    const at = cursor;
    cursor += chunk.length;
    return at;
  });
  const bin = Buffer.alloc(cursor);
  packed.forEach((chunk, index) => bin.set(chunk, offsets[index]!));
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const view = (index: number, stride: number, count: number, mode: string, filter: string | undefined, target: number) => ({
    buffer: 0,
    byteOffset: 0,
    byteLength: 0,
    target,
    extensions: {
      EXT_meshopt_compression: {
        buffer: 0,
        byteOffset: offsets[index],
        byteLength: packed[index]!.length,
        byteStride: stride,
        count,
        mode,
        ...(filter ? { filter } : {}),
      },
    },
  });
  const json = JSON.stringify({
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { plate: [plateMmX, plateMmY], voxelMm } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
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
        count: vertices,
        type: "VEC3",
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      { bufferView: 1, componentType: 5120, count: vertices, type: "VEC4", normalized: true },
      { bufferView: 2, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      view(0, 12, vertices, "ATTRIBUTES", "EXPONENTIAL", 34962),
      view(1, 4, vertices, "ATTRIBUTES", "OCTAHEDRAL", 34962),
      view(2, 4, indices.length, "TRIANGLES", undefined, 34963),
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

function pad4(bytes: Buffer, fill: number): Buffer {
  const extra = (4 - (bytes.length % 4)) % 4;
  if (extra === 0) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(extra, fill)]);
}
