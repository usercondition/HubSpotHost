/**
 * Mesh measurements for the STL Quote tool (runs in the browser and in tests).
 *
 * Supports binary STL, ASCII STL, OBJ (v/f, polygons fan-triangulated) and
 * 3MF (zip with 3D/*.model; unit attribute honoured, build transforms ignored).
 * Volume is the absolute signed-tetrahedron sum, so it is exact for a closed,
 * consistently wound mesh and an estimate for open/broken meshes.
 * Units: mm in, ml out (1 ml = 1000 mm³).
 */
import { unzipSync, strFromU8 } from "fflate";

export type MeshFormat = "stl-binary" | "stl-ascii" | "obj" | "3mf";

export type MeshStats = {
  format: MeshFormat;
  triangles: number;
  volumeMl: number;
  surfaceAreaMm2: number;
  bbox: { x: number; y: number; z: number };
  /** Z extent in mm (print height when laid flat as modeled). */
  heightMm: number;
  /** True when the signed volume came out negative (inverted normals); value still reported as absolute. */
  inverted: boolean;
};

class Accumulator {
  volume6 = 0;
  area2 = 0;
  triangles = 0;
  minX = Infinity; minY = Infinity; minZ = Infinity;
  maxX = -Infinity; maxY = -Infinity; maxZ = -Infinity;

  constructor(private readonly scale = 1) {}

  private point(x: number, y: number, z: number) {
    if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z; if (z > this.maxZ) this.maxZ = z;
  }

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
    const s = this.scale;
    if (s !== 1) { ax *= s; ay *= s; az *= s; bx *= s; by *= s; bz *= s; cx *= s; cy *= s; cz *= s; }
    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) return;
    this.point(ax, ay, az); this.point(bx, by, bz); this.point(cx, cy, cz);
    // signed volume of tetra (origin, a, b, c) * 6 = a · (b × c)
    this.volume6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    this.area2 += Math.sqrt(nx * nx + ny * ny + nz * nz);
    this.triangles += 1;
  }

  result(format: MeshFormat): MeshStats {
    if (this.triangles === 0) throw new Error("No triangles found in this file");
    const signed = this.volume6 / 6;
    const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
    const bbox = { x: r(this.maxX - this.minX), y: r(this.maxY - this.minY), z: r(this.maxZ - this.minZ) };
    return {
      format,
      triangles: this.triangles,
      volumeMl: r(Math.abs(signed) / 1000, 4),
      surfaceAreaMm2: r(this.area2 / 2, 2),
      bbox,
      heightMm: bbox.z,
      inverted: signed < 0,
    };
  }
}

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  const head = strFromU8(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
  return !(head.startsWith("solid") && head.includes("facet"));
}

export function parseBinaryStl(bytes: Uint8Array): MeshStats {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const usable = Math.min(count, Math.floor((bytes.length - 84) / 50));
  const acc = new Accumulator();
  for (let i = 0; i < usable; i++) {
    const o = 84 + i * 50 + 12;
    const f = (k: number) => view.getFloat32(o + k * 4, true);
    acc.tri(f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8));
  }
  return acc.result("stl-binary");
}

export function parseAsciiStl(text: string): MeshStats {
  const acc = new Accumulator();
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const buf: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    buf.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (buf.length === 9) {
      acc.tri(buf[0]!, buf[1]!, buf[2]!, buf[3]!, buf[4]!, buf[5]!, buf[6]!, buf[7]!, buf[8]!);
      buf.length = 0;
    }
  }
  return acc.result("stl-ascii");
}

export function parseObj(text: string): MeshStats {
  const acc = new Accumulator();
  const v: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      v.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith("f ")) {
      const count = v.length / 3;
      const idx = line.split(/\s+/).slice(1).map((tok) => {
        const n = parseInt(tok.split("/")[0]!, 10);
        return n < 0 ? count + n : n - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        const a = idx[0]! * 3, b = idx[k]! * 3, c = idx[k + 1]! * 3;
        acc.tri(v[a]!, v[a + 1]!, v[a + 2]!, v[b]!, v[b + 1]!, v[b + 2]!, v[c]!, v[c + 1]!, v[c + 2]!);
      }
    }
  }
  return acc.result("obj");
}

const UNIT_TO_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export function parse3mf(bytes: Uint8Array): MeshStats {
  const files = unzipSync(bytes, { filter: (f) => /\.model$/i.test(f.name) });
  const names = Object.keys(files);
  if (names.length === 0) throw new Error("3MF has no 3D model part");
  let acc: Accumulator | null = null;
  for (const name of names) {
    const xml = strFromU8(files[name]!);
    const unit = /<model[^>]*\bunit="([a-z]+)"/i.exec(xml)?.[1]?.toLowerCase() ?? "millimeter";
    acc ??= new Accumulator(UNIT_TO_MM[unit] ?? 1);
    const meshRe = /<mesh[\s>][\s\S]*?<\/mesh>/gi;
    let mesh: RegExpExecArray | null;
    while ((mesh = meshRe.exec(xml))) {
      const verts: number[] = [];
      const vRe = /<vertex\b([^>]*)\/?>/gi;
      let vm: RegExpExecArray | null;
      while ((vm = vRe.exec(mesh[0]))) {
        const a = vm[1]!;
        const get = (k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(a)?.[1]);
        verts.push(get("x"), get("y"), get("z"));
      }
      const tRe = /<triangle\b([^>]*)\/?>/gi;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(mesh[0]))) {
        const a = tm[1]!;
        const get = (k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(a)?.[1]) * 3;
        const i = get("v1"), j = get("v2"), k = get("v3");
        acc.tri(verts[i]!, verts[i + 1]!, verts[i + 2]!, verts[j]!, verts[j + 1]!, verts[j + 2]!, verts[k]!, verts[k + 1]!, verts[k + 2]!);
      }
    }
  }
  return acc!.result("3mf");
}

export const MESH_FILE_ACCEPT = ".stl,.obj,.3mf";

export function parseMeshFile(fileName: string, bytes: Uint8Array): MeshStats {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "3mf") return parse3mf(bytes);
  if (ext === "obj") return parseObj(strFromU8(bytes));
  if (ext === "stl") return isBinaryStl(bytes) ? parseBinaryStl(bytes) : parseAsciiStl(strFromU8(bytes));
  throw new Error(`Unsupported file type .${ext} (use STL, OBJ, or 3MF)`);
}
