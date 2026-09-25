import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { fulfillmentChecklists } from "../shared/schema";
import { attachShippingLabelToDeals } from "../server/lib/shipping-label-attach";
import { getDb, resetOrderLinkStore } from "../server/lib/order-links";
import { listStackState } from "../server/lib/priority-stack";
import { invalidatePrintOrderDealsCache } from "../server/lib/hubspot";
import { registerRoutes } from "../server/routes";

const DEAL = {
  id: "88001",
  properties: {
    dealname: "Armigers",
    amount: "59.99",
    pipeline: "default",
    dealstage: "ready",
    createdate: "2026-09-01T00:00:00.000Z",
  },
};

test("label attach counts in Out the door, a reprint does not re-send, and writes-off still marks done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "label-stack-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
  };
  const calls: string[] = [];
  const mock = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    const url = req.url || "";
    if (url.startsWith("/crm/v3/objects/deals/search")) {
      res.end(JSON.stringify({ results: [DEAL] }));
      return;
    }
    if (url.startsWith("/crm/v3/pipelines/deals/")) {
      res.end(JSON.stringify({
        stages: [
          { id: "ready", label: "Ready to Ship", displayOrder: 1, metadata: { isClosed: "false" } },
          { id: "closedwon", label: "Closed Won", displayOrder: 2, metadata: { isClosed: "true" } },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  resetOrderLinkStore();
  invalidatePrintOrderDealsCache();
  try {
    const first = await attachShippingLabelToDeals({
      dealIds: ["88001"],
      trackingNumber: "1ZFIRSTLABEL",
      notes: "Pirate Ship",
      postageUsd: "8.50",
      packingDone: true,
      labelBought: true,
      markComplete: true,
      messageChannel: "marketplace",
      liveWrite: false,
      shipengine: { labelId: "se_label_1", carrier: "ups", service: "ups_ground" },
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.duplicate) throw new Error("expected a first attach");
    const stamped = listStackState().entries.find((entry) => entry.hubspotDealId === "88001");
    assert.ok(stamped?.doneAt);
    assert.equal(stamped?.doneAmount, "59.99");
    assert.equal(stamped?.doneName, "Armigers");
    const stored = getDb().select().from(fulfillmentChecklists).where(eq(fulfillmentChecklists.hubspotDealId, "88001")).get();
    assert.equal(stored?.shipengineLabelId, "se_label_1");
    assert.equal(stored?.shipengineCarrier, "ups");
    assert.equal(stored?.shipengineService, "ups_ground");
    const emailCallsAfterFirst = calls.filter((call) => call.includes("/associations/contacts")).length;
    calls.length = 0;
    const reprint = await attachShippingLabelToDeals({
      dealIds: ["88001"],
      trackingNumber: "1ZREPRINTLABEL",
      notes: "replacement",
      postageUsd: "8.50",
      packingDone: true,
      labelBought: true,
      markComplete: true,
      messageChannel: "marketplace",
      liveWrite: false,
    });
    assert.equal(reprint.ok, true);
    if (!reprint.ok || reprint.duplicate) throw new Error("expected a reprint attach");
    assert.equal(reprint.buyerEmail?.reason, "Reprint keeps the first completion");
    assert.equal(reprint.marketplaceSend, null);
    const after = listStackState().entries.find((entry) => entry.hubspotDealId === "88001");
    assert.equal(after?.doneAt, stamped?.doneAt);
    assert.equal(after?.doneAmount, "59.99");
    const emailCallsAfterReprint = calls.filter((call) => call.includes("/associations/contacts")).length;
    assert.ok(emailCallsAfterReprint < emailCallsAfterFirst);
    assert.equal(calls.filter((call) => call.startsWith("PATCH")).length, 0);
  } finally {
    mock.close();
    resetOrderLinkStore();
    invalidatePrintOrderDealsCache();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("ORDER_LINKS_DB_FILE", previous.db);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Picked up closes the HubSpot stage when writes are on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-done-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
  };
  const patches: string[] = [];
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url || "";
      if (req.method === "PATCH" && url.includes("/crm/v3/objects/deals/")) patches.push(body);
      res.setHeader("content-type", "application/json");
      if (url.startsWith("/crm/v3/objects/deals/search")) {
        res.end(JSON.stringify({
          results: [{
            id: "88002",
            properties: {
              dealname: "Jose pickup",
              amount: "40",
              pipeline: "default",
              dealstage: "ready",
              createdate: "2026-09-01T00:00:00.000Z",
            },
          }],
        }));
        return;
      }
      if (url.startsWith("/crm/v3/pipelines/deals/")) {
        res.end(JSON.stringify({
          stages: [
            { id: "ready", label: "Ready to Ship", displayOrder: 1, metadata: { isClosed: "false" } },
            { id: "closedwon", label: "Closed Won", displayOrder: 2, metadata: { isClosed: "true" } },
          ],
        }));
        return;
      }
      res.end(JSON.stringify({ results: [] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  resetOrderLinkStore();
  invalidatePrintOrderDealsCache();
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/priority-stack/done`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paid-order-access-code": "stack-test" },
      body: JSON.stringify({ key: "deal:88002" }),
    });
    assert.equal(response.status, 200);
    const entry = listStackState().entries.find((row) => row.hubspotDealId === "88002");
    assert.ok(entry?.doneAt);
    assert.ok(patches.some((body) => body.includes("closedwon")));
  } finally {
    server.close();
    mock.close();
    resetOrderLinkStore();
    invalidatePrintOrderDealsCache();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("ORDER_LINKS_DB_FILE", previous.db);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    restore("PAID_ORDER_INTAKE_ACCESS_CODE_HASH", previous.hash);
    rmSync(dir, { recursive: true, force: true });
  }
});
