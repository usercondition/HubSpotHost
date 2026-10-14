import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ProductionQueueItem, ProductionQueueResponse } from "../shared/schema";
import {
  buildOrdersSummary,
  registerOpsSummaryRoutes,
} from "../server/lib/ops-summary-routes";

const TOKEN = "nerve-read-token-for-tests-32chars";

function queueItem(
  over: Partial<ProductionQueueItem> & Pick<ProductionQueueItem, "bucket" | "shipBy" | "stage">,
): ProductionQueueItem {
  return {
    dealId: over.dealId ?? "9999",
    dealName: over.dealName ?? "Secret buyer bust — Jane Doe",
    stageId: over.stageId ?? "s1",
    stage: over.stage,
    amount: over.amount ?? 199.99,
    shipBy: over.shipBy,
    shipBySource: over.shipBySource ?? "derived",
    tentative: over.tentative ?? false,
    shipByReason: over.shipByReason ?? "plan",
    addressStatus: over.addressStatus ?? "ready",
    addressSummary: over.addressSummary ?? "San Diego, CA",
    chaseDraft: over.chaseDraft ?? "Hi Jane, need your address",
    shippingRequired: over.shippingRequired ?? true,
    closeDate: over.closeDate ?? null,
    contactName: over.contactName ?? "Jane Doe",
    hasPlates: over.hasPlates ?? true,
    requiresPlates: over.requiresPlates ?? true,
    plateCount: over.plateCount ?? 1,
    totalPrintTimeSeconds: over.totalPrintTimeSeconds ?? 3600,
    assignedPrinterIds: over.assignedPrinterIds ?? [1],
    assignedPrinterNames: over.assignedPrinterNames ?? ["Mighty"],
    unassignedPlateCount: over.unassignedPlateCount ?? 0,
    kitNeeded: over.kitNeeded ?? 0,
    kitReprint: over.kitReprint ?? 0,
    costsIncomplete: over.costsIncomplete ?? false,
    isStale: over.isStale ?? false,
    needsReply: over.needsReply ?? false,
    readyToPack: over.readyToPack ?? false,
    fulfillment: over.fulfillment ?? {
      dealId: over.dealId ?? "9999",
      addressVerified: true,
      costsEntered: true,
      labelBought: false,
      trackingPasted: false,
      packingDone: false,
      trackingNumber: "",
      notes: "",
      completedCount: 2,
      totalCount: 5,
      readyPercent: 40,
      shipReady: false,
      updatedAt: null,
    },
    bucket: over.bucket,
    priorityScore: over.priorityScore ?? 1,
  };
}

function sampleQueue(): ProductionQueueResponse {
  return {
    generatedAt: "2026-10-14T20:00:00.000Z",
    hubspotPortalId: "12345678",
    stages: [{ id: "s1", label: "In Production", closed: false }],
    printers: [{ id: 1, name: "Mighty", status: "online" }],
    nextPrint: [
      queueItem({
        dealId: "1001",
        dealName: "Dragon — Ada Lovelace ada@example.com",
        stage: "Deposit Received",
        bucket: "next_print",
        shipBy: "2026-10-16",
        contactName: "Ada Lovelace",
        amount: 120,
      }),
    ],
    inProduction: [
      queueItem({
        dealId: "1002",
        dealName: "Kit — Beau",
        stage: "In Production",
        bucket: "in_production",
        shipBy: "2026-10-13",
        contactName: "Beau",
        amount: 220,
      }),
    ],
    shipReady: [
      queueItem({
        dealId: "1003",
        dealName: "Bust — Cam",
        stage: "Ready to Ship",
        bucket: "ship_ready",
        shipBy: "2026-10-14",
        contactName: "Cam",
        amount: 80,
      }),
    ],
    blocked: [
      queueItem({
        dealId: "1004",
        dealName: "Plate hold — Dee",
        stage: "Queued",
        bucket: "blocked",
        shipBy: "2026-10-20",
        contactName: "Dee",
        amount: 40,
      }),
    ],
    needsReply: [],
    readyToPack: [],
    recentFailures: [],
    summary: {
      nextPrint: 1,
      inProduction: 1,
      shipReady: 1,
      blocked: 1,
      needsReply: 0,
      readyToPack: 0,
      needsAddress: 0,
      openOrders: 4,
    },
  };
}

