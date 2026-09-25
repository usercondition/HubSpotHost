import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDealCosts } from "../server/lib/deal-ops";
import { submitHubspotWrite, overlayPendingHubspotWrites } from "../server/lib/hubspot-writes";
import { lastHubspotWriteSuccessAt } from "../server/lib/hubspot-write-log";
import { getSqlite, resetOrderLinkStore } from "../server/lib/order-links";
import { registerRoutes } from "../server/routes";
import {
  clearWebhookDiagnosticMemory,
  getLatestWebhookDiagnostic,
  publicBaseHostMatches,
  recordWebhookDiagnostic,
} from "../server/lib/webhook-diagnostics";
import { acceptWebhookBatch, processWebhookInbox, webhookProcessingSettled } from "../server/lib/webhook-inbox";

function useTempDb(): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loss-proof-"));
  const previous = process.env.ORDER_LINKS_DB_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  resetOrderLinkStore();
  clearWebhookDiagnosticMemory();
  return {
    restore: () => {
      resetOrderLinkStore();
      clearWebhookDiagnosticMemory();
      if (previous === undefined) delete process.env.ORDER_LINKS_DB_FILE;
      else process.env.ORDER_LINKS_DB_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("webhook deliveries are stored once and survive a process restart", () => {
  const db = useTempDb();
  try {
    const first = acceptWebhookBatch(
      [{ eventId: 42, objectId: 901, objectTypeId: "0-3", propertyName: "amount" }],
      true,
    );
    assert.equal(first.stored, 1);
    assert.equal(first.duplicates, 0);
    const again = acceptWebhookBatch(
      [{ eventId: 42, objectId: 901, objectTypeId: "0-3", propertyName: "amount" }],
      true,
    );
    assert.equal(again.stored, 0);
    assert.equal(again.duplicates, 1);

    recordWebhookDiagnostic({
      result: "accepted",
      version: "v3",
      reason: "v3 signature valid",
      eventCount: 4,
    });
    clearWebhookDiagnosticMemory();
    const loaded = getLatestWebhookDiagnostic();
    assert.equal(loaded?.result, "accepted");
    assert.equal(loaded?.eventCount, 4);
    assert.match(loaded?.receivedAt ?? "", /T/);
  } finally {
    db.restore();
  }
});

test("public base host match is a flag and does not echo either host", () => {
  const previous = process.env.PUBLIC_BASE_URL;
  try {
    process.env.PUBLIC_BASE_URL = "https://signatures-host.example";
    assert.equal(publicBaseHostMatches("signatures-host.example"), true);
    assert.equal(publicBaseHostMatches("other.example"), false);
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(publicBaseHostMatches("signatures-host.example"), null);
    assert.equal(JSON.stringify(publicBaseHostMatches("signatures-host.example")).includes("signatures-host"), false);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previous;
  }
});

test("a failed recalc is kept and the webhook ack does not wait for it", async () => {
  const db = useTempDb();
  const previous = {
    node: process.env.NODE_ENV,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    secret: process.env.HUBSPOT_WEBHOOK_SECRET,
  };
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = http.createServer((_req, res) => {
    void gate.then(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: "nope" }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.NODE_ENV = "test";
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  delete process.env.HUBSPOT_WEBHOOK_SECRET;
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ eventId: 7, objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.queued, true);
    assert.ok(Date.now() - started < 1000);
    release?.();
    await webhookProcessingSettled();
    const row = getSqlite().prepare(`SELECT status, attempts FROM webhook_events WHERE event_id = 'hs:7'`).get() as {
      status: string;
      attempts: number;
    };
    assert.equal(row.attempts >= 1, true);
    assert.equal(row.status === "pending" || row.status === "failed", true);
  } finally {
    release?.();
    server.close();
    mock.close();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("NODE_ENV", previous.node);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    restore("HUBSPOT_WEBHOOK_SECRET", previous.secret);
    db.restore();
  }
});

test("a 429 keeps the local value and retries after Retry-After", async () => {
  const db = useTempDb();
  const previous = {
    node: process.env.NODE_ENV,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
  };
  let patches = 0;
  const mock = http.createServer((req, res) => {
    if (req.method === "PATCH") {
      patches += 1;
      if (patches === 1) {
        res.statusCode = 429;
        res.setHeader("retry-after", "30");
        res.end(JSON.stringify({ message: "slow down" }));
        return;
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "55", properties: {} }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.address() as { port: number }).port;
  process.env.NODE_ENV = "test";
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  try {
    const first = await submitHubspotWrite("55", { print_ship_by: "2026-10-02" });
    assert.equal(first.wrote, false);
    assert.equal(first.pending, true);
    const shown = overlayPendingHubspotWrites([{ id: "55", properties: { print_ship_by: "" } }]);
    assert.equal(shown[0]?.properties.print_ship_by, "2026-10-02");
    const tooSoon = await import("../server/lib/hubspot-writes").then((mod) => mod.processPendingHubspotWrites(new Date()));
    assert.equal(tooSoon.wrote, 0);
    const later = await import("../server/lib/hubspot-writes").then((mod) =>
      mod.processPendingHubspotWrites(new Date(Date.now() + 31_000)),
    );
    assert.equal(later.wrote, 1);
    assert.equal(patches, 2);
    assert.ok(lastHubspotWriteSuccessAt());
    const gone = getSqlite().prepare(`SELECT deal_id FROM pending_hubspot_writes WHERE deal_id = '55'`).get();
    assert.equal(gone, undefined);
  } finally {
    mock.close();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("NODE_ENV", previous.node);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    db.restore();
  }
});

test("postage of $0 is not written to HubSpot", async () => {
  const previous = {
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const result = await updateDealCosts("77", {
      material: "",
      labor: "",
      packaging: "",
      shipping: "0",
      liveWrite: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /real label/);
  } finally {
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
  }
});

test("deal creation is stored and busts the cache without a profit recalc", async () => {
  const db = useTempDb();
  const previousNode = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const accepted = acceptWebhookBatch(
      [{ eventId: 9, objectId: 12, subscriptionType: "deal.creation" }],
      false,
    );
    assert.equal(accepted.cacheBust, true);
    assert.equal(accepted.deals, 0);
    const outcome = await processWebhookInbox();
    assert.equal(outcome.processed, 1);
    const row = getSqlite().prepare(`SELECT status FROM webhook_events WHERE event_id = 'hs:9'`).get() as { status: string };
    assert.equal(row.status, "done");
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
    db.restore();
  }
});
