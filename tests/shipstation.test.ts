import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dbFile = path.join(os.tmpdir(), `shipstation-test-${crypto.randomUUID()}.db`);
const ownerCode = "shipstation-owner";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update(ownerCode).digest("hex");
process.env.SHIPSTATION_WEBHOOK_KEY = "webhook-test-key";
process.env.SHIPSTATION_API_KEY = "api-key";
process.env.SHIPSTATION_API_SECRET = "api-secret";

const { mapShipmentStatus, upsertShipstationShipment, listShipstationShipments } = await import("../server/lib/shipstation");
const { registerRoutes } = await import("../server/routes");

let resourceServer: http.Server;
let appServer: http.Server;
let appBase = "";
let resourceBase = "";

function listen(server: http.Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

before(async () => {
  resourceServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      shipmentId: "ss-123", orderNumber: "44", shipTo: { name: "Alex Sample" }, carrierCode: "ups",
      serviceCode: "ups_ground", trackingNumber: "1ZTEST", shipDate: "2026-10-01T00:00:00Z", shipmentCost: 8.5,
    }));
  });
  resourceBase = `http://127.0.0.1:${await listen(resourceServer)}`;
  process.env.SHIPSTATION_API_BASE = resourceBase;
  process.env.HUBSPOT_API_BASE = resourceBase;
  process.env.HUBSPOT_ACCESS_TOKEN = "test";
  const app = express();
  app.use(express.json());
  appServer = http.createServer(app);
  await registerRoutes(appServer, app);
  appBase = `http://127.0.0.1:${await listen(appServer)}`;
});

after(() => {
  appServer.close();
  resourceServer.close();
  fs.rmSync(dbFile, { force: true });
});

test("ShipStation webhook rejects missing or incorrect key", async () => {
  const missing = await fetch(`${appBase}/api/shipstation/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const wrong = await fetch(`${appBase}/api/shipstation/webhook?key=wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
});

test("ShipStation webhook accepts quickly then stores its resource", async () => {
  const response = await fetch(`${appBase}/api/shipstation/webhook?key=webhook-test-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resource_type: "SHIP_NOTIFY", resource_url: `${resourceBase}/shipments/ss-123` }),
  });
  assert.equal(response.status, 200);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (listShipstationShipments().some((row) => row.shipmentId === "ss-123")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("webhook resource was not stored");
});

test("ShipStation upsert is idempotent and status mapping is conservative", () => {
  upsertShipstationShipment({ shipmentId: "idempotent", orderNumber: "9", shipToName: "Taylor Test", carrierCode: "usps", serviceCode: "ground", trackingNumber: "9400", shipDate: "2026-10-01T00:00:00Z", shipmentCost: "4.25", voided: false });
  upsertShipstationShipment({ shipmentId: "idempotent", orderNumber: "9", shipToName: "Taylor Test", carrierCode: "usps", serviceCode: "ground", trackingNumber: "9400", shipDate: "2026-10-01T00:00:00Z", shipmentCost: "4.25", voided: false });
  assert.equal(listShipstationShipments().filter((row) => row.shipmentId === "idempotent").length, 1);
  assert.equal(mapShipmentStatus("Delivered"), "delivered");
  assert.equal(mapShipmentStatus("OutForDelivery"), "out for delivery");
  assert.equal(mapShipmentStatus("mystery carrier phrase"), "label created");
});