function assertNoPii(value: unknown) {
  const raw = JSON.stringify(value);
  const leaks = [
    "Ada",
    "Lovelace",
    "Beau",
    "Cam",
    "Dee",
    "Jane",
    "Doe",
    "example.com",
    "San Diego",
    "1001",
    "1002",
    "1003",
    "1004",
    "9999",
    "12345678",
    "199.99",
    "ada@",
  ];
  for (const leak of leaks) {
    assert.equal(raw.includes(leak), false, `summary leaked ${leak}`);
  }
}

test("buildOrdersSummary counts Pacific overdue/due-today and strips PII", () => {
  // 2026-10-15 06:00 UTC is still 2026-10-14 in America/Los_Angeles.
  const lateUtc = new Date("2026-10-15T06:00:00.000Z");
  const summary = buildOrdersSummary(sampleQueue(), lateUtc);
  assert.equal(summary.ok, true);
  assert.equal(summary.today, "2026-10-14");
  assert.equal(summary.openOrders, 4);
  assert.equal(summary.overdue, 1);
  assert.equal(summary.dueToday, 1);
  assert.deepEqual(summary.shipBy, [
    { date: "2026-10-13", stage: "In Production", status: "in_production" },
    { date: "2026-10-14", stage: "Ready to Ship", status: "ship_ready" },
    { date: "2026-10-16", stage: "Deposit Received", status: "next_print" },
    { date: "2026-10-20", stage: "Queued", status: "blocked" },
  ]);
  assertNoPii(summary);
});

async function withServer(
  options: Parameters<typeof registerOpsSummaryRoutes>[1],
  run: (base: string) => Promise<void>,
) {
  const app = express();
  registerOpsSummaryRoutes(app, options);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("orders-summary is disabled without NERVE_READ_TOKEN", async () => {
  let loaded = 0;
  await withServer(
    {
      env: {},
      loadQueue: async () => {
        loaded += 1;
        return sampleQueue();
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/ops/orders-summary`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: "NERVE_READ_TOKEN not configured" });
      assert.equal(loaded, 0);
    },
  );
});

test("orders-summary rejects missing and wrong bearer tokens", async () => {
  const env = { NERVE_READ_TOKEN: TOKEN };
  let loaded = 0;
  await withServer(
    {
      env,
      loadQueue: async () => {
        loaded += 1;
        return sampleQueue();
      },
    },
    async (base) => {
      assert.equal((await fetch(`${base}/api/ops/orders-summary`)).status, 401);
      assert.equal(
        (await fetch(`${base}/api/ops/orders-summary`, { headers: { Authorization: "Bearer wrong-token-same-ish-len!!" } }))
          .status,
        401,
      );
      assert.equal(
        (await fetch(`${base}/api/ops/orders-summary`, { headers: { Authorization: "Basic not-bearer" } })).status,
        401,
      );
      assert.equal(loaded, 0);
    },
  );
});

test("orders-summary returns aggregates only and does not enrich or refresh", async () => {
  const calls: unknown[] = [];
  await withServer(
    {
      env: { NERVE_READ_TOKEN: TOKEN },
      now: () => new Date("2026-10-15T06:00:00.000Z"),
      loadQueue: async (options) => {
        calls.push(options);
        return sampleQueue();
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/ops/orders-summary`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.today, "2026-10-14");
      assert.equal(body.openOrders, 4);
      assert.equal(body.overdue, 1);
      assert.equal(body.dueToday, 1);
      assert.equal(body.shipBy.length, 4);
      for (const row of body.shipBy) {
        assert.deepEqual(Object.keys(row).sort(), ["date", "stage", "status"]);
      }
      assertNoPii(body);
      assert.deepEqual(calls, [{ enrichAddresses: false, refreshStages: false }]);
    },
  );
});

test("orders-summary returns 502 when the queue cannot be built", async () => {
  await withServer(
    {
      env: { NERVE_READ_TOKEN: TOKEN },
      loadQueue: async () => {
        throw new Error("hubspot down — Ada Lovelace 1001");
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/ops/orders-summary`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.deepEqual(body, { ok: false, error: "could not build summary" });
      assertNoPii(body);
    },
  );
});
