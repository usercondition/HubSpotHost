import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `supplies-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const {
  buildSupplySpendSummary,
  createSupplyPurchase,
  listSupplyPurchases,
  suggestSupplyCategory,
} = await import("../server/lib/supplies");

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

test("supply categories are suggested from common print-operation purchases", () => {
  assert.equal(suggestSupplyCategory("Elegoo ABS-like resin 2 kg"), "materials");
  assert.equal(suggestSupplyCategory("Nitrile gloves, 100 pack"), "consumables");
  assert.equal(suggestSupplyCategory("6 inch bubble wrap roll"), "packaging_shipping");
  assert.equal(suggestSupplyCategory("Replacement nFEP film"), "equipment_maintenance");
  assert.equal(suggestSupplyCategory("Desk organizer"), "other");
});

test("supply purchases are local records with a rolling spend summary", () => {
  const first = createSupplyPurchase({
    source: "Amazon",
    orderReference: "111-222",
    itemName: "Elegoo ABS-like resin 2 kg",
    totalAmount: "38.99",
    purchasedAt: "2026-08-01",
    quantity: 1,
    notes: "",
  });
  const second = createSupplyPurchase({
    source: "Amazon",
    orderReference: "",
    itemName: "Nitrile gloves, 100 pack",
    totalAmount: "12.50",
    purchasedAt: "2026-08-03",
    quantity: 1,
    notes: "",
  });

  assert.equal(first.category, "materials");
  assert.equal(second.category, "consumables");
  assert.equal(listSupplyPurchases().length, 2);

  const summary = buildSupplySpendSummary(new Date("2026-08-04T12:00:00.000Z"));
  assert.equal(summary.purchases, 2);
  assert.equal(summary.total, 51.49);
  assert.equal(summary.byCategory.find((bucket) => bucket.category === "materials")?.total, 38.99);
  assert.equal(summary.byCategory.find((bucket) => bucket.category === "consumables")?.total, 12.5);
});
