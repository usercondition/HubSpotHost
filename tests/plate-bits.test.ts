import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `plate-bits-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const { createPrintFileRecord } = await import("../server/lib/print-files");
const {
  addBitsToRecord,
  deleteBit,
  listBitsForRecord,
  summarizeBits,
  updateBitStatus,
} = await import("../server/lib/plate-bits");

after(() => {
  resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

function attachSamplePlate() {
  return createPrintFileRecord({
    analysisId: crypto.randomUUID(),
    hubspotDealId: "1234567890",
    hubspotDealName: "Test Order",
    dealStage: "Printing",
    metrics: {
      format: "CTB",
      formatRevision: "test",
      fileName: "Plate_1.ctb",
      fileSizeBytes: 1000,
      sha256: "abc",
      printTimeSeconds: 3600,
      resinVolumeMl: 10,
      resinMassG: 12,
      resinCost: 1.5,
      resinCostSource: "ctb",
      resinCostLabel: null,
      resinDensityGPerMl: 1.1,
      layerCount: 100,
      layerHeightMm: 0.05,
      modelHeightMm: 5,
      exposureSeconds: 2,
      bottomExposureSeconds: 30,
      lightOffSeconds: 1,
      bottomLightOffSeconds: 1,
      bottomLayerCount: 5,
      liftDistanceMm: 5,
      liftSpeedMmPerMin: 60,
      bottomLiftDistanceMm: 5,
      bottomLiftSpeedMmPerMin: 40,
      retractSpeedMmPerMin: 60,
      resolutionX: 1000,
      resolutionY: 1000,
      printerProfile: "Test",
    },
  });
}

test("add STL names to an attached plate and mark QC", () => {
  const plate = attachSamplePlate();
  const added = addBitsToRecord(plate.id, [
    "Head/18 Head.stl",
    "19 Face Plate.stl",
    "notes.txt",
    "18 Head.stl",
  ]);
  assert.equal(added.ok, true);
  if (!added.ok) return;
  assert.equal(added.added, 2);
  assert.equal(added.bits.length, 2);
  assert.equal(added.bits[0]!.fileName, "18 Head.stl");
  assert.equal(added.bits[0]!.status, "on_plate");

  const good = updateBitStatus(plate.id, added.bits[0]!.id, "good");
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.bit.status, "good");

  const reprint = updateBitStatus(plate.id, added.bits[1]!.id, "reprint");
  assert.equal(reprint.ok, true);

  const summary = summarizeBits(listBitsForRecord(plate.id));
  assert.equal(summary.total, 2);
  assert.equal(summary.good, 1);
  assert.equal(summary.reprint, 1);
  assert.equal(summary.onPlate, 0);
});

test("rejects non-stl-only drops and can delete a bit", () => {
  const plate = attachSamplePlate();
  const none = addBitsToRecord(plate.id, ["readme.txt", "Plate.ctb"]);
  assert.equal(none.ok, false);

  const added = addBitsToRecord(plate.id, ["part.stl"]);
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const removed = deleteBit(plate.id, added.bits[0]!.id);
  assert.equal(removed.ok, true);
  assert.equal(listBitsForRecord(plate.id).length, 0);
});
