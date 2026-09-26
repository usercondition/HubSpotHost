import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AuditEntry } from "../server/lib/audit";
import { getDb, resetOrderLinkStore } from "../server/lib/order-links";
import { registerRoutes } from "../server/routes";
import { fulfillmentChecklists } from "../shared/schema";
import { registerSyncHealthJobScheduler } from "../server/lib/print-ops-jobs";
import {
  applySyncRepairs,
  clearCachedSyncHealthForTest,
  compareSyncHealth,
  placeholderSyncSummary,
  presentSyncSummary,
  resetSyncHealthScheduleForTest,
  setCachedSyncHealth,
  setSyncHealthKickForTest,
  startSyncHealthSchedule,
  SYNC_HEALTH_INTERVAL_MS,
  type SyncCompareInput,
  type SyncHealthReport,
  type SyncHubspotDeal,
  type SyncLocalDeal,
} from "../server/lib/sync-health";

const NOW = new Date("2026-09-25T18:00:00.000Z");

function remote(partial: Partial<SyncHubspotDeal> & Pick<SyncHubspotDeal, "dealId">): SyncHubspotDeal {
  return {
    found: true,
    stage: "Printing",
    closed: false,
    closedWon: false,
    amount: "40.00",
    tracking: "",
    shipNotes: "",
    shipBy: "",
    material: "",
    labor: "",
    packaging: "",
    shipping: "",
    ...partial,
  };
}

function local(partial: Partial<SyncLocalDeal> & Pick<SyncLocalDeal, "dealId">): SyncLocalDeal {
  return {
    inQueue: true,
    inStack: true,
    bundleMember: false,
    amount: "40.00",
    tracking: "",
    shipNotes: "",
    shipBy: null,
    shipBySource: "derived",
    material: null,
    labor: null,
    packaging: null,
    shipping: null,
    doneAt: null,
    ...partial,
  };
}

function audit(partial: Partial<AuditEntry> & Pick<AuditEntry, "dealId" | "status">): AuditEntry {
  return {
    id: 1,
    timestamp: "2026-09-25T12:00:00.000Z",
    origin: "manual",
    dryRun: false,
    gate: "live write permitted",
    inputs: { amount: 40, material: 4, labor: 6, packaging: 1, shipping: 8, costTotal: 19 },
    outputs: null,
    ...partial,
  };
}

function input(partial: Partial<SyncCompareInput> = {}): SyncCompareInput {
  return {
    openDealIds: [],
    hubspotById: {},
    localDeals: [],
    audit: [],
    webhookConfigured: false,
    webhook: null,
    tokenError: null,
    lastSuccessfulReadAt: NOW.toISOString(),
    lastSuccessfulWriteAt: null,
    now: NOW,
    ...partial,
  };
}

function kinds(report: SyncHealthReport): string[] {
  return report.items.map((item) => item.kind);
}

test("missing open HubSpot deals are not on the Queue or Stack", () => {
  const report = compareSyncHealth(input({
    openDealIds: ["11", "12"],
    hubspotById: {
      "11": remote({ dealId: "11" }),
      "12": remote({ dealId: "12" }),
    },
    localDeals: [local({ dealId: "12" })],
  }));
  assert.deepEqual(kinds(report), ["missingInOps"]);
  assert.equal(report.items[0].dealId, "11");
  assert.equal(report.repairs.length, 0);
  assert.equal(report.summary.counts.missingInOps, 1);
  assert.equal(report.summary.status, "warn");
});

test("orphans are closed, deleted, or missing HubSpot deals, and off-book rows are ignored", () => {
  const report = compareSyncHealth(input({
    hubspotById: {
      "21": remote({ dealId: "21", closed: true, closedWon: false, stage: "Closed Lost" }),
    },
    localDeals: [
      local({ dealId: "21" }),
      local({ dealId: "22", inQueue: true, inStack: false }),
      local({ dealId: "23", inQueue: false, inStack: false }),
    ],
  }));
  assert.deepEqual(kinds(report), ["orphans", "orphans"]);
  assert.equal(report.items[0].hubspot, "Closed Lost");
  assert.equal(report.items[1].hubspot, "not found");
  assert.equal(report.items.some((item) => item.dealId === "23"), false);
});

