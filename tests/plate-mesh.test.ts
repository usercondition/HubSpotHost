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
import { upsertPlateFiles } from "../server/lib/plate-files";
import { enqueuePlateMesh, plateMeshJobPeak, resetPlateMeshJobPeak, whenPlateMeshesIdle } from "../server/lib/plate-mesh-jobs";
import { MESH_BYTE_BUDGET, buildPlateGlb } from "../server/lib/plate-mesh";
import { STREAM_PLATE_BYTES, streamLargePlate } from "./plate-mesh-stream";

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

function gltf(glb: Buffer): { materials: Array<{ doubleSided?: boolean }>; accessors: Array<{ count: number; min: number[] }> } {
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
  assert.equal(doc.materials[0]?.doubleSided, true);
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

test("a 480MB plate is read as ranges, not as one buffer", async () => {
  const result = await streamLargePlate();
  assert.equal(result.maxRead <= 8 * 1024 * 1024, true);
  assert.ok(result.bytesRead < 32 * 1024 * 1024, `read ${result.bytesRead} of ${STREAM_PLATE_BYTES}`);
  assert.ok(result.glbBytes > 100);
  assert.ok(result.reads > 2);
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

test("a 480MB stream stays under 300MB RSS", { timeout: 120_000 }, async () => {
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
  const result = JSON.parse(out) as { peakRss: number; startRss: number; ms: number; glbBytes: number; bytesRead: number };
  console.log(
    `[plate-mesh] 480MB stream peakRss=${result.peakRss} startRss=${result.startRss} bytesRead=${result.bytesRead} glb=${result.glbBytes} ms=${result.ms}`,
  );
  assert.ok(result.peakRss < 300 * 1024 * 1024, `peak RSS ${result.peakRss}`);
});
