import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `order-parts-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const { createPrintFileRecord } = await import("../server/lib/print-files");
const { addBitsToRecord, updateBitStatus } = await import("../server/lib/plate-bits");
const {
  getOrderPartsView,
  importOrderParts,
  listOrderParts,
} = await import("../server/lib/order-parts");

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

test("import kit parts then plate drops subtract from the order list", () => {
  const imported = importOrderParts("1234567890", {
    dealName: "Acastus - Client",
    fileNames: ["18 Head.stl", "19 Face Plate.stl", "39 Thigh Left.stl", "readme.txt"],
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.equal(imported.added, 3);
  assert.equal(imported.summary.needed, 3);
  assert.equal(imported.summary.remaining, 3);

  const plate = createPrintFileRecord({
    analysisId: crypto.randomUUID(),
    hubspotDealId: "1234567890",
    hubspotDealName: "Acastus - Client",
    dealStage: "Printing",
    metrics: {
      format: "CTB",
      formatRevision: "test",
      fileName: "P1.ctb",
      fileSizeBytes: 100,
      sha256: "abc",
      printTimeSeconds: 100,
      resinVolumeMl: 1,
      resinMassG: 1,
      resinCost: 1,
      resinCostSource: "ctb",
      resinCostLabel: null,
      resinDensityGPerMl: 1,
      layerCount: 10,
      layerHeightMm: 0.05,
      modelHeightMm: 1,
      exposureSeconds: 2,
      bottomExposureSeconds: 20,
      lightOffSeconds: 1,
      bottomLightOffSeconds: 1,
      bottomLayerCount: 4,
      liftDistanceMm: 5,
      liftSpeedMmPerMin: 60,
      bottomLiftDistanceMm: 5,
      bottomLiftSpeedMmPerMin: 40,
      retractSpeedMmPerMin: 60,
      resolutionX: 100,
      resolutionY: 100,
      printerProfile: "Test",
    },
  });

  const plated = addBitsToRecord(plate.id, ["18 Head.stl", "19 Face Plate.stl"]);
  assert.equal(plated.ok, true);
  if (!plated.ok) return;
  assert.equal(plated.added, 2);

  let view = getOrderPartsView("1234567890");
  assert.equal(view.summary.onPlate, 2);
  assert.equal(view.summary.needed, 1);
  assert.equal(view.summary.remaining, 1);

  const head = plated.bits.find((bit) => bit.fileName === "18 Head.stl")!;
  updateBitStatus(plate.id, head.id, "good");
  view = getOrderPartsView("1234567890");
  assert.equal(view.summary.good, 1);
  assert.equal(view.summary.onPlate, 1);
  assert.equal(view.summary.needed, 1);

  const face = plated.bits.find((bit) => bit.fileName === "19 Face Plate.stl")!;
  updateBitStatus(plate.id, face.id, "reprint");
  view = getOrderPartsView("1234567890");
  assert.equal(view.summary.reprint, 1);
  assert.equal(view.summary.remaining, 2); // thigh needed + face reprint
  assert.ok(listOrderParts("1234567890").some((part) => part.fileName === "39 Thigh Left.stl"));
});
