import test from "node:test";
import assert from "node:assert/strict";
import {
  attachOrderPlate,
  completePlateQc,
  createPlateFromReprintPool,
  createSampleShop,
  orderProgress,
  reprintPool,
  setPlateBitResult,
  shopProgress,
} from "../client/src/lib/kit-dry-run";

test("sample shop has multiple clients and kits", () => {
  const shop = createSampleShop();
  assert.equal(shop.orders.length, 3);
  assert.ok(shop.orders.some((order) => order.clientName === "Ada Lovelace"));
  assert.ok(shop.orders.some((order) => order.clientName === "Bob Martin"));
  assert.ok(shop.orders[0]!.bits.length > 50);
});

test("QC reprint sends bits to pool, not a new plate", () => {
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
  const plateId = attached.plateId;

  shop = setPlateBitResult(shop, plateId, order.id, bitIds[0]!, "good");
  shop = setPlateBitResult(shop, plateId, order.id, bitIds[1]!, "reprint");
  const finished = completePlateQc(shop, plateId);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;

  shop = finished.shop;
  assert.equal(orderProgress(shop.orders[0]!).done, 1);
  assert.equal(orderProgress(shop.orders[0]!).reprint, 1);
  assert.equal(reprintPool(shop).length, 1);
  assert.equal(shop.plates.filter((plate) => plate.status === "pending_qc").length, 0);
});

test("reprint plate is created from pool selection across orders", () => {
  let shop = createSampleShop();

  // Fail one bit on Ada Acastus
  const ada = shop.orders[0]!;
  const adaBits = ada.bits.filter((bit) => bit.group === "Head").map((bit) => bit.id);
  let step = attachOrderPlate(shop, { orderId: ada.id, plateName: "A1", bitIds: adaBits });
  assert.equal(step.ok, true);
  if (!step.ok) return;
  shop = step.shop;
  for (const bitId of adaBits) shop = setPlateBitResult(shop, step.plateId, ada.id, bitId, "reprint");
  let qc = completePlateQc(shop, step.plateId);
  assert.equal(qc.ok, true);
  if (!qc.ok) return;
  shop = qc.shop;

  // Fail one bit on Bob
  const bob = shop.orders[2]!;
  const bobBit = bob.bits[0]!;
  step = attachOrderPlate(shop, { orderId: bob.id, plateName: "B1", bitIds: [bobBit.id] });
  assert.equal(step.ok, true);
  if (!step.ok) return;
  shop = step.shop;
  shop = setPlateBitResult(shop, step.plateId, bob.id, bobBit.id, "reprint");
  qc = completePlateQc(shop, step.plateId);
  assert.equal(qc.ok, true);
  if (!qc.ok) return;
  shop = qc.shop;

  const pool = reprintPool(shop);
  assert.ok(pool.length >= 3);

  const made = createPlateFromReprintPool(shop, {
    selections: pool.map((item) => ({ orderId: item.orderId, bitId: item.bitId })),
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(made.count, pool.length);
  assert.equal(shopProgress(made.shop).reprint, 0);
  assert.equal(shopProgress(made.shop).printing, pool.length);
  assert.equal(made.shop.plates[0]?.kind, "reprint");
});
