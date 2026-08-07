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
  inferItemGroupFromPath,
  listOrderParts,
  resolveImportItemGroups,
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

function makePlate(dealId: string, dealName: string, fileName = "P1.ctb") {
  return createPrintFileRecord({
    analysisId: crypto.randomUUID(),
    hubspotDealId: dealId,
    hubspotDealName: dealName,
    dealStage: "Printing",
    metrics: {
      format: "CTB",
      formatRevision: "test",
      fileName,
      fileSizeBytes: 100,
      sha256: crypto.randomUUID().replace(/-/g, ""),
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
}

test("inferItemGroupFromPath prefers zip name then top-level folder", () => {
  assert.equal(inferItemGroupFromPath("Acastus/Head/18 Head.stl"), "Acastus");
  assert.equal(inferItemGroupFromPath("Head/18 Head.stl", "Acastus.zip"), "Acastus");
  assert.equal(inferItemGroupFromPath("18 Head.stl"), "");
});

test("resolveImportItemGroups keeps one kit together and splits multi-root imports", () => {
  const single = resolveImportItemGroups([
    { fileName: "18 Head.stl", relativePath: "Acastus/Head/18 Head.stl" },
    { fileName: "39 Thigh.stl", relativePath: "Acastus/Legs/39 Thigh.stl" },
  ]);
  assert.deepEqual(
    single.map((row) => row.itemGroup),
    ["Acastus", "Acastus"],
  );

  const multi = resolveImportItemGroups([
    { fileName: "18 Head.stl", relativePath: "Acastus/Head/18 Head.stl" },
    { fileName: "18 Head.stl", relativePath: "Valiant/Head/18 Head.stl" },
  ]);
  assert.equal(multi[0]!.itemGroup, "Acastus");
  assert.equal(multi[1]!.itemGroup, "Valiant");

  const forced = resolveImportItemGroups(
    [{ fileName: "18 Head.stl", relativePath: "Acastus/Head/18 Head.stl" }],
    "Valiant",
  );
  assert.equal(forced[0]!.itemGroup, "Valiant");
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
  assert.equal(imported.summary.itemGroups.length, 1);
  assert.equal(imported.summary.itemGroups[0]!.itemGroup, "Kit");

  const plate = makePlate("1234567890", "Acastus - Client");

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

test("multi-item orders keep colliding STL names in separate item groups", () => {
  const dealId = "9988776655";
  const acastus = importOrderParts(dealId, {
    dealName: "Acastus + Valiant",
    defaultItemGroup: "Acastus",
    fileNames: ["18 Head.stl", "39 Thigh Left.stl"],
  });
  assert.equal(acastus.ok, true);
  if (!acastus.ok) return;
  assert.equal(acastus.added, 2);

  const valiant = importOrderParts(dealId, {
    dealName: "Acastus + Valiant",
    defaultItemGroup: "Valiant",
    fileNames: ["18 Head.stl", "40 Foot.stl"],
  });
  assert.equal(valiant.ok, true);
  if (!valiant.ok) return;
  assert.equal(valiant.added, 2);

  const view = getOrderPartsView(dealId);
  assert.equal(view.summary.total, 4);
  assert.equal(view.summary.itemGroups.length, 2);
  assert.equal(view.summary.needed, 4);

  const plate = makePlate(dealId, "Acastus + Valiant", "P-Acastus.ctb");
  const plated = addBitsToRecord(plate.id, [
    { fileName: "18 Head.stl", archivePath: "Acastus.zip", relativePath: "Acastus.zip/18 Head.stl" },
    {
      fileName: "39 Thigh Left.stl",
      archivePath: "Acastus.zip",
      relativePath: "Acastus.zip/39 Thigh Left.stl",
    },
  ]);
  assert.equal(plated.ok, true);
  if (!plated.ok) return;

  const afterPlate = getOrderPartsView(dealId);
  const acastusHead = afterPlate.parts.find(
    (part) => part.itemGroup === "Acastus" && part.fileName === "18 Head.stl",
  )!;
  const valiantHead = afterPlate.parts.find(
    (part) => part.itemGroup === "Valiant" && part.fileName === "18 Head.stl",
  )!;
  assert.equal(acastusHead.status, "on_plate");
  assert.equal(valiantHead.status, "needed");
  assert.equal(afterPlate.summary.itemGroups.find((g) => g.itemGroup === "Acastus")!.remaining, 0);
  assert.equal(afterPlate.summary.itemGroups.find((g) => g.itemGroup === "Valiant")!.remaining, 2);

  const plate2 = makePlate(dealId, "Acastus + Valiant", "P-Valiant.ctb");
  const plated2 = addBitsToRecord(plate2.id, [
    { fileName: "18 Head.stl", itemGroup: "Valiant" },
    { fileName: "40 Foot.stl", itemGroup: "Valiant" },
  ]);
  assert.equal(plated2.ok, true);
  if (!plated2.ok) return;

  const done = getOrderPartsView(dealId);
  assert.equal(done.summary.remaining, 0);
  assert.equal(done.summary.onPlate, 4);
  assert.equal(
    done.parts.find((part) => part.itemGroup === "Valiant" && part.fileName === "18 Head.stl")!
      .status,
    "on_plate",
  );
});

test("path-based multi-root import creates separate item groups without defaultItemGroup", () => {
  const dealId = "1122334455";
  const imported = importOrderParts(dealId, {
    dealName: "Combo",
    parts: [
      { fileName: "18 Head.stl", relativePath: "Acastus/Head/18 Head.stl" },
      { fileName: "18 Head.stl", relativePath: "Valiant/Head/18 Head.stl" },
    ],
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.equal(imported.added, 2);
  assert.equal(imported.summary.itemGroups.length, 2);
  assert.ok(imported.parts.some((part) => part.itemGroup === "Acastus"));
  assert.ok(imported.parts.some((part) => part.itemGroup === "Valiant"));
});
