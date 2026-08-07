import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `kits-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const {
  deleteKitForDeal,
  getKitForDeal,
  listKitSummaries,
  upsertKitForDeal,
} = await import("../server/lib/kits");

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

const sampleKit = {
  name: "Acastus Knight",
  hubspotDealId: "1234567890",
  hubspotDealName: "Acastus - Buyer",
  bits: [
    {
      id: "b1",
      fileName: "18 Head.stl",
      label: "18 Head",
      group: "Head",
      status: "needed" as const,
      plateId: null,
    },
    {
      id: "b2",
      fileName: "39 Thigh Left.stl",
      label: "39 Thigh Left",
      group: "Waist / legs",
      status: "good" as const,
      plateId: null,
    },
  ],
  plates: [
    {
      id: "p1",
      name: "Plate 1",
      ctbFileName: "P1.ctb",
      createdAt: "2026-08-05T12:00:00.000Z",
      bitIds: ["b2"],
      printFileRecordId: 7,
    },
  ],
};

test("upsert and get kit by HubSpot deal id", () => {
  const saved = upsertKitForDeal("1234567890", { kit: sampleKit, dealName: "Acastus - Buyer" });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.summary.totalBits, 2);
  assert.equal(saved.summary.good, 1);
  assert.equal(saved.summary.needed, 1);
  assert.equal(saved.summary.plateCount, 1);

  const loaded = getKitForDeal("1234567890");
  assert.ok(loaded.kit);
  assert.equal(loaded.kit!.bits.length, 2);
  assert.equal(loaded.kit!.hubspotDealId, "1234567890");
  assert.equal(loaded.summary?.good, 1);
});

test("listKitSummaries returns recent kits", () => {
  upsertKitForDeal("1234567890", { kit: sampleKit });
  upsertKitForDeal("999", {
    kit: {
      ...sampleKit,
      hubspotDealId: "999",
      name: "Second kit",
      bits: [sampleKit.bits[0]!],
      plates: [],
    },
  });
  const list = listKitSummaries();
  assert.ok(list.length >= 2);
  assert.ok(list.some((row) => row.hubspotDealId === "999"));
});

test("deleteKitForDeal removes the row", () => {
  upsertKitForDeal("555", { kit: { ...sampleKit, hubspotDealId: "555", name: "Temp" } });
  assert.equal(deleteKitForDeal("555"), true);
  assert.equal(getKitForDeal("555").kit, null);
});

test("rejects non-numeric deal ids", () => {
  const result = upsertKitForDeal("not-a-deal", { kit: sampleKit });
  assert.equal(result.ok, false);
});
