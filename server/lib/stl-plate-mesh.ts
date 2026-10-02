/**
 * Small, dependency-free STL to GLB converter.  Source models remain much
 * sharper than a voxelized CTB, while the CTB footprint supplies their plate
 * position.  Input is capped by the caller before it reaches this parser.
 */
export interface PlateFootprint {
  plateMmX: number;
  plateMmY: number;
  centerX: number;
  centerY: number;
}

const MAX_TRIANGLES = 600_000;

function binaryStl(bytes: Buffer): Float32Array | null {
  if (bytes.length < 84) return null;
  const count = bytes.readUInt32LE(80);
  if (count < 1 || 84 + count * 50 > bytes.length) return null;
  const take = Math.max(1, Math.ceil(count / MAX_TRIANGLES));
  const points = new Float32Array(Math.ceil(count / take) * 9);
  let out = 0;
  for (let i = 0; i < count; i += take) {
    const at = 84 + i * 50 + 12;
    for (let n = 0; n < 9; n += 1) points[out++] = bytes.readFloatLE(at + n * 4);
  }
  return points.subarray(0, out);
}

function asciiStl(bytes: Buffer): Float32Array {
  const values: number[] = [];
  const text = bytes.toString("utf8");
  const pattern = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let match = pattern.exec(text); match && values.length < MAX_TRIANGLES * 9; match = pattern.exec(text)) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  return Float32Array.from(values.filter(Number.isFinite));
}

function pad(bytes: Buffer): Buffer {
  const extra = (4 - (bytes.length % 4)) % 4;
  return extra ? Buffer.concat([bytes, Buffer.alloc(extra)]) : bytes;
}

/** STL Z is viewer Y; its Y is viewer Z.  Center it at the CTB footprint. */
export function stlPlateGlb(bytes: Buffer, footprint: PlateFootprint): Buffer {
  const raw = binaryStl(bytes) ?? asciiStl(bytes);
  if (raw.length < 9 || raw.length % 9 !== 0) throw new Error("That STL has no readable triangles.");
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < raw.length; i += 3) {
    minX = Math.min(minX, raw[i]!); maxX = Math.max(maxX, raw[i]!);
    minY = Math.min(minY, raw[i + 1]!); maxY = Math.max(maxY, raw[i + 1]!);
    minZ = Math.min(minZ, raw[i + 2]!); maxZ = Math.max(maxZ, raw[i + 2]!);
  }
  const dx = footprint.centerX - (minX + maxX) / 2;
  const dz = footprint.centerY - (minY + maxY) / 2;
  const vertices = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    vertices[i] = raw[i]! + dx;
    vertices[i + 1] = raw[i + 2]! - minZ;
    vertices[i + 2] = raw[i + 1]! + dz;
  }
  const vertexCount = vertices.length / 3;
  const indices = vertexCount > 65_535 ? Uint32Array.from({ length: vertexCount }, (_, i) => i) : Uint16Array.from({ length: vertexCount }, (_, i) => i);
  const pos = Buffer.from(vertices.buffer);
  const ind = Buffer.from(indices.buffer);
  const json = pad(Buffer.from(JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { plate: [footprint.plateMmX, footprint.plateMmY], source: "stl" } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.62, 0.52, 1], metallicFactor: 0.05, roughnessFactor: 0.7 } }],
    buffers: [{ byteLength: pos.length + ind.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 }, { buffer: 0, byteOffset: pos.length, byteLength: ind.length, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3" }, { bufferView: 1, componentType: indices.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, count: vertexCount, type: "SCALAR" }],
  })));
  const bin = pad(Buffer.concat([pos, ind]));
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  const at = 20 + json.length;
  out.writeUInt32LE(bin.length, at); out.writeUInt32LE(0x004e4942, at + 4); bin.copy(out, at + 8);
  return out;
}