test("tracking, ship notes, and ship-by push only when HubSpot is blank", () => {
  const blankHubspot = compareSyncHealth(input({
    hubspotById: {
      "31": remote({ dealId: "31" }),
    },
    localDeals: [local({
      dealId: "31",
      tracking: "1ZLOCAL",
      shipNotes: "leave at side door",
      shipBy: "2026-09-27",
      shipBySource: "override",
      bundleMember: true,
    })],
  }));
  assert.deepEqual(blankHubspot.repairs.map((repair) => repair.field), ["tracking", "notes", "ship_by"]);
  assert.equal(blankHubspot.items.find((item) => item.kind === "shipBy")?.suggestedFix.includes("Bundle member"), true);

  const conflict = compareSyncHealth(input({
    hubspotById: {
      "31": remote({
        dealId: "31",
        tracking: "1ZHUB",
        shipNotes: "hubspot note",
        shipBy: "2026-09-28",
      }),
    },
    localDeals: [local({
      dealId: "31",
      tracking: "1ZLOCAL",
      shipNotes: "leave at side door",
      shipBy: "2026-09-27",
      shipBySource: "override",
    })],
  }));
  assert.deepEqual(kinds(conflict), ["tracking", "shipNotes", "shipBy"]);
  assert.deepEqual(conflict.repairs, []);
  assert.equal(conflict.items.every((item) => item.repairable === false), true);
});

test("cost and amount mismatches are reported and never repaired", () => {
  const report = compareSyncHealth(input({
    hubspotById: {
      "41": remote({ dealId: "41", amount: "55.00", shipping: "", material: "9.00" }),
    },
    localDeals: [local({
      dealId: "41",
      amount: "40.00",
      material: "4",
      labor: null,
      packaging: null,
      shipping: "8.50",
    })],
  }));
  assert.deepEqual(kinds(report), ["costs", "costs", "amount"]);
  assert.deepEqual(report.repairs, []);
  assert.equal(report.items.every((item) => item.repairable === false), true);
});

test("a blank checklist note against HubSpot ship notes is not drift and is not copied", () => {
  const copied = compareSyncHealth(input({
    hubspotById: { "91": remote({ dealId: "91", shipNotes: "pickup after 5" }) },
    localDeals: [local({ dealId: "91", shipNotes: "  " })],
  }));
  assert.deepEqual(kinds(copied), []);
  assert.equal(copied.summary.counts.shipNotes, 0);
  assert.deepEqual(copied.repairs, []);

  const kept = compareSyncHealth(input({
    hubspotById: { "91": remote({ dealId: "91", shipNotes: "hubspot note" }) },
    localDeals: [local({ dealId: "91", shipNotes: "leave at side door" })],
  }));
  assert.deepEqual(kinds(kept), ["shipNotes"]);
  assert.equal(kept.repairs.some((repair) => repair.field === "local_notes"), false);
});

test("$0 actual shipping against a blank HubSpot cost is not drift", () => {
  const quiet = compareSyncHealth(input({
    hubspotById: { "92": remote({ dealId: "92", shipping: "" }) },
    localDeals: [local({ dealId: "92", shipping: "0.00" })],
  }));
  assert.deepEqual(kinds(quiet), []);
  assert.equal(quiet.summary.counts.costs, 0);
  assert.deepEqual(quiet.repairs, []);

  const auditedBlank = compareSyncHealth(input({
    hubspotById: { "94": remote({ dealId: "94", material: "", labor: "", packaging: "" }) },
    localDeals: [local({ dealId: "94", material: "0", labor: "0.00", packaging: "0" })],
  }));
  assert.deepEqual(kinds(auditedBlank), []);

  const postage = compareSyncHealth(input({
    hubspotById: { "93": remote({ dealId: "93", shipping: "" }) },
    localDeals: [local({ dealId: "93", shipping: "8.50" })],
  }));
  assert.deepEqual(kinds(postage), ["costs"]);
  assert.equal(postage.items[0]?.field, "print_actual_shipping_cost");
  assert.deepEqual(postage.repairs, []);
});

