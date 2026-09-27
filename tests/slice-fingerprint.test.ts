import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sliceFingerprint } from "../server/lib/ctb";
import { mergePreviewStats } from "../server/lib/plate-files";
import { fingerprintPayload } from "../shared/slice-fingerprint";

test("the same size and first megabyte still hash apart when the tail differs", () => {
  const size = 3 * 1024 * 1024;
  const head = Buffer.alloc(1024 * 1024, 1);
  head.writeUInt32LE(0x12fd0086, 0);
  head.writeUInt32LE(420, 0x44);
  head.writeUInt32LE(14_400, 0x4c);
  const tailA = Buffer.alloc(1024 * 1024, 2);
  const tailB = Buffer.alloc(1024 * 1024, 2);
  tailB[tailB.length - 1] = 9;
  assert.notEqual(sliceFingerprint(size, head, tailA), sliceFingerprint(size, head, tailB));
  assert.equal(sliceFingerprint(size, head, tailA), sliceFingerprint(size, head, tailA));
});

test("the server digest is the shared head-and-tail payload", () => {
  const head = Buffer.alloc(32, 7);
  head.writeUInt32LE(0x12fd0086, 0);
  const tail = Buffer.alloc(32, 9);
  const payload = fingerprintPayload(5_000_000, head, tail);
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  assert.equal(sliceFingerprint(5_000_000, head, tail), digest);
});

test("preview stats keep an attach-time cost and only fill blanks", () => {
  const attached = {
    printerProfile: "MEGA 8K",
    layerCount: 420,
    layerHeightMm: 0.05,
    printTimeSeconds: 14_400,
    resinVolumeMl: 31.25,
    resinCost: 18.4,
  };
  const slicer = {
    printerProfile: "MEGA 8K",
    layerCount: null,
    layerHeightMm: null,
    printTimeSeconds: null,
    resinVolumeMl: null,
    resinCost: 4.75,
  };
  const merged = mergePreviewStats(attached, slicer);
  assert.equal(merged.resinCost, 18.4);
  assert.equal(merged.layerCount, 420);
  assert.equal(merged.printTimeSeconds, 14_400);
  const filled = mergePreviewStats(
    { ...attached, layerHeightMm: null, resinVolumeMl: null },
    { ...slicer, layerHeightMm: 0.05, resinVolumeMl: 31.25, resinCost: null },
  );
  assert.equal(filled.resinCost, 18.4);
  assert.equal(filled.layerHeightMm, 0.05);
  assert.equal(filled.resinVolumeMl, 31.25);
});
