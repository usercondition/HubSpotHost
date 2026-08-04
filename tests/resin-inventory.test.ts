/**
 * Resin inventory: sealed stock, open bottles, plate consumption, economics.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dbFile = path.join(os.tmpdir(), `resin-inventory-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "resin-owner-code";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");

const store = await import("../server/lib/order-links");
const {
  ensureDefaultResinInventory,
  openResinBottle,
  consumeResinForAttachedPlate,
  buildResinInventorySnapshot,
  adjustSealedStock,
  upsertResinProduct,
} = await import("../server/lib/resin-inventory");
const { stagePrintFile, createPrintFileRecord } = await import("../server/lib/print-files");
const { registerRoutes } = await import("../server/routes");

let mock: http.Server;
let app: http.Server;
let appBase = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function jsonOwnerRequest(method: string, url: string, body?: unknown) {
  const response = await fetch(`${appBase}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function fixtureCtb(): Buffer {
  const file = Buffer.alloc(0x180);
  file.writeUInt32LE(0x12fd0086, 0x00);
  file.writeUInt32LE(4, 0x04);
  file.writeFloatLE(218, 0x08);
  file.writeFloatLE(123, 0x0c);
  file.writeFloatLE(260, 0x10);
  file.writeFloatLE(42.5, 0x1c);
  file.writeFloatLE(0.05, 0x20);
  file.writeFloatLE(2.5, 0x24);
  file.writeFloatLE(35, 0x28);
  file.writeFloatLE(1, 0x2c);
  file.writeUInt32LE(8, 0x30);
  file.writeUInt32LE(1440, 0x34);
  file.writeUInt32LE(2560, 0x38);
  file.writeUInt32LE(420, 0x44);
  file.writeUInt32LE(14_400, 0x4c);
  file.writeUInt32LE(0x80, 0x54);
  file.writeUInt32LE(0x40, 0x58);
  file.writeUInt32LE(0xc0, 0x6c);
  file.writeFloatLE(8, 0x80);
  file.writeFloatLE(65, 0x84);
  file.writeFloatLE(5, 0x88);
  file.writeFloatLE(120, 0x8c);
  file.writeFloatLE(150, 0x90);
  file.writeFloatLE(31.25, 0x94);
  file.writeFloatLE(34.5, 0x98);
  file.writeFloatLE(4.75, 0x9c);
  file.writeFloatLE(2, 0xa0);
  file.writeFloatLE(0.5, 0xa4);
  file.writeUInt32LE(8, 0xa8);
  file.writeUInt32LE(0x100, 0xdc);
  file.writeUInt32LE(13, 0xe0);
  file.write("ELEGOO SATURN", 0x100, "ascii");
  return file;
}

before(async () => {
  mock = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "ok", results: [], stages: [] }));
  });
  const mockPort = await listen(mock);
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";

  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  const port = await listen(app);
  appBase = `http://127.0.0.1:${port}`;
});

after(() => {
  mock?.close();
  app?.close();
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* cleanup */
    }
  }
});

test("seeds 8 sealed ELEGOO ABS-Like 3.0 bottles when inventory is empty", () => {
  const products = ensureDefaultResinInventory();
  assert.equal(products.length, 1);
  assert.match(products[0]!.name, /ABS-Like 3\.0/i);
  assert.equal(products[0]!.sealedCount, 8);
  assert.equal(products[0]!.bottleMassG, "1000");
});

test("opening a bottle decrements sealed stock and becomes active", () => {
  const products = ensureDefaultResinInventory();
  const product = upsertResinProduct({
    name: products[0]!.name,
    brand: "ELEGOO",
    bottleMassG: 1000,
    unitCostUsd: 40,
    sealedCount: products[0]!.sealedCount,
    notes: "",
  });
  const opened = openResinBottle({ productId: product.id, makeActive: true, notes: "" });
  assert.ok(opened);
  assert.equal(opened!.product.sealedCount, product.sealedCount - 1);
  assert.equal(opened!.bottle.isActive, 1);
  assert.equal(opened!.bottle.remainingMassG, "1000");
  assert.equal(opened!.bottle.unitCostUsd, "40");
});

test("attached plate mass consumes the active bottle and attributes deal revenue", () => {
  const snapshotBefore = buildResinInventorySnapshot();
  const product = snapshotBefore.products[0]!;
  if (!snapshotBefore.activeBottle) {
    openResinBottle({ productId: product.id, makeActive: true, notes: "" });
  }

  const staged = stagePrintFile("resin-plate.ctb", fixtureCtb());
  const record = createPrintFileRecord({
    analysisId: staged.analysisId,
    hubspotDealId: "5501",
    hubspotDealName: "Resin Knight",
    dealStage: "In work",
    metrics: staged.metrics,
  });
  assert.ok(staged.metrics.resinMassG);

  const consumed = consumeResinForAttachedPlate({
    record,
    metrics: staged.metrics,
    dealAmount: "150",
  });
  assert.ok(consumed);
  assert.equal(consumed!.consumedMassG, staged.metrics.resinMassG);
  assert.ok(consumed!.remainingMassG < 1000);

  const snapshot = buildResinInventorySnapshot();
  const active = snapshot.activeBottle ?? snapshot.bottles[0];
  assert.ok(active);
  assert.ok(active!.usedMassG > 0);
  assert.equal(active!.attributedDealRevenueUsd, 150);
  assert.ok(active!.materialCostUsedUsd > 0);
});

test("owner API exposes inventory and can open a bottle", async () => {
  const blocked = await fetch(`${appBase}/api/resin-inventory`);
  assert.equal(blocked.status, 401);

  const listed = await jsonOwnerRequest("GET", "/api/resin-inventory");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.totals.sealedBottles >= 0);
  assert.ok(listed.body.products.length >= 1);

  const product = listed.body.products[0];
  await jsonOwnerRequest("POST", `/api/resin-inventory/products/${product.id}/adjust-sealed`, {
    delta: 1,
    unitCostUsd: 42,
  });

  const opened = await jsonOwnerRequest("POST", "/api/resin-inventory/open-bottle", {
    productId: product.id,
    makeActive: true,
  });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.bottle.isActive, 1);

  const after = await jsonOwnerRequest("GET", "/api/resin-inventory");
  assert.ok(after.body.activeBottle);
});

test("adjust sealed stock cannot go below zero", () => {
  const product = ensureDefaultResinInventory()[0]!;
  const updated = adjustSealedStock(product.id, { delta: -(product.sealedCount + 50), notes: "" });
  assert.equal(updated?.sealedCount, 0);
});