test("Stack done still open in HubSpot, and Closed Won not done this week", () => {
  const report = compareSyncHealth(input({
    hubspotById: {
      "51": remote({ dealId: "51", stage: "Ready to Ship" }),
      "52": remote({ dealId: "52", stage: "Completed", closed: true, closedWon: true }),
    },
    localDeals: [
      local({ dealId: "51", doneAt: "2026-09-25T16:00:00.000Z" }),
      local({ dealId: "52", doneAt: "2026-08-01T16:00:00.000Z" }),
    ],
  }));
  assert.deepEqual(kinds(report), ["doneStillOpen", "closedNotDone"]);
  assert.deepEqual(report.repairs, []);
});

test("failed writes are the latest audit error, and a later success clears them", () => {
  const failed = compareSyncHealth(input({
    audit: [
      audit({ id: 1, dealId: "61", status: "written", timestamp: "2026-09-24T12:00:00.000Z" }),
      audit({ id: 2, dealId: "61", status: "error", timestamp: "2026-09-25T12:00:00.000Z", error: "HubSpot API 500" }),
      audit({ id: 3, dealId: "62", status: "dry-run", timestamp: "2026-09-25T12:00:00.000Z" }),
    ],
  }));
  assert.deepEqual(kinds(failed), ["failedRecalcs"]);
  assert.equal(failed.summary.counts.failedRecalcs, 1);
  assert.equal(failed.summary.counts.failedWrites, 0);
  assert.deepEqual(failed.repairs, [{ dealId: "61", field: "retry", value: "" }]);

  const recovered = compareSyncHealth(input({
    audit: [
      audit({ id: 1, dealId: "61", status: "error", timestamp: "2026-09-24T12:00:00.000Z", error: "old" }),
      audit({ id: 2, dealId: "61", status: "written", timestamp: "2026-09-25T12:00:00.000Z" }),
    ],
  }));
  assert.deepEqual(kinds(recovered), []);
  assert.equal(recovered.summary.lastSuccessfulWriteAt, null);
});

test("a HubSpot 404 is not a failed write and a missing deal is not retried", () => {
  const missing = compareSyncHealth(input({
    hubspotById: { "81": remote({ dealId: "81" }) },
    audit: [
      audit({ id: 1, dealId: "123", status: "error", error: "HubSpot API 404" }),
      audit({ id: 2, dealId: "4041", status: "error", error: "HubSpot API 500", timestamp: "2026-09-25T12:00:00.000Z" }),
    ],
  }));
  assert.deepEqual(kinds(missing), []);
  assert.deepEqual(missing.repairs, []);
  assert.equal(missing.summary.counts.failedWrites, 0);
  assert.equal(missing.summary.counts.failedRecalcs, 0);
  assert.equal(missing.summary.issueCount, 0);

  const present = compareSyncHealth(input({
    hubspotById: { "81": remote({ dealId: "81" }) },
    audit: [audit({ id: 3, dealId: "81", status: "error", error: "HubSpot API 500" })],
  }));
  assert.deepEqual(kinds(present), ["failedRecalcs"]);
  assert.deepEqual(present.repairs, [{ dealId: "81", field: "retry", value: "" }]);

  const duringOutage = compareSyncHealth(input({
    tokenError: "HubSpot API 401",
    audit: [audit({ id: 4, dealId: "81", status: "error", error: "HubSpot API 500" })],
  }));
  assert.equal(duringOutage.summary.status, "error");
  assert.deepEqual(kinds(duringOutage), ["failedRecalcs", "token"]);
});

