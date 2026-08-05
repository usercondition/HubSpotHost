import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKitBitsFromFileNames,
  createPlate,
  createSampleKit,
  inventory,
  markBitGood,
  markBitReprint,
  markPlateAllGood,
} from "../client/src/lib/kit-dry-run";
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
  });
  assert.equal(plated.ok, true);
  if (!plated.ok) return;
  kit = plated.kit;
  assert.equal(inventory(kit).onPlate, 3);

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
