/**
 * A missing HubSpot deal is final. Every other failure still retries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropNotFoundSampleAudit, listAttempts, recordAttempt, resetAudit } from "../server/lib/audit";
import { getSqlite, resetOrderLinkStore } from "../server/lib/order-links";
import { appendDurableFailures, compareSyncHealth, type SyncCompareInput, type SyncHubspotDeal } from "../server/lib/sync-health";
import {
  acceptWebhookBatch,
  dropNotFoundWebhookEvents,
  failedWebhookCount,
  processWebhookInbox,
  reopenFailedWebhookEvents,
} from "../server/lib/webhook-inbox";

function useTempDb(): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sync-404-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const previousAudit = process.env.AUDIT_LOG_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.AUDIT_LOG_FILE = join(dir, "audit.json");
  resetOrderLinkStore();
  resetAudit();
  return {
    restore: () => {
      resetAudit();
      resetOrderLinkStore();
      if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
      else process.env.ORDER_LINKS_DB_FILE = previousDb;
      if (previousAudit === undefined) delete process.env.AUDIT_LOG_FILE;
      else process.env.AUDIT_LOG_FILE = previousAudit;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function remote(dealId: string): SyncHubspotDeal {
  return {
    dealId,
    found: true,
    stage: "Printing",
    closed: false,
    closedWon: false,
    amount: "40",
    tracking: "",
    shipNotes: "",
    shipBy: "",
    material: "",
    labor: "",
    packaging: "",
    shipping: "",
  };
}

function compareInput(partial: Partial<SyncCompareInput> = {}): SyncCompareInput {
  return {
    openDealIds: [],
    hubspotById: { "81": remote("81") },
    localDeals: [],
    audit: [],
    webhookConfigured: true,
    webhook: null,
    tokenError: null,
    lastSuccessfulReadAt: null,
    lastSuccessfulWriteAt: null,
    ...partial,
  };
}

function amountEvent(eventId: number, objectId: number) {
  return {
    eventId,
    objectId,
    objectTypeId: "0-3",
    subscriptionType: "deal.propertyChange",
    propertyName: "amount",
    propertyValue: "40",
  };
}

test("deal 123 audit noise is removed and a real deal error is kept", () => {
  const db = useTempDb();
  try {
    recordAttempt({ dealId: "123", origin: "webhook", status: "error", dryRun: true, gate: "dry-run", error: "HubSpot API 404" });
    recordAttempt({ dealId: "123", origin: "manual", status: "written", dryRun: false, gate: "live write permitted" });
    recordAttempt({ dealId: "555001", origin: "webhook", status: "error", dryRun: true, gate: "dry-run", error: "HubSpot API 500" });
    assert.equal(dropNotFoundSampleAudit(), 1);
    const kept = listAttempts().map((entry) => `${entry.dealId}:${entry.status}`);
    assert.deepEqual(kept.sort(), ["123:written", "555001:error"]);
    assert.equal(dropNotFoundSampleAudit(), 0);
  } finally {
    db.restore();
  }
});

test("404 webhook deliveries are dropped and a 500 keeps retrying", async () => {
  const db = useTempDb();
  const previous = {
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
  };
  let status = 404;
  let hits = 0;
  const mock = http.createServer((_req, res) => {
    hits += 1;
    res.statusCode = status;
    res.end(JSON.stringify({ message: status === 404 ? "resource not found" : "unavailable" }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.address() as { port: number }).port;
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  try {
    acceptWebhookBatch([amountEvent(12301, 123)], false);
    await processWebhookInbox();
    const dropped = getSqlite().prepare(`SELECT status, last_error FROM webhook_events WHERE event_id = 'hs:12301'`).get() as {
      status: string;
      last_error: string;
    };
    assert.equal(dropped.status, "dropped");
    assert.match(dropped.last_error, /404/);
    const hitsAfterDrop = hits;
    reopenFailedWebhookEvents();
    await processWebhookInbox();
    const still = getSqlite().prepare(`SELECT status FROM webhook_events WHERE event_id = 'hs:12301'`).get() as { status: string };
    assert.equal(still.status, "dropped");
    assert.equal(hits, hitsAfterDrop);
    assert.equal(failedWebhookCount(), 0);

    status = 500;
    acceptWebhookBatch([amountEvent(50001, 555001)], false);
    await processWebhookInbox();
    const retrying = getSqlite().prepare(`SELECT status, attempts, last_error FROM webhook_events WHERE event_id = 'hs:50001'`).get() as {
      status: string;
      attempts: number;
      last_error: string;
    };
    assert.equal(retrying.status, "pending");
    assert.equal(retrying.attempts, 1);
    assert.match(retrying.last_error, /500/);
    assert.notEqual(retrying.status, "dropped");
    getSqlite().prepare(`UPDATE webhook_events SET not_before = NULL WHERE event_id = 'hs:50001'`).run();
    await processWebhookInbox();
    const again = getSqlite().prepare(`SELECT status, attempts FROM webhook_events WHERE event_id = 'hs:50001'`).get() as {
      status: string;
      attempts: number;
    };
    assert.equal(again.attempts, 2);
    assert.equal(again.status, "pending");

    getSqlite()
      .prepare(
        `INSERT INTO webhook_events (event_id, payload, status, attempts, live_write, last_error, received_at)
         VALUES ('hs:old404', '{}', 'failed', 2, 0, 'HubSpot API 404', ?),
                ('hs:old500', '{}', 'failed', 2, 0, 'HubSpot API 500', ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    assert.equal(dropNotFoundWebhookEvents(), 1);
    reopenFailedWebhookEvents();
    const old404 = getSqlite().prepare(`SELECT status FROM webhook_events WHERE event_id = 'hs:old404'`).get() as { status: string };
    const old500 = getSqlite().prepare(`SELECT status FROM webhook_events WHERE event_id = 'hs:old500'`).get() as { status: string };
    assert.equal(old404.status, "dropped");
    assert.equal(old500.status, "pending");
  } finally {
    mock.close();
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    db.restore();
  }
});

test("sync counters match the durable queue and ignore a 404 recalculation", () => {
  const db = useTempDb();
  try {
    getSqlite()
      .prepare(
        `INSERT INTO webhook_events (event_id, payload, status, attempts, live_write, last_error, received_at)
         VALUES ('hs:durable500', '{}', 'failed', 3, 0, 'HubSpot API 500', ?)`,
      )
      .run(new Date().toISOString());
    const report = compareSyncHealth(compareInput({
      audit: [
        {
          id: 1,
          timestamp: "2026-09-25T12:00:00.000Z",
          dealId: "81",
          origin: "webhook",
          status: "error",
          dryRun: true,
          gate: "dry-run",
          inputs: null,
          outputs: null,
          error: "HubSpot API 500",
        },
        {
          id: 2,
          timestamp: "2026-09-25T12:05:00.000Z",
          dealId: "123",
          origin: "webhook",
          status: "error",
          dryRun: true,
          gate: "dry-run",
          inputs: null,
          outputs: null,
          error: "HubSpot API 404",
        },
      ],
    }));
    appendDurableFailures(report);
    assert.equal(report.summary.counts.failedRecalcs, 1);
    assert.equal(report.summary.counts.failedWrites, 1);
    assert.equal(report.summary.writes.failed, 1);
    assert.equal(report.summary.writes.pending, 0);
    assert.equal(report.summary.counts.failedWrites, report.summary.writes.failed);
    assert.equal(report.items.some((item) => item.dealId === "123"), false);

    getSqlite().prepare(`DELETE FROM webhook_events`).run();
    const clean = compareSyncHealth(compareInput({
      audit: [
        {
          id: 3,
          timestamp: "2026-09-25T12:05:00.000Z",
          dealId: "123",
          origin: "webhook",
          status: "error",
          dryRun: true,
          gate: "dry-run",
          inputs: null,
          outputs: null,
          error: "HubSpot API 404",
        },
      ],
    }));
    appendDurableFailures(clean);
    assert.equal(clean.summary.issueCount, 0);
    assert.equal(clean.summary.counts.failedWrites, 0);
    assert.equal(clean.summary.counts.failedRecalcs, 0);
    assert.deepEqual(clean.summary.writes, { pending: 0, failed: 0 });
    assert.equal(clean.summary.status, "ok");
  } finally {
    db.restore();
  }
});