test("webhook silence stays a note and is not an issue, and token errors fail the check", () => {
  const unconfigured = compareSyncHealth(input({ webhookConfigured: false, webhook: null }));
  assert.deepEqual(kinds(unconfigured), []);
  assert.equal(unconfigured.summary.status, "ok");
  assert.equal(unconfigured.summary.counts.webhook, 0);
  assert.match(unconfigured.summary.webhook.note, /not configured/);

  const silent = compareSyncHealth(input({ webhookConfigured: true, webhook: null }));
  assert.deepEqual(kinds(silent), []);
  assert.equal(silent.summary.counts.webhook, 0);
  assert.equal(silent.summary.issueCount, 0);
  assert.equal(silent.summary.status, "ok");
  assert.equal(silent.summary.webhook.arriving, false);
  assert.match(silent.summary.webhook.note, /No HubSpot delivery has been recorded/);

  const fresh = compareSyncHealth(input({
    webhookConfigured: true,
    webhook: { receivedAt: NOW.toISOString(), result: "accepted", version: "v3", reason: "ok", eventCount: 1 },
  }));
  assert.deepEqual(kinds(fresh), []);
  assert.equal(fresh.summary.webhook.arriving, true);
  assert.equal(fresh.summary.webhook.lastDeliveryAt, NOW.toISOString());
  assert.match(fresh.summary.webhook.note, /Last HubSpot delivery: 2026-09-25T18:00:00.000Z/);

  const token = compareSyncHealth(input({ tokenError: "HubSpot API 401" }));
  assert.equal(token.summary.status, "error");
  assert.equal(token.summary.counts.token, 1);
  assert.equal(JSON.stringify(token.summary).includes("Customer"), false);
});

test("ship-note drift does not copy HubSpot text into the checklist notes field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-notes-"));
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
    res.end("{}");
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "notes.db");
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  resetOrderLinkStore();
  try {
    const report = compareSyncHealth(input({
      hubspotById: { "91001": remote({ dealId: "91001", shipNotes: "pickup after 5" }) },
      localDeals: [local({ dealId: "91001", shipNotes: "" })],
    }));
    assert.deepEqual(report.repairs, []);
    await applySyncRepairs(report.repairs);
    const stored = getDb().select().from(fulfillmentChecklists).where(eq(fulfillmentChecklists.hubspotDealId, "91001")).get();
    assert.equal(stored, undefined);
    assert.equal(calls.length, 0);
  } finally {
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    resetOrderLinkStore();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-repair never overwrites a non-blank HubSpot value and stays quiet in dry run", async () => {
  const previous = {
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
  };
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const properties: Record<string, string> = {
    print_tracking_number: "1ZHUB",
    print_ship_notes: "already noted",
    print_ship_by: "2026-09-28",
  };
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method || "", url: req.url || "", body });
      res.setHeader("content-type", "application/json");
      if ((req.url || "").includes("/crm/v3/properties/deals") && req.method === "GET") {
        res.end(JSON.stringify({ results: Object.keys(properties).map((name) => ({ name, type: "string" })) }));
        return;
      }
      const match = (req.url || "").match(/properties=([^&]+)/);
      const property = match ? decodeURIComponent(match[1]) : "";
      if (req.method === "GET") {
        res.end(JSON.stringify({ properties: { [property]: properties[property] ?? "" } }));
        return;
      }
      if (req.method === "PATCH" && (req.url || "").includes("/objects/deals/")) {
        const parsed = JSON.parse(body) as { properties?: Record<string, string> };
        Object.assign(properties, parsed.properties ?? {});
      }
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const port = (mock.address() as { port: number }).port;
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${port}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  try {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
    const dry = await applySyncRepairs([
      { dealId: "71", field: "tracking", value: "1ZLOCAL" },
      { dealId: "71", field: "notes", value: "local note" },
      { dealId: "71", field: "ship_by", value: "2026-09-27" },
    ]);
    assert.equal(dry.every((row) => row.wrote === false && row.dryRun === true), true);
    assert.equal(calls.length, 0);

    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const kept = await applySyncRepairs([
      { dealId: "71", field: "tracking", value: "1ZLOCAL" },
      { dealId: "71", field: "notes", value: "local note" },
      { dealId: "71", field: "ship_by", value: "2026-09-27" },
    ]);
    assert.equal(kept.every((row) => row.wrote === false && row.skipped === "hubspot-not-blank"), true);
    assert.equal(calls.some((call) => call.method === "PATCH"), false);
    assert.equal(properties.print_tracking_number, "1ZHUB");

    properties.print_tracking_number = "";
    properties.print_ship_notes = "";
    properties.print_ship_by = "";
    calls.length = 0;
    const filled = await applySyncRepairs([
      { dealId: "71", field: "tracking", value: "1ZLOCAL" },
      { dealId: "71", field: "notes", value: "local note" },
      { dealId: "71", field: "ship_by", value: "2026-09-27" },
    ]);
    assert.deepEqual(filled.map((row) => row.wrote), [true, true, true]);
    const dealPatches = calls.filter((call) => call.method === "PATCH" && call.url.includes("/objects/deals/"));
    const patched = dealPatches.map((call) => JSON.parse(call.body).properties);
    assert.equal(patched.some((row) => row.print_tracking_number === "1ZLOCAL"), true);
    assert.equal(patched.some((row) => row.print_ship_notes === "local note"), true);
    assert.equal(patched.some((row) => row.print_ship_by === "2026-09-27"), true);
    assert.equal(patched.some((row) => row.print_tracking_number === "" || row.print_ship_notes === ""), false);
  } finally {
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});

