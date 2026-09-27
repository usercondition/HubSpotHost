/**
 * A plate mesh is built from decoded CTB layers, one layer at a time.
 * The fixtures use the same classic and encrypted v4/v5 layout as the layer scanner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENCRYPTED_LAYER_DEF, encryptCtbSettingsBlock, xorCtbLayer } from "../server/lib/ctb";
import { saveDriveConnection, setDriveFetchForTest } from "../server/lib/google-drive";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { getPlateFile, markPlateMesh, upsertPlateFiles } from "../server/lib/plate-files";
import { enqueuePlateMesh, plateMeshJobPeak, resetPlateMeshJobPeak, whenPlateMeshesIdle } from "../server/lib/plate-mesh-jobs";
import { MESH_BYTE_BUDGET, MESH_VOXEL_MM, PLATE_MESH_VERSION, buildPlateGlb } from "../server/lib/plate-mesh";
import { STREAM_PLATE_BYTES, inspectGlb, readMesh, separatedMinisCtb, streamLargePlate } from "./plate-mesh-stream";

function rle(white: boolean, length: number): number[] {
  if (length < 1) return [];
  return [0x80 | (white ? 0x7f : 0), length];
}

function classicPyramid(): Buffer {
  const width = 32;
  const height = 32;
  const layerCount = 12;
  const tableOffset = 0x80;
  const layers: Buffer[] = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    const inset = Math.min(12, layer);
    const bytes: number[] = [];
    for (let y = 0; y < height; y += 1) {
      const solid = y >= inset && y < height - inset;
      if (!solid) {
        bytes.push(...rle(false, width));
        continue;
      }
      const x0 = inset;
      const x1 = width - inset;
      bytes.push(...rle(false, x0), ...rle(true, Math.max(1, x1 - x0)), ...rle(false, width - x1));
    }
    layers.push(Buffer.from(bytes));
  }
  return packClassic(width, height, tableOffset, layers);
}

function classicBlank(): Buffer {
  const width = 8;
  const height = 4;
  const layers = [Buffer.from(rle(false, width * height))];
  return packClassic(width, height, 0x80, layers);
}

function packClassic(width: number, height: number, tableOffset: number, layers: Buffer[]): Buffer {
  const dataStart = tableOffset + layers.length * 36;
  const total = layers.reduce((sum, layer) => sum + layer.length, 0);
  const file = Buffer.alloc(dataStart + total);
  file.writeUInt32LE(0x12fd0086, 0);
  file.writeUInt32LE(width, 0x34);
  file.writeUInt32LE(height, 0x38);
  file.writeUInt32LE(tableOffset, 0x40);
  file.writeUInt32LE(layers.length, 0x44);
  let cursor = dataStart;
  layers.forEach((layer, index) => {
    const at = tableOffset + index * 36;
    file.writeUInt32LE(cursor, at + 12);
    file.writeUInt32LE(layer.length, at + 16);
    layer.copy(file, cursor);
    cursor += layer.length;
  });
  return file;
}

function encryptedStick(): Buffer {
  const xorKey = 0x13579bdf;
  const layerCount = 2;
  const width = 4;
  const height = 1;
  const pointerOffset = 0x180;
  const settingsPlain = Buffer.alloc(288, 0);
  settingsPlain.writeUInt32LE(pointerOffset, 8);
  settingsPlain.writeUInt32LE(width, 56);
  settingsPlain.writeUInt32LE(height, 60);
  settingsPlain.writeUInt32LE(layerCount, 64);
  settingsPlain.writeUInt32LE(xorKey, 128);
  const encryptedSettings = encryptCtbSettingsBlock(settingsPlain);
  const defAt = [0x400, 0x500];
  const rleLength = 16;
  const file = Buffer.alloc(defAt[1]! + ENCRYPTED_LAYER_DEF + rleLength);
  file.writeUInt32LE(0x12fd0107, 0);
  file.writeUInt32LE(encryptedSettings.length, 4);
  file.writeUInt32LE(0x30, 8);
  file.writeUInt32LE(5, 0x10);
  encryptedSettings.copy(file, 0x30);
  const white = Buffer.from([0x80 | 0x7f, 4]);
  for (let i = 0; i < layerCount; i += 1) {
    const pointer = pointerOffset + i * 16;
    file.writeUInt32LE(defAt[i]!, pointer);
    file.writeUInt32LE(0x58, pointer + 8);
    const plain = Buffer.alloc(rleLength, 0);
    white.copy(plain);
    xorCtbLayer(xorKey, i, plain);
    const stored = encryptCtbSettingsBlock(plain);
    const def = defAt[i]!;
    file.writeUInt32LE(stored.length, def + 24);
    file.writeUInt32LE(stored.length, def + 36);
    stored.copy(file, def + ENCRYPTED_LAYER_DEF);
  }
  return file;
}

function reader(file: Buffer, reads: number[]) {
  return async (start: number, length: number) => {
    reads.push(length);
    assert.ok(length <= 8 * 1024 * 1024, `read ${length} exceeds one prefix`);
    if (start < 0 || start + length > file.length) return null;
    return file.subarray(start, start + length);
  };
}

function gltf(glb: Buffer): {
  extensionsRequired?: string[];
  materials: Array<{ doubleSided?: boolean }>;
  accessors: Array<{ count: number; min?: number[] }>;
  meshes: Array<{ primitives: Array<{ attributes: { NORMAL?: number } }> }>;
  nodes: Array<{ extras?: { plate?: number[] } }>;
} {
  assert.equal(glb.subarray(0, 4).toString(), "glTF");
  const jsonLen = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + jsonLen).toString().trim()) as ReturnType<typeof gltf>;
}

test("a classic plate becomes a compact double-sided GLB without holding every layer", async () => {
  const file = classicPyramid();
  const reads: number[] = [];
  const started = Date.now();
  const glb = await buildPlateGlb(reader(file, reads), file.length);
  const elapsed = Date.now() - started;
  assert.ok(glb.length > 100, "mesh is empty");
  assert.ok(glb.length <= MESH_BYTE_BUDGET, `mesh is ${glb.length} bytes`);
  const doc = gltf(glb);
  assert.equal(doc.extensionsRequired?.includes("EXT_meshopt_compression"), true);
  assert.equal(doc.materials[0]?.doubleSided, true);
  assert.equal(doc.meshes[0]?.primitives[0]?.attributes.NORMAL, 1);
  assert.ok(Math.abs((doc.nodes[0]?.extras?.plate?.[0] ?? 0) - 1.6) < 0.05);
  assert.ok((doc.accessors[0]?.count ?? 0) > 8);
  assert.equal(reads[0], file.length);
  assert.ok(reads.slice(1).every((length) => length < file.length));
  assert.ok(elapsed < 5_000, `mesh took ${elapsed}ms`);
});

test("an encrypted v4 layer decrypts into the same mesh path", async () => {
  const file = encryptedStick();
  const reads: number[] = [];
  const glb = await buildPlateGlb(reader(file, reads), file.length);
  assert.ok(glb.length > 100);
  assert.equal(gltf(glb).materials[0]?.doubleSided, true);
  assert.ok(reads.some((length) => length === ENCRYPTED_LAYER_DEF));
});

test("a blank plate records no mesh bytes", async () => {
  const file = classicBlank();
  const glb = await buildPlateGlb(reader(file, []), file.length);
  assert.equal(glb.length, 0);
});

function longRle(white: boolean, length: number): number[] {
  if (length < 1) return [];
  const head = 0x80 | (white ? 0x7f : 0);
  if (length < 0x80) return [head, length];
  if (length < 0x4000) return [head, 0x80 | (length >> 8), length & 0xff];
  return [head, 0xc0 | ((length >> 16) & 0x1f), (length >> 8) & 0xff, length & 0xff];
}

function featurePlate(): Buffer {
  const pixel = 0.05;
  const width = 240;
  const height = 160;
  const layers = 100;
  const mm = (value: number) => Math.round(value / pixel);
  const box = { x0: mm(1), x1: mm(5), y0: mm(1), y1: mm(5), z0: mm(0.5), z1: mm(4.5) };
  const bolt = { cx: mm(8), cy: mm(3), r: mm(0.25), z0: 0, z1: mm(2.2) };
  const payloads: Buffer[] = [];
  for (let layer = 0; layer < layers; layer += 1) {
    const bytes: number[] = [];
    for (let y = 0; y < height; y += 1) {
      const spans: Array<[number, number]> = [];
      if (layer >= box.z0 && layer < box.z1 && y >= box.y0 && y < box.y1) spans.push([box.x0, box.x1]);
      if (layer >= bolt.z0 && layer < bolt.z1) {
        const dy = y - bolt.cy;
        if (Math.abs(dy) <= bolt.r) {
          const dx = Math.sqrt(bolt.r * bolt.r - dy * dy);
          const x0 = Math.max(0, Math.ceil(bolt.cx - dx));
          const x1 = Math.min(width, Math.floor(bolt.cx + dx) + 1);
          if (x1 > x0) spans.push([x0, x1]);
        }
      }
      spans.sort((a, b) => a[0] - b[0]);
      let cursor = 0;
      for (const [x0, x1] of spans) {
        if (x0 > cursor) bytes.push(...longRle(false, x0 - cursor));
        bytes.push(...longRle(true, x1 - x0));
        cursor = x1;
      }
      if (cursor < width) bytes.push(...longRle(false, width - cursor));
    }
    payloads.push(Buffer.from(bytes));
  }
  return packClassic(width, height, 0x80, payloads);
}

test("a 0.5 mm bolt and a square edge stay measurable", async () => {
  const file = featurePlate();
  const glb = await buildPlateGlb(reader(file, []), file.length);
  const mesh = await readMesh(glb);
  assert.ok(Math.abs(mesh.voxelMm - MESH_VOXEL_MM) < 1e-6, `pitch ${mesh.voxelMm}`);
  const count = mesh.positions.length / 3;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;
  const find = (v: number): number => {
    let cursor = v;
    while (parent[cursor] !== cursor) cursor = parent[cursor]!;
    return cursor;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const at = (v: number) => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as const;
  const weldKey = (v: number) => `${at(v)[0]},${at(v)[1]},${at(v)[2]}`;
  const canon = new Map<string, number>();
  for (let v = 0; v < count; v += 1) {
    const key = weldKey(v);
    const prior = canon.get(key);
    if (prior === undefined) canon.set(key, v);
    else unite(prior, v);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    unite(mesh.indices[i]!, mesh.indices[i + 1]!);
    unite(mesh.indices[i]!, mesh.indices[i + 2]!);
  }
  interface Part {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    tris: number;
    root: number;
  }
  const parts = new Map<number, Part>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const root = find(mesh.indices[i]!);
    let part = parts.get(root);
    if (!part) {
      part = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity, tris: 0, root };
      parts.set(root, part);
    }
    part.tris += 1;
    for (let k = 0; k < 3; k += 1) {
      const [x, y, z] = at(mesh.indices[i + k]!);
      if (x < part.minX) part.minX = x;
      if (y < part.minY) part.minY = y;
      if (z < part.minZ) part.minZ = z;
      if (x > part.maxX) part.maxX = x;
      if (y > part.maxY) part.maxY = y;
      if (z > part.maxZ) part.maxZ = z;
    }
  }
  let bolt: Part | null = null;
  let square: Part | null = null;
  for (const part of parts.values()) {
    const dx = part.maxX - part.minX;
    const dy = part.maxY - part.minY;
    const dz = part.maxZ - part.minZ;
    const span = Math.min(dx, dz);
    const other = Math.max(dx, dz);
    if (span > 0.25 && other < 0.95 && dy > 1.4 && dy < 3.2) bolt = part;
    if (dx > 3.4 && dx < 4.6 && dy > 3.4 && dy < 4.6 && dz > 3.4 && dz < 4.6) square = part;
  }
  assert.ok(bolt, `bolt missing ${[...parts.values()].map((part) => [part.maxX - part.minX, part.maxY - part.minY, part.maxZ - part.minZ].map((n) => n.toFixed(2)).join("x")).join(" ")}`);
  assert.ok(bolt.tris >= 16, `bolt triangles ${bolt.tris}`);
  assert.ok(square, "square edge missing");
  const corners = [
    [square.minX, square.minY, square.minZ],
    [square.minX, square.minY, square.maxZ],
    [square.minX, square.maxY, square.minZ],
    [square.minX, square.maxY, square.maxZ],
    [square.maxX, square.minY, square.minZ],
    [square.maxX, square.minY, square.maxZ],
    [square.maxX, square.maxY, square.minZ],
    [square.maxX, square.maxY, square.maxZ],
  ];
  let cornerGap = Infinity;
  const fans = new Map<string, Array<[number, number, number]>>();
  for (let v = 0; v < count; v += 1) {
    if (find(v) !== square.root) continue;
    const [x, y, z] = at(v);
    for (const corner of corners) {
      const gap = Math.hypot(x - corner[0]!, y - corner[1]!, z - corner[2]!);
      if (gap < cornerGap) cornerGap = gap;
    }
    const key = weldKey(v);
    const fan = fans.get(key) ?? [];
    fan.push([mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!]);
    fans.set(key, fan);
  }
  let sharp = 0;
  let widestFan = 0;
  for (const fan of fans.values()) {
    if (fan.length > widestFan) widestFan = fan.length;
    for (let a = 0; a < fan.length; a += 1) {
      for (let b = a + 1; b < fan.length; b += 1) {
        const dot = Math.abs(fan[a]![0] * fan[b]![0] + fan[a]![1] * fan[b]![1] + fan[a]![2] * fan[b]![2]);
        if (dot < 0.35) sharp += 1;
      }
    }
  }
  const faceN = (tri: number): [number, number, number] => {
    const a = mesh.indices[tri * 3]!;
    const b = mesh.indices[tri * 3 + 1]!;
    const c = mesh.indices[tri * 3 + 2]!;
    const [ax, ay, az] = at(a);
    const [bx, by, bz] = at(b);
    const [cx, cy, cz] = at(c);
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  };
  let minFaceDot = 1;
  const edgeFaces = new Map<string, number[]>();
  for (let t = 0; t < mesh.indices.length / 3; t += 1) {
    if (find(mesh.indices[t * 3]!) !== square.root) continue;
    const tri = [mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!];
    for (let e = 0; e < 3; e += 1) {
      const u = canon.get(weldKey(tri[e]!))!;
      const v = canon.get(weldKey(tri[(e + 1) % 3]!))!;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const list = edgeFaces.get(key) ?? [];
      list.push(t);
      edgeFaces.set(key, list);
    }
  }
  for (const list of edgeFaces.values()) {
    if (list.length !== 2) continue;
    const n0 = faceN(list[0]!);
    const n1 = faceN(list[1]!);
    const dot = Math.abs(n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]);
    if (dot < minFaceDot) minFaceDot = dot;
  }
  console.log(
    `[plate-mesh] bolt span=${Math.min(bolt.maxX - bolt.minX, bolt.maxZ - bolt.minZ).toFixed(3)} tall=${(bolt.maxY - bolt.minY).toFixed(3)} tris=${bolt.tris} cornerGap=${cornerGap.toFixed(3)} sharp=${sharp} widestFan=${widestFan} minFaceDot=${minFaceDot.toFixed(3)}`,
  );
  assert.ok(cornerGap < 0.15, `corner gap ${cornerGap}`);
  assert.ok(widestFan >= 2, "feature edge was not split");
  assert.ok(minFaceDot < 0.55, `sharpest edge dot ${minFaceDot}`);
});

test("a 480MB plate is read as ranges, not as one buffer", async () => {
  const result = await streamLargePlate();
  assert.equal(result.maxRead <= 8 * 1024 * 1024, true);
  assert.ok(result.bytesRead < 32 * 1024 * 1024, `read ${result.bytesRead} of ${STREAM_PLATE_BYTES}`);
  assert.ok(result.glbBytes > 100 && result.glbBytes <= MESH_BYTE_BUDGET, `glb ${result.glbBytes}`);
  assert.ok(result.triangles > 1_000, `triangles ${result.triangles}`);
  assert.ok(result.components >= 3, `components ${result.components}`);
  assert.ok(result.thinSupports >= 1, `thin supports ${result.thinSupports}`);
  assert.ok(result.reads > 2);
  assert.ok(result.agreement >= 0.999, `winding agreement ${result.agreement}`);
  assert.ok(result.manifold >= 0.99, `manifold edges ${result.manifold}`);
  console.log(
    `[plate-mesh] 480MB parts pitch=${result.voxelMm} glb=${result.glbBytes} triangles=${result.triangles} components=${result.components} thin=${result.thinSupports} agreement=${result.agreement} manifold=${result.manifold} bytesRead=${result.bytesRead} peakRss=${result.peakRss} maxBlock=${result.maxBlock} ms=${result.ms}`,
  );
  assert.ok(Math.abs(result.voxelMm - MESH_VOXEL_MM) < 1e-6, `pitch ${result.voxelMm}`);
  assert.ok(result.maxBlock < 250, `event loop blocked ${result.maxBlock}ms`);
});

test("separated minis stay manifold without blocking the event loop", { timeout: 120_000 }, async () => {
  const file = separatedMinisCtb();
  let maxBlock = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > maxBlock) maxBlock = now - last;
    last = now;
  }, 20);
  const started = Date.now();
  try {
    const glb = await buildPlateGlb(async (start, length) => {
      if (start < 0 || start + length > file.length) return null;
      return file.subarray(start, start + length);
    }, file.length);
    const ms = Date.now() - started;
    const inspected = await inspectGlb(glb);
    console.log(
      `[plate-mesh] minis glb=${glb.length} triangles=${inspected.triangles} components=${inspected.components} agreement=${inspected.agreement} manifold=${inspected.manifold} maxBlock=${maxBlock} ms=${ms}`,
    );
    assert.ok(glb.length > 100 && glb.length <= MESH_BYTE_BUDGET, `glb ${glb.length}`);
    assert.ok(inspected.triangles > 50_000, `triangles ${inspected.triangles}`);
    assert.ok(inspected.components >= 60, `components ${inspected.components}`);
    assert.ok(inspected.agreement >= 0.999, `winding agreement ${inspected.agreement}`);
    assert.ok(inspected.manifold >= 0.99, `manifold edges ${inspected.manifold}`);
    assert.ok(maxBlock < 250, `event loop blocked ${maxBlock}ms`);
  } finally {
    clearInterval(timer);
  }
});

test("mesh jobs run one at a time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plate-mesh-queue-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    client: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
  resetOrderLinkStore();
  resetPlateMeshJobPeak();
  let active = 0;
  let peak = 0;
  setDriveFetchForTest(async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-ok" }), { status: 200 });
    }
    if (url.includes("alt=media")) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return new Response(Buffer.alloc(32), { status: 206 });
    }
    return new Response("no", { status: 500 });
  });
  try {
    saveDriveConnection({ email: "miguel.plates@gmail.com", refreshToken: "refresh-marker" });
    upsertPlateFiles(
      [
        { driveFileId: "mesh-a", name: "Castellan_A.ctb", webViewLink: "", sizeBytes: 480_000_000, kit: "Knight Castellan" },
        { driveFileId: "mesh-b", name: "Castellan_B.ctb", webViewLink: "", sizeBytes: 480_000_000, kit: "Knight Castellan" },
      ],
      "indexed",
    );
    assert.equal(enqueuePlateMesh("mesh-a"), true);
    assert.equal(enqueuePlateMesh("mesh-b"), true);
    assert.equal(enqueuePlateMesh("mesh-a"), false);
    await whenPlateMeshesIdle();
    assert.equal(peak, 1);
    assert.equal(plateMeshJobPeak(), 1);
  } finally {
    setDriveFetchForTest(null);
    resetOrderLinkStore();
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.client === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.client;
    if (previous.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 480MB stream stays under 1GB RSS", { timeout: 120_000 }, async () => {
  const child = spawn("npx", ["tsx", "tests/plate-mesh-stream.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, err || out);
  const result = JSON.parse(out) as {
    peakRss: number;
    startRss: number;
    ms: number;
    glbBytes: number;
    bytesRead: number;
    triangles: number;
    components: number;
    thinSupports: number;
    voxelMm: number;
    maxBlock: number;
    agreement: number;
    manifold: number;
  };
  console.log(
    `[plate-mesh] 480MB stream pitch=${result.voxelMm} peakRss=${result.peakRss} startRss=${result.startRss} bytesRead=${result.bytesRead} glb=${result.glbBytes} triangles=${result.triangles} components=${result.components} thin=${result.thinSupports} agreement=${result.agreement} manifold=${result.manifold} maxBlock=${result.maxBlock} ms=${result.ms}`,
  );
  assert.ok(result.peakRss < 1024 * 1024 * 1024, `peak RSS ${result.peakRss}`);
  assert.ok(result.maxBlock < 250, `event loop blocked ${result.maxBlock}ms`);
  assert.ok(Math.abs(result.voxelMm - MESH_VOXEL_MM) < 1e-6, `pitch ${result.voxelMm}`);
  assert.ok(result.glbBytes <= MESH_BYTE_BUDGET);
  assert.ok(result.triangles > 1_000);
  assert.ok(result.components >= 3);
  assert.ok(result.thinSupports >= 1);
});

test("backfill regenerates an older mesh and trashes the previous GLB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plate-mesh-version-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    client: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
  resetOrderLinkStore();
  const plate = classicPyramid();
  const trashed: string[] = [];
  setDriveFetchForTest(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-ok" }), { status: 200 });
    }
    if (url.includes("alt=media")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const match = /bytes=(\d+)-(\d+)/.exec(headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end = match ? Number(match[2]) + 1 : plate.length;
      return new Response(plate.subarray(start, Math.min(end, plate.length)), { status: 206 });
    }
    if (method === "GET" && url.includes("/drive/v3/files?")) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (method === "POST" && url.includes("/drive/v3/files") && !url.includes("uploadType")) {
      return new Response(JSON.stringify({ id: "folder-1" }), { status: 200 });
    }
    if (method === "POST" && url.includes("uploadType=resumable")) {
      return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
    }
    if (url.startsWith("https://upload.example/session")) {
      return new Response(
        JSON.stringify({ id: "glb-new", name: "Castellan.glb", size: "100", mimeType: "model/gltf-binary" }),
        { status: 200 },
      );
    }
    if (method === "PATCH") {
      const id = decodeURIComponent(url.split("/files/")[1]?.split("?")[0] ?? "");
      trashed.push(id);
      return new Response(JSON.stringify({ id, trashed: true }), { status: 200 });
    }
    return new Response("no", { status: 500 });
  });
  try {
    saveDriveConnection({ email: "miguel.plates@gmail.com", refreshToken: "refresh-marker" });
    upsertPlateFiles(
      [{ driveFileId: "mesh-stale", name: "Castellan_Bits.ctb", webViewLink: "", sizeBytes: plate.length, kit: "Knight Castellan" }],
      "indexed",
    );
    markPlateMesh("mesh-stale", { meshState: "ready", meshDriveFileId: "old-glb", meshVersion: 0 });
    assert.equal(enqueuePlateMesh("mesh-stale"), true);
    await whenPlateMeshesIdle();
    const saved = getPlateFile("mesh-stale");
    assert.equal(saved?.meshState, "ready");
    assert.equal(saved?.meshVersion, PLATE_MESH_VERSION);
    assert.equal(saved?.meshDriveFileId, "glb-new");
    assert.deepEqual(trashed, ["old-glb"]);
    assert.equal(enqueuePlateMesh("mesh-stale"), false);
  } finally {
    setDriveFetchForTest(null);
    resetOrderLinkStore();
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.client === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.client;
    if (previous.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret;
    rmSync(dir, { recursive: true, force: true });
  }
});
