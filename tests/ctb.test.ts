/**
 * Unit tests for Chitubox CTB header parsing.
 *
 * Uses a synthetic little-endian fixture matching the catibo CTB/CBDDLP layout
 * so we can assert resin, time, cost, and exposure fields without committing a
 * real slicer binary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CtbParseError, parseCtbFile } from "../server/lib/ctb";

function fixtureCtb(overrides?: {
  resinCost?: number;
  exposure?: number;
  bottomExposure?: number;
  bottomLayers?: number;
  modelHeight?: number;
  liftDistance?: number;
  liftSpeed?: number;
}): Buffer {
  const file = Buffer.alloc(0x180);
  file.writeUInt32LE(0x12fd0086, 0x00);
  file.writeUInt32LE(4, 0x04);
  file.writeFloatLE(218, 0x08);
  file.writeFloatLE(123, 0x0c);
  file.writeFloatLE(260, 0x10);
  file.writeFloatLE(overrides?.modelHeight ?? 42.5, 0x1c);
  file.writeFloatLE(0.05, 0x20);
  file.writeFloatLE(overrides?.exposure ?? 2.5, 0x24);
  file.writeFloatLE(overrides?.bottomExposure ?? 35, 0x28);
  file.writeFloatLE(1, 0x2c);
  file.writeUInt32LE(overrides?.bottomLayers ?? 8, 0x30);
  file.writeUInt32LE(1440, 0x34);
  file.writeUInt32LE(2560, 0x38);
  file.writeUInt32LE(420, 0x44);
  file.writeUInt32LE(14_400, 0x4c);
  file.writeUInt32LE(0x80, 0x54);
  file.writeUInt32LE(0x40, 0x58);
  file.writeUInt32LE(0xc0, 0x6c);

  // ExtConfig at 0x80
  file.writeFloatLE(8, 0x80); // bottom lift distance
  file.writeFloatLE(65, 0x84); // bottom lift speed
  file.writeFloatLE(overrides?.liftDistance ?? 5, 0x88);
  file.writeFloatLE(overrides?.liftSpeed ?? 120, 0x8c);
  file.writeFloatLE(150, 0x90); // retract speed
  file.writeFloatLE(31.25, 0x94); // resin volume
  file.writeFloatLE(34.5, 0x98); // resin mass
  file.writeFloatLE(overrides?.resinCost ?? 4.75, 0x9c);
  file.writeFloatLE(2, 0xa0); // bottom light off
  file.writeFloatLE(0.5, 0xa4); // light off
  file.writeUInt32LE(overrides?.bottomLayers ?? 8, 0xa8);

  // ExtConfig2 machine type pointer
  file.writeUInt32LE(0x100, 0xdc);
  file.writeUInt32LE(13, 0xe0);
  file.write("ELEGOO SATURN", 0x100, "ascii");
  return file;
}

test("parseCtbFile extracts resin, time, cost, and exposure settings", () => {
  const metrics = parseCtbFile("knight-plate-01.ctb", fixtureCtb());
  assert.equal(metrics.fileName, "knight-plate-01.ctb");
  assert.equal(metrics.printTimeSeconds, 14_400);
  assert.equal(metrics.resinVolumeMl, 31.25);
  assert.equal(metrics.resinMassG, 34.5);
  assert.equal(metrics.resinCost, 4.75);
  assert.equal(metrics.resinDensityGPerMl, 1.104);
  assert.equal(metrics.layerCount, 420);
  assert.equal(metrics.layerHeightMm, 0.05);
  assert.equal(metrics.modelHeightMm, 42.5);
  assert.equal(metrics.exposureSeconds, 2.5);
  assert.equal(metrics.bottomExposureSeconds, 35);
  assert.equal(metrics.lightOffSeconds, 0.5);
  assert.equal(metrics.bottomLightOffSeconds, 2);
  assert.equal(metrics.bottomLayerCount, 8);
  assert.equal(metrics.liftDistanceMm, 5);
  assert.equal(metrics.liftSpeedMmPerMin, 120);
  assert.equal(metrics.bottomLiftDistanceMm, 8);
  assert.equal(metrics.bottomLiftSpeedMmPerMin, 65);
  assert.equal(metrics.retractSpeedMmPerMin, 150);
  assert.equal(metrics.printerProfile, "ELEGOO SATURN");
  assert.match(metrics.sha256, /^[a-f0-9]{64}$/);
});

test("parseCtbFile rejects non-CTB buffers", () => {
  assert.throws(() => parseCtbFile("bad.bin", Buffer.alloc(8)), CtbParseError);
  assert.throws(() => parseCtbFile("tiny.ctb", Buffer.from([1, 2, 3])), CtbParseError);
});

test("parseCtbFile tolerates a truncated ExtConfig without inventing values", () => {
  const file = fixtureCtb();
  // Claim ExtConfig is only large enough for lift fields, not resin/cost.
  file.writeUInt32LE(0x14, 0x58);
  const metrics = parseCtbFile("partial.ctb", file);
  assert.equal(metrics.liftDistanceMm, 5);
  assert.equal(metrics.resinVolumeMl, null);
  assert.equal(metrics.resinCost, null);
  assert.equal(metrics.exposureSeconds, 2.5);
});