test("public health summary has counts and timestamps and hides deal detail", async () => {
  clearCachedSyncHealthForTest();
  const previous = process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("sync-test", "utf8").digest("hex");
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const cold = await fetch(`${base}/api/health`);
    const coldBody = await cold.json();
    assert.equal(coldBody.hubspotSync.lastCheckedAt, null);
    assert.equal(coldBody.hubspotSync.issueCount, 0);
    assert.equal(typeof coldBody.hubspotSync.counts.missingInOps, "number");
    assert.equal(typeof coldBody.hubspotSync.webhook.note, "string");
    assert.match(coldBody.hubspotSync.webhook.note, /Sync check has not run yet/);

    const locked = await fetch(`${base}/api/sync-health`);
    assert.equal(locked.status, 401);

    const report = compareSyncHealth(input({
      openDealIds: ["81"],
      hubspotById: { "81": remote({ dealId: "81", amount: "59.99", tracking: "" }) },
      localDeals: [],
    }));
    report.items[0].suggestedFix = "Customer Alice paid 59.99";
    setCachedSyncHealth(report);

    const health = await fetch(`${base}/api/health`);
    const healthBody = await health.json();
    const serialized = JSON.stringify(healthBody.hubspotSync);
    assert.equal(healthBody.hubspotSync.status, "warn");
    assert.equal(healthBody.hubspotSync.issueCount, 1);
    assert.equal(healthBody.hubspotSync.counts.missingInOps, 1);
    assert.equal(healthBody.hubspotSync.lastCheckedAt, NOW.toISOString());
    assert.equal(serialized.includes("Alice"), false);
    assert.equal(serialized.includes("59.99"), false);
    assert.equal(serialized.includes("81"), false);
    assert.deepEqual(Object.keys(healthBody.hubspotSync).sort(), [
      "counts",
      "issueCount",
      "lastCheckedAt",
      "lastSuccessfulReadAt",
      "lastSuccessfulWriteAt",
      "status",
      "webhook",
      "writes",
    ]);

    const detail = await fetch(`${base}/api/sync-health`, { headers: { "x-paid-order-access-code": "sync-test" } });
    const detailBody = await detail.json();
    assert.equal(detail.status, 200);
    assert.equal(detailBody.items[0].dealId, "81");
    assert.match(detailBody.items[0].suggestedFix, /Alice/);
  } finally {
    clearCachedSyncHealthForTest();
    if (previous === undefined) delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
    else process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reconcile re-runs after its interval without Redis", () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  resetSyncHealthScheduleForTest();
  let runs = 0;
  setSyncHealthKickForTest(() => {
    runs += 1;
  });
  let captured: (() => void) | null = null;
  let delay = 0;
  const fakeSetInterval = ((fn: () => void, ms?: number) => {
    captured = fn;
    delay = ms ?? 0;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    startSyncHealthSchedule({ setInterval: fakeSetInterval });
    assert.equal(runs, 1);
    assert.equal(delay, SYNC_HEALTH_INTERVAL_MS);
    assert.equal(delay, 15 * 60 * 1000);
    assert.ok(captured);
    captured();
    captured();
    assert.equal(runs, 3);
    startSyncHealthSchedule({ setInterval: fakeSetInterval });
    assert.equal(runs, 3);
  } finally {
    resetSyncHealthScheduleForTest();
    setSyncHealthKickForTest(null);
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});

test("Redis reconcile is a BullMQ job scheduler, not a one-shot repeat add", async () => {
  const calls: unknown[][] = [];
  await registerSyncHealthJobScheduler({
    upsertJobScheduler: async (...args: unknown[]) => {
      calls.push(args);
    },
  }, SYNC_HEALTH_INTERVAL_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "sync-health");
  assert.deepEqual(calls[0][1], { every: 15 * 60 * 1000 });
  const template = calls[0][2] as { name?: string; data?: { kind?: string } };
  assert.equal(template.name, "sync-health");
  assert.equal(template.data?.kind, "sync-health");

  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:9";
  resetSyncHealthScheduleForTest();
  let runs = 0;
  let intervals = 0;
  setSyncHealthKickForTest(() => {
    runs += 1;
  });
  const fakeSetInterval = (() => {
    intervals += 1;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  try {
    let scheduled = 0;
    startSyncHealthSchedule({
      setInterval: fakeSetInterval,
      scheduleRedis: async () => {
        scheduled += 1;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 1);
    assert.equal(scheduled, 1);
    assert.equal(intervals, 0);

    resetSyncHealthScheduleForTest();
    runs = 0;
    let fallbackDelay = 0;
    const fallbackSetInterval = ((fn: () => void, ms?: number) => {
      intervals += 1;
      fallbackDelay = ms ?? 0;
      fn();
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    startSyncHealthSchedule({
      setInterval: fallbackSetInterval,
      scheduleRedis: async () => {
        throw new Error("scheduler rejected");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 2);
    assert.equal(intervals, 1);
    assert.equal(fallbackDelay, SYNC_HEALTH_INTERVAL_MS);
  } finally {
    resetSyncHealthScheduleForTest();
    setSyncHealthKickForTest(null);
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
});

test("health summary is stale when the last check is older than twice the interval", async () => {
  const fresh = compareSyncHealth(input()).summary;
  assert.equal(fresh.status, "ok");
  const within = presentSyncSummary(fresh, new Date(NOW.getTime() + 2 * SYNC_HEALTH_INTERVAL_MS));
  assert.equal(within.status, "ok");
  const stale = presentSyncSummary(fresh, new Date(NOW.getTime() + 2 * SYNC_HEALTH_INTERVAL_MS + 1));
  assert.equal(stale.status, "warn");
  assert.match(stale.webhook.note, /Sync check is stale/);
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.webhook.note.includes("Sync check is stale"), false);

  const cold = placeholderSyncSummary(NOW);
  assert.equal(cold.lastCheckedAt, null);
  assert.equal(presentSyncSummary(cold, new Date(NOW.getTime() + 3 * SYNC_HEALTH_INTERVAL_MS)).status, "ok");

  const warned = compareSyncHealth(input({
    openDealIds: ["81"],
    hubspotById: { "81": remote({ dealId: "81" }) },
    localDeals: [],
  })).summary;
  assert.equal(warned.status, "warn");
  assert.equal(presentSyncSummary(warned, new Date(NOW.getTime() + 3 * SYNC_HEALTH_INTERVAL_MS)).status, "warn");

  const errored = compareSyncHealth(input({ tokenError: "rejected" })).summary;
  assert.equal(errored.status, "error");
  assert.equal(presentSyncSummary(errored, new Date(NOW.getTime() + 3 * SYNC_HEALTH_INTERVAL_MS)).status, "error");

  clearCachedSyncHealthForTest();
  const previous = process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
  delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
  const aged = compareSyncHealth(input());
  aged.summary.lastCheckedAt = new Date(Date.now() - 2 * SYNC_HEALTH_INTERVAL_MS - 1_000).toISOString();
  setCachedSyncHealth(aged);
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await health.json();
    assert.equal(body.hubspotSync.status, "warn");
    assert.match(body.hubspotSync.webhook.note, /Sync check is stale/);
    assert.equal(aged.summary.status, "ok");
  } finally {
    clearCachedSyncHealthForTest();
    if (previous === undefined) delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
    else process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
