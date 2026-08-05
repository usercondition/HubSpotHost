import test from "node:test";
import assert from "node:assert/strict";
import {
  attachOrderPlate,
  buildKitBitsFromFileNames,
  completePlateQc,
  createPlateFromReprintPool,
  createSampleShop,
  orderProgress,
  reprintPool,
  setPlateBitResult,
  shopProgress,
} from "../client/src/lib/kit-dry-run";
import { collectStlFilesFromFileList, inferKitNameFromImports } from "../client/src/lib/stl-folder-import";

test("sample shop has multiple clients and kits", () => {
  const shop = createSampleShop();
  assert.equal(shop.orders.length, 3);
  assert.ok(shop.orders.some((order) => order.clientName === "Ada Lovelace"));
  assert.ok(shop.orders.some((order) => order.clientName === "Bob Martin"));
});

test("build kit bits from folder-style STL names", () => {
  const bits = buildKitBitsFromFileNames(["18 Head.stl", "19 Face Plate.stl", "18 Head.stl"], "acastus");
  assert.equal(bits.length, 2);
  assert.equal(bits[0]!.group, "Head");
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

test("QC reprint sends bits to pool; plate comes from pool selection", () => {
  let shop = createSampleShop();
  const order = shop.orders[0]!;
  const bitIds = order.bits.filter((bit) => bit.group === "Head").map((bit) => bit.id);
  const attached = attachOrderPlate(shop, {
    orderId: order.id,
    plateName: "P1",
    ctbFileName: "P1.ctb",
    bitIds,
  });
  assert.equal(attached.ok, true);
  if (!attached.ok) return;
  shop = attached.shop;

  shop = setPlateBitResult(shop, attached.plateId, order.id, bitIds[0]!, "good");
  shop = setPlateBitResult(shop, attached.plateId, order.id, bitIds[1]!, "reprint");
  const finished = completePlateQc(shop, attached.plateId);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  shop = finished.shop;

  assert.equal(orderProgress(shop.orders[0]!).done, 1);
  assert.equal(reprintPool(shop).length, 1);

  const made = createPlateFromReprintPool(shop, {
    selections: reprintPool(shop).map((item) => ({ orderId: item.orderId, bitId: item.bitId })),
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(shopProgress(made.shop).printing, 1);
  assert.equal(shopProgress(made.shop).reprint, 0);
});
