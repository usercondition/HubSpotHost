/**
 * Layer-table offsets for classic and encrypted CTB (UVtools layout).
 * Knight Castellan plates are not in this workspace; these fixtures use the same
 * header, pointer, and 88-byte definition offsets those encrypted v4/v5 files use.
 * Each assertion reads one span, never the whole plate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CTB_PAGE_SIZE,
  ENCRYPTED_LAYER_DEF,
  createBufferCtbReader,
  createPrefixCtbReader,
  ctbLayerEntries,
  ctbLayerPlan,
  ctbPageOffset,
  encryptCtbSettingsBlock,
  readCtbLayerBytes,
  xorCtbLayer,
} from "../server/lib/ctb";
import { decodeCtbRle } from "../client/src/lib/ctb-layer";

const WHITE_RUN = Buffer.from([0x80 | 0x7f, 4]);

function classicPlate(xorKey = 0): Buffer {
  const layerCount = 3;
  const tableOffset = 0x80;
  const dataStart = tableOffset + layerCount * 36;
  const file = Buffer.alloc(dataStart + layerCount * WHITE_RUN.length);
  file.writeUInt32LE(0x12fd0086, 0);
  file.writeUInt32LE(4, 0x34);
  file.writeUInt32LE(1, 0x38);
  file.writeUInt32LE(tableOffset, 0x40);
  file.writeUInt32LE(layerCount, 0x44);
  file.writeUInt32LE(xorKey, 0x64);
  for (let i = 0; i < layerCount; i += 1) {
    const at = tableOffset + i * 36;
    const dataAt = dataStart + i * WHITE_RUN.length;
    const stored = Buffer.from(WHITE_RUN);
    xorCtbLayer(xorKey, i, stored);
    file.writeUInt32LE(dataAt, at + 12);
    file.writeUInt32LE(stored.length, at + 16);
    file.writeUInt32LE(0, at + 20);
    stored.copy(file, dataAt);
  }
  return file;
}

function encryptedPlate(): Buffer {
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
  const fileSize = defAt[1]! + ENCRYPTED_LAYER_DEF + rleLength;
  const file = Buffer.alloc(fileSize);
  file.writeUInt32LE(0x12fd0107, 0);
  file.writeUInt32LE(encryptedSettings.length, 4);
  file.writeUInt32LE(0x30, 8);
  file.writeUInt32LE(5, 0x10);
  encryptedSettings.copy(file, 0x30);
  for (let i = 0; i < layerCount; i += 1) {
    const pointer = pointerOffset + i * 16;
    file.writeUInt32LE(defAt[i]!, pointer);
    file.writeUInt32LE(0, pointer + 4);
    file.writeUInt32LE(0x58, pointer + 8);
    const plain = Buffer.alloc(rleLength, 0);
    WHITE_RUN.copy(plain);
    xorCtbLayer(xorKey, i, plain);
    const stored = encryptCtbSettingsBlock(plain);
    const def = defAt[i]!;
    file.writeUInt32LE(ENCRYPTED_LAYER_DEF, def);
    file.writeUInt32LE(stored.length, def + 24);
    file.writeUInt32LE(0, def + 32);
    file.writeUInt32LE(stored.length, def + 36);
    stored.copy(file, def + ENCRYPTED_LAYER_DEF);
  }
  return file;
}

function rangeReader(file: Buffer, reads: Array<[number, number]>) {
  return async (start: number, length: number) => {
    reads.push([start, length]);
    assert.ok(length <= 8 * 1024 * 1024, `range ${start}+${length} is a full-file read`);
    assert.ok(length < file.length, "range covers the whole plate");
    if (start < 0 || start + length > file.length) return null;
    return file.subarray(start, start + length);
  };
}

test("classic layer table offsets point at each layer and a ranged read returns plaintext RLE", async () => {
  const file = classicPlate(0x51);
  const reader = createBufferCtbReader(file);
  const plan = ctbLayerPlan(reader);
  assert.equal(plan.encrypted, false);
  assert.equal(plan.layerCount, 3);
  assert.equal(plan.width, 4);
  assert.equal(plan.height, 1);
  assert.equal(plan.xorKey, 0x51);
  assert.equal(plan.tableOffset, 0x80);
  assert.equal(plan.tableBytes, 108);
  const table = reader.read(plan.tableOffset, plan.tableBytes);
  assert.ok(table);
  const entries = ctbLayerEntries(plan, table, file.length);
  assert.equal(entries[0]?.offset, 0x80 + 108);
  assert.equal(entries[1]?.offset, entries[0]!.offset + WHITE_RUN.length);
  assert.equal(entries[2]?.length, WHITE_RUN.length);
  const reads: Array<[number, number]> = [];
  const bytes = await readCtbLayerBytes(rangeReader(file, reads), plan, entries, new Map(), 1);
  assert.deepEqual(bytes, WHITE_RUN);
  assert.deepEqual(reads, [[entries[1]!.offset, WHITE_RUN.length]]);
  const image = decodeCtbRle(bytes, plan.width, plan.height, 8);
  assert.equal(image.width, 4);
  assert.equal(image.height, 1);
  assert.equal(image.rgba[0], 255);
  assert.equal(image.rgba[4], 255);
  assert.equal(image.rgba[8], 255);
  assert.equal(image.rgba[12], 255);
});

test("encrypted v4/v5 pointer table, AES window, and XOR round-trip one layer", async () => {
  assert.equal(ctbPageOffset(0, 0x400), 0x400);
  assert.equal(ctbPageOffset(1, 100), CTB_PAGE_SIZE + 100);
  const file = encryptedPlate();
  const reader = createBufferCtbReader(file);
  const plan = ctbLayerPlan(reader);
  assert.equal(plan.encrypted, true);
  assert.equal(plan.layerCount, 2);
  assert.equal(plan.width, 4);
  assert.equal(plan.height, 1);
  assert.equal(plan.tableOffset, 0x180);
  assert.equal(plan.tableBytes, 32);
  const table = reader.read(plan.tableOffset, plan.tableBytes);
  assert.ok(table);
  const entries = ctbLayerEntries(plan, table, file.length);
  assert.deepEqual(
    entries.map((entry) => entry.offset),
    [0x400, 0x500],
  );
  const spans = new Map();
  const reads: Array<[number, number]> = [];
  const read = rangeReader(file, reads);
  const first = await readCtbLayerBytes(read, plan, entries, spans, 0);
  assert.deepEqual(first, Buffer.concat([WHITE_RUN, Buffer.alloc(14)]));
  assert.deepEqual(reads, [
    [0x400, ENCRYPTED_LAYER_DEF],
    [0x400 + ENCRYPTED_LAYER_DEF, 16],
  ]);
  reads.length = 0;
  const again = await readCtbLayerBytes(read, plan, entries, spans, 0);
  assert.deepEqual(again.subarray(0, 2), WHITE_RUN);
  assert.deepEqual(reads, [[0x400 + ENCRYPTED_LAYER_DEF, 16]]);
});

test("a prefix reader keeps the layer table and does not pull layer bytes past the prefix", async () => {
  const file = encryptedPlate();
  const fullSize = 386_149_597;
  const prefix = file.subarray(0, 0x200);
  const reader = createPrefixCtbReader(Buffer.from(prefix), fullSize);
  const plan = ctbLayerPlan(reader);
  const table = reader.read(plan.tableOffset, plan.tableBytes);
  assert.ok(table, "pointer table should sit inside the sampled prefix");
  assert.equal(reader.read(0x400, ENCRYPTED_LAYER_DEF), null);
  const entries = ctbLayerEntries(plan, table, fullSize);
  const reads: Array<[number, number]> = [];
  const bytes = await readCtbLayerBytes(rangeReader(file, reads), plan, entries, new Map(), 1);
  assert.equal(bytes[0], WHITE_RUN[0]);
  assert.equal(bytes[1], WHITE_RUN[1]);
  const pulled = reads.reduce((sum, [, length]) => sum + length, 0);
  assert.ok(pulled < 200, `pulled ${pulled} bytes`);
  assert.ok(reads.every(([start]) => start >= 0x500 && start < 0x600));
});
