import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKitBitsFromFileNames,
  buildKitBitsFromImports,
  bindKitToDeal,
  createPlate,
  createSampleKit,
  inventory,
  markBitGood,
  markBitReprint,
  markPlateAllGood,
} from "../client/src/lib/kit-dry-run";
import { parsePersistedKit } from "../client/src/lib/kit-persistence";
import { collectStlFilesFromFileList, inferKitNameFromImports } from "../client/src/lib/stl-folder-import";

test("sample kit loads Acastus bits as needed inventory", () => {
  const kit = createSampleKit();
  const counts = inventory(kit);
  assert.ok(counts.total > 50);
  assert.equal(counts.needed, counts.total);
  assert.equal(counts.remaining, counts.total);
  assert.equal(counts.good, 0);
});

test("build kit bits from folder-style STL names", () => {
  const bits = buildKitBitsFromFileNames(["18 Head.stl", "19 Face Plate.stl", "18 Head.stl"], "acastus");
  assert.equal(bits.length, 2);
  assert.equal(bits[0]!.group, "Head");
  assert.equal(bits[0]!.status, "needed");
});

test("multi-folder imports group bits by subfolder / zip", () => {
  const bits = buildKitBitsFromImports(
    [
      { fileName: "18 Head.stl", relativePath: "Kit/Head/18 Head.stl", folderGroup: "Head" },
      { fileName: "39 Thigh Left.stl", relativePath: "Kit/Legs/39 Thigh Left.stl", folderGroup: "Legs" },
      { fileName: "60 Arm.stl", relativePath: "Kit/Arms/60 Arm.stl", folderGroup: "Arms" },
    ],
    "Kit",
  );
  assert.equal(bits.length, 3);
  assert.equal(bits[0]!.group, "Head");
  assert.equal(bits[1]!.group, "Legs");
  assert.equal(bits[2]!.group, "Arms");
});

test("flat imports keep filename heuristic groups", () => {
  const bits = buildKitBitsFromImports(
    [
      { fileName: "18 Head.stl", relativePath: "Kit/18 Head.stl", folderGroup: "Kit" },
      { fileName: "19 Face Plate.stl", relativePath: "Kit/19 Face Plate.stl", folderGroup: "Kit" },
    ],
    "Kit",
  );
  assert.equal(bits.every((bit) => bit.group === "Head"), true);
});

test("collectStlFilesFromFileList keeps unique basenames", () => {
  const files = [
    new File([""], "18 Head.stl", { type: "model/stl" }),
    new File([""], "19 Face Plate.stl", { type: "model/stl" }),
    new File([""], "notes.txt", { type: "text/plain" }),
  ];
  Object.defineProperty(files[0], "webkitRelativePath", { value: "Acastus Kit/Head/18 Head.stl" });
  const imports = collectStlFilesFromFileList(files);
  assert.equal(imports.length, 2);
  assert.equal(inferKitNameFromImports(imports), "Acastus Kit");
});

test("plate flow: needed → on plate → good / reprint → reprint selectable again", () => {
  let kit = createSampleKit();
  const torsoBits = kit.bits.filter((bit) => bit.group === "Torso / interior");
  assert.ok(torsoBits.length >= 3);

  const plated = createPlate(kit, {
    name: "P1",
    ctbFileName: "P1.ctb",
    bitIds: torsoBits.slice(0, 3).map((bit) => bit.id),
    printFileRecordId: 42,
  });
  assert.equal(plated.ok, true);
  if (!plated.ok) return;
  kit = plated.kit;
  assert.equal(inventory(kit).onPlate, 3);
  assert.equal(kit.plates[0]?.printFileRecordId, 42);

  const good = markBitGood(kit, torsoBits[0]!.id);
  assert.equal(good.ok, true);
  if (!good.ok) return;
  kit = good.kit;

  const reprint = markBitReprint(kit, torsoBits[1]!.id);
  assert.equal(reprint.ok, true);
  if (!reprint.ok) return;
  kit = reprint.kit;

  assert.equal(inventory(kit).good, 1);
  assert.equal(inventory(kit).reprint, 1);
  assert.equal(inventory(kit).onPlate, 1);

  const allGood = markPlateAllGood(kit, plated.plateId);
  assert.equal(allGood.ok, true);
  if (!allGood.ok) return;
  kit = allGood.kit;
  assert.equal(inventory(kit).onPlate, 0);
  assert.equal(inventory(kit).good, 2);
  assert.equal(inventory(kit).reprint, 1);

  const reprintBit = kit.bits.find((bit) => bit.id === torsoBits[1]!.id)!;
  const again = createPlate(kit, {
    name: "P2 reprint",
    ctbFileName: "P2.ctb",
    bitIds: [reprintBit.id],
  });
  assert.equal(again.ok, true);
});

test("bindKitToDeal keeps inventory and stores deal ids", () => {
  const sample = createSampleKit();
  const bound = bindKitToDeal(sample, { dealId: "deal-9", dealName: "Acastus - Buyer" });
  assert.equal(bound.hubspotDealId, "deal-9");
  assert.equal(bound.hubspotDealName, "Acastus - Buyer");
  assert.equal(bound.bits.length, sample.bits.length);

  const roundTrip = parsePersistedKit({
    version: 1,
    savedAt: new Date().toISOString(),
    kit: bound,
  });
  assert.ok(roundTrip);
  assert.equal(roundTrip!.hubspotDealId, "deal-9");
  assert.equal(roundTrip!.bits.length, bound.bits.length);
});

