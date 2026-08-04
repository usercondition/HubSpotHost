/**
 * Unit tests for Chitubox CTB header parsing.
 *
 * Covers classic unencrypted headers and encrypted CTB v4/v5 settings blocks
 * used by modern printers such as the Elegoo Mighty 8K.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CtbParseError,
  encryptCtbSettingsBlock,
  parseCtbFile,
} from "../server/lib/ctb";

function fixtureClassicCtb(overrides?: {
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

  file.writeFloatLE(8, 0x80);
  file.writeFloatLE(65, 0x84);
  file.writeFloatLE(overrides?.liftDistance ?? 5, 0x88);
  file.writeFloatLE(overrides?.liftSpeed ?? 120, 0x8c);
  file.writeFloatLE(150, 0x90);
  file.writeFloatLE(31.25, 0x94);
  file.writeFloatLE(34.5, 0x98);
  file.writeFloatLE(overrides?.resinCost ?? 4.75, 0x9c);
  file.writeFloatLE(2, 0xa0);
  file.writeFloatLE(0.5, 0xa4);
  file.writeUInt32LE(overrides?.bottomLayers ?? 8, 0xa8);

  file.writeUInt32LE(0x100, 0xdc);
  file.writeUInt32LE(13, 0xe0);
  file.write("ELEGOO SATURN", 0x100, "ascii");
  return file;
}

function fixtureEncryptedCtb(): Buffer {
  const machineName = "ELEGOO Mighty 8K";
  const settingsPlain = Buffer.alloc(288, 0);
  settingsPlain.writeBigUInt64LE(0xcafebabecafebaben, 0);
  settingsPlain.writeUInt32LE(0x200, 8); // layer pointers
  settingsPlain.writeFloatLE(218.88, 12); // display width
  settingsPlain.writeFloatLE(122.88, 16); // display height
  settingsPlain.writeFloatLE(260, 20); // machine Z
  settingsPlain.writeFloatLE(48.25, 32); // model height
  settingsPlain.writeFloatLE(0.05, 36); // layer height
  settingsPlain.writeFloatLE(2.8, 40); // exposure
  settingsPlain.writeFloatLE(35, 44); // bottom exposure
  settingsPlain.writeFloatLE(0.5, 48); // light off
  settingsPlain.writeUInt32LE(8, 52); // bottom layers
  settingsPlain.writeUInt32LE(7680, 56); // res X
  settingsPlain.writeUInt32LE(4320, 60); // res Y
  settingsPlain.writeUInt32LE(965, 64); // layer count
  settingsPlain.writeUInt32LE(18_000, 76); // print time
  settingsPlain.writeFloatLE(8, 84); // bottom lift height
  settingsPlain.writeFloatLE(65, 88); // bottom lift speed
  settingsPlain.writeFloatLE(5, 92); // lift height
  settingsPlain.writeFloatLE(120, 96); // lift speed
  settingsPlain.writeFloatLE(150, 100); // retract speed
  settingsPlain.writeFloatLE(87.5, 104); // resin ml
  settingsPlain.writeFloatLE(96.25, 108); // resin g
  settingsPlain.writeFloatLE(12.4, 112); // resin cost
  settingsPlain.writeFloatLE(2, 116); // bottom light off
  settingsPlain.writeUInt32LE(0x130, 160); // machine name offset
  settingsPlain.writeUInt32LE(machineName.length, 164);

  const encryptedSettings = encryptCtbSettingsBlock(settingsPlain);
  const file = Buffer.alloc(0x160, 0);
  file.writeUInt32LE(0x12fd0107, 0x00);
  file.writeUInt32LE(encryptedSettings.length, 0x04);
  file.writeUInt32LE(0x30, 0x08); // settings offset
  file.writeUInt32LE(5, 0x10); // version
  encryptedSettings.copy(file, 0x30);
  file.write(machineName, 0x130, "ascii");
  return file;
}

test("parseCtbFile extracts resin, time, cost, and exposure settings from classic CTB", () => {
  const metrics = parseCtbFile("knight-plate-01.ctb", fixtureClassicCtb());
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
  assert.match(metrics.formatRevision, /CTB header/);
  assert.match(metrics.sha256, /^[a-f0-9]{64}$/);
});

test("parseCtbFile decrypts modern encrypted CTB settings (Mighty 8K style)", () => {
  const metrics = parseCtbFile("Mighty 8K NEWX1 Sigismund.ctb", fixtureEncryptedCtb());
  assert.equal(metrics.printTimeSeconds, 18_000);
  assert.equal(metrics.resinVolumeMl, 87.5);
  assert.equal(metrics.resinMassG, 96.25);
  assert.equal(metrics.resinCost, 12.4);
  assert.equal(metrics.resinDensityGPerMl, 1.1);
  assert.equal(metrics.layerCount, 965);
  assert.equal(metrics.layerHeightMm, 0.05);
  assert.equal(metrics.modelHeightMm, 48.25);
  assert.equal(metrics.exposureSeconds, 2.8);
  assert.equal(metrics.bottomExposureSeconds, 35);
  assert.equal(metrics.lightOffSeconds, 0.5);
  assert.equal(metrics.bottomLightOffSeconds, 2);
  assert.equal(metrics.bottomLayerCount, 8);
  assert.equal(metrics.liftDistanceMm, 5);
  assert.equal(metrics.liftSpeedMmPerMin, 120);
  assert.equal(metrics.bottomLiftDistanceMm, 8);
  assert.equal(metrics.bottomLiftSpeedMmPerMin, 65);
  assert.equal(metrics.retractSpeedMmPerMin, 150);
  assert.equal(metrics.resolutionX, 7680);
  assert.equal(metrics.resolutionY, 4320);
  assert.equal(metrics.printerProfile, "ELEGOO Mighty 8K");
  assert.match(metrics.formatRevision, /CTB encrypted v5/i);
});

test("parseCtbFile rejects non-CTB buffers", () => {
  assert.throws(() => parseCtbFile("bad.bin", Buffer.alloc(8)), CtbParseError);
  assert.throws(() => parseCtbFile("tiny.ctb", Buffer.from([1, 2, 3])), CtbParseError);
});

test("parseCtbFile tolerates a truncated ExtConfig without inventing values", () => {
  const file = fixtureClassicCtb();
  file.writeUInt32LE(0x14, 0x58);
  const metrics = parseCtbFile("partial.ctb", file);
  assert.equal(metrics.liftDistanceMm, 5);
  assert.equal(metrics.resinVolumeMl, null);
  assert.equal(metrics.resinCost, null);
  assert.equal(metrics.exposureSeconds, 2.5);
});
