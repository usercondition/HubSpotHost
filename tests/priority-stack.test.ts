import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore } from "../server/lib/order-links";
import {
  buildPriorityStack,
  createBundle,
  createOffbook,
  deleteBundle,
  listStackState,
  markStackDone,
  resetStackOrder,
  setStackOrder,
  updateBundle,
  upsertDealStackEntry,
} from "../server/lib/priority-stack";
import { registerRoutes } from "../server/routes";
import {
  autoCompare,
  rankPriorityStack,
  shopWeekEnd,
  shopWeekStart,
  stackFloorLine,
  stackTier,
  suggestedBlocker,
} from "../shared/priority-stack";
import {
  createStackBundleSchema,
  offbookEntrySchema,
  stackDoneSchema,
  stackOrderSchema,
  updateStackEntrySchema,
  type FulfillmentChecklistView,
  type ProductionQueueItem,
  type ProductionQueueResponse,
} from "../shared/schema";

const NOW = new Date("2026-09-25T17:00:00.000Z");

function withTempDb(run: () => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "priority-stack-"));
  const previous = process.env.ORDER_LINKS_DB_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  resetOrderLinkStore();
  return Promise.resolve()
    .then(run)
    .finally(() => {
      resetOrderLinkStore();
      if (previous === undefined) delete process.env.ORDER_LINKS_DB_FILE;
      else process.env.ORDER_LINKS_DB_FILE = previous;
      rmSync(dir, { recursive: true, force: true });
    });
}

function fulfillment(partial: Partial<FulfillmentChecklistView> = {}): FulfillmentChecklistView {
  return {
    dealId: "1",
    addressVerified: false,
    costsEntered: false,
    labelBought: false,
    trackingPasted: false,
    packingDone: false,
    trackingNumber: "",
    notes: "",
    completedCount: 0,
    totalCount: 5,
    readyPercent: 0,
    shipReady: false,
    updatedAt: null,
    ...partial,
  };
}

function deal(partial: Partial<ProductionQueueItem> & Pick<ProductionQueueItem, "dealId" | "dealName" | "amount" | "shipBy" | "stage" | "bucket">): ProductionQueueItem {
  return {
    stageId: "stage",
    shipByOverride: null,
    shipPlanNote: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    shipBySource: "derived",
    shipByReason: "plan",
    addressStatus: "ready",
    addressSummary: null,
    chaseDraft: "",
    shippingRequired: true,
    closeDate: partial.shipBy,
    contactName: partial.dealName.split("·").pop()?.trim() ?? null,
    hasPlates: partial.bucket !== "next_print",
    requiresPlates: true,
    plateCount: partial.bucket === "next_print" ? 0 : 1,
    totalPrintTimeSeconds: 0,
    assignedPrinterIds: [],
    assignedPrinterNames: [],
    unassignedPlateCount: 0,
    kitNeeded: 0,
    kitReprint: 0,
    costsIncomplete: false,
    isStale: false,
    needsReply: false,
    readyToPack: partial.bucket === "ship_ready",
    fulfillment: fulfillment({ dealId: partial.dealId, shipReady: partial.bucket === "ship_ready" }),
    priorityScore: 1,
    ...partial,
  };
}

function queue(items: ProductionQueueItem[]): ProductionQueueResponse {
  const buckets = {
    nextPrint: items.filter((item) => item.bucket === "next_print"),
    inProduction: items.filter((item) => item.bucket === "in_production"),
    shipReady: items.filter((item) => item.bucket === "ship_ready"),
    blocked: items.filter((item) => item.bucket === "blocked"),
  };
  return {
    generatedAt: NOW.toISOString(),
    hubspotPortalId: "1",
    stages: [],
    printers: [],
    ...buckets,
    needsReply: [],
    readyToPack: items.filter((item) => item.readyToPack),
    recentFailures: [],
    summary: {
      nextPrint: buckets.nextPrint.length,
      inProduction: buckets.inProduction.length,
      shipReady: buckets.shipReady.length,
      blocked: buckets.blocked.length,
      needsReply: 0,
      readyToPack: 0,
      needsAddress: 0,
      openOrders: items.length,
    },
  };
}

function sampleDeals(overrides = false): ProductionQueueItem[] {
  return [
    deal({ dealId: "342134173423", dealName: "Armigers - Jose", amount: 59.99, shipBy: "2026-09-25", stage: "Ready to Ship", bucket: "ship_ready", contactName: "Jose", priorityScore: 3 }),
    deal({
      dealId: "346140673754",
      dealName: "Ikarus BA LR kit - Daniel",
      amount: 79.99,
      shipBy: overrides ? "2026-09-27" : "2026-09-26",
      shipBySource: overrides ? "override" : "derived",
      stage: "Post-Process / QC",
      bucket: "in_production",
      contactName: "Daniel",
      priorityScore: 10,
    }),
    deal({
      dealId: "348746780377",
      dealName: "Land Raider - Angel",
      amount: 74.99,
      shipBy: overrides ? "2026-10-02" : "2026-09-26",
      shipBySource: overrides ? "override" : "derived",
      stage: "Printing",
      bucket: "in_production",
      contactName: "Angel",
      priorityScore: 8,
    }),
    deal({
      dealId: "349919419125",
      dealName: "Castigator - Wayne",
      amount: 134.99,
      shipBy: overrides ? "2026-09-28" : "2026-09-27",
      shipBySource: overrides ? "override" : "derived",
      stage: "Printing",
      bucket: "in_production",
      contactName: "Wayne",
      priorityScore: 4,
    }),
    deal({
      dealId: "348773062379",
      dealName: "Repulsor Executioner - Simon",
      amount: 74.99,
      shipBy: "2026-09-27",
      stage: "Printing",
      bucket: "in_production",
      contactName: "Simon",
      shippingRequired: false,
      addressStatus: "pickup",
      priorityScore: 6,
    }),
    deal({
      dealId: "348731541190",
      dealName: "Sword Brethren - Simon",
      amount: 34.99,
      shipBy: overrides ? "2026-09-27" : "2026-09-25",
      shipBySource: overrides ? "override" : "derived",
      stage: overrides ? "Post-Process / QC" : "Ready to Ship",
      bucket: overrides ? "in_production" : "ship_ready",
      contactName: "Simon",
      shippingRequired: false,
      addressStatus: "pickup",
      priorityScore: 5,
    }),
    deal({
      dealId: "348796900087",
      dealName: "Lieutenant with Combi-Weapon - Simon",
      amount: 24.99,
      shipBy: overrides ? "2026-09-27" : "2026-09-26",
      shipBySource: overrides ? "override" : "derived",
      stage: "Printing",
      bucket: "in_production",
      contactName: "Simon",
      shippingRequired: false,
      addressStatus: "pickup",
      priorityScore: 2,
    }),
    deal({
      dealId: "349912151800",
      dealName: "Knight Castellan - Glenn",
      amount: 129.99,
      shipBy: "2026-10-05",
      stage: "Queued to Print",
      bucket: "next_print",
      contactName: "Glenn",
      hasPlates: false,
      plateCount: 0,
      priorityScore: 56.5,
    }),
  ];
}

const SIMON = ["348773062379", "348731541190", "348796900087"];

test("auto rank follows date, then readiness, then amount, with priorityScore last", () =>
  withTempDb(() => {
    createBundle({ label: "Simon pickup", mode: "pickup", dealIds: SIMON });
    const view = buildPriorityStack(queue(sampleDeals(false)), listStackState(), { now: NOW });
    assert.deepEqual(
      view.rows.map((row) => row.name),
      ["Armigers - Jose", "Ikarus BA LR kit - Daniel", "Land Raider - Angel", "Castigator - Wayne", "Simon pickup", "Knight Castellan - Glenn"],
    );
    const bundle = view.rows.find((row) => row.kind === "bundle");
    assert.equal(bundle?.amount, 134.97);
    assert.equal(bundle?.targetDate, "2026-09-27");
    assert.equal(bundle?.members.length, 3);
  }));

test("Miguel date overrides plus Darell match this week's cash and stretch", () =>
  withTempDb(() => {
    createBundle({ label: "Simon pickup", mode: "pickup", dealIds: SIMON });
    createOffbook({ title: "Friend order", contactName: "Darell", mode: "pickup", targetDate: "2026-09-27", amount: "" });
    upsertDealStackEntry("348746780377", { tentative: true });
    const view = buildPriorityStack(queue(sampleDeals(true)), listStackState(), { now: NOW });
    assert.deepEqual(
      view.rows.map((row) => row.name),
      [
        "Armigers - Jose",
        "Ikarus BA LR kit - Daniel",
        "Simon pickup",
        "Friend order",
        "Castigator - Wayne",
        "Land Raider - Angel",
        "Knight Castellan - Glenn",
      ],
    );
    assert.equal(view.totals.committed, 274.95);
    assert.equal(view.totals.stretch, 134.99);
    assert.equal(view.totals.offBookUnpriced, 1);
    assert.equal(view.weekEnd, "2026-09-27");
  }));

test("manual rank keeps order and a sooner unranked deal slots ahead of later dates", () =>
  withTempDb(() => {
    const items = sampleDeals(true).filter((item) => !SIMON.includes(item.dealId) && item.dealId !== "348746780377");
    setStackOrder(items.map((item) => `deal:${item.dealId}`));
    const urgent = deal({
      dealId: "999",
      dealName: "Rush order - New",
      amount: 10,
      shipBy: "2026-09-26",
      stage: "Printing",
      bucket: "in_production",
      priorityScore: 0,
    });
    const view = buildPriorityStack(queue([...items, urgent]), listStackState(), { now: NOW });
    const names = view.rows.map((row) => row.dealId);
    const urgentAt = names.indexOf("999");
    const later = view.rows.find((row) => row.targetDate > "2026-09-26" && row.manual);
    assert.ok(later);
    assert.ok(urgentAt < view.rows.findIndex((row) => row.key === later?.key));
    assert.equal(view.rows.find((row) => row.dealId === "999")?.isNew, true);
    resetStackOrder();
    const reset = buildPriorityStack(queue([...items, urgent]), listStackState(), { now: NOW });
    assert.equal(reset.rows.every((row) => !row.manual), true);
    assert.deepEqual(
      reset.rows.map((row) => row.key),
      rankPriorityStack(reset.rows).map((row) => row.key),
    );
  }));

test("suggested blocker uses shop flags and skips address on pickup", () => {
  assert.equal(suggestedBlocker({
    requiresPlates: true, hasPlates: false, kitReprint: 0, unassignedPlateCount: 0,
    costsIncomplete: false, addressStatus: "missing", needsReply: false, isStale: false, shippingRequired: true,
  }), "Needs plates");
  assert.equal(suggestedBlocker({
    requiresPlates: true, hasPlates: true, kitReprint: 1, unassignedPlateCount: 0,
    costsIncomplete: false, addressStatus: "ready", needsReply: false, isStale: false, shippingRequired: true,
  }), "1 part reprint");
  assert.equal(suggestedBlocker({
    requiresPlates: false, hasPlates: true, kitReprint: 0, unassignedPlateCount: 0,
    costsIncomplete: false, addressStatus: "missing", needsReply: false, isStale: false, shippingRequired: false,
  }), "");
});

test("floor strip names this week's cash, an unpriced pickup, and the next action", () => {
  const line = stackFloorLine({
    totals: { committed: 274.95 },
    rows: [
      { tier: "committed", kind: "deal", name: "Armigers", contactName: "Jose", blocker: "Pack + Pirate Ship label", nextStep: "pack + label", amount: 59.99 },
      { tier: "committed", kind: "offbook", name: "Friend order", contactName: "Darell", blocker: "Get the list", nextStep: "", amount: null },
      { tier: "stretch", kind: "deal", name: "Castigator", contactName: "Wayne", blocker: "Chassis", nextStep: "", amount: 134.99 },
    ],
  });
  assert.equal(line, "2 this week · $274.95 + Darell · next: Jose, pack + label");
});

test("shop week ends on Sunday and LA rollover stays Friday night", () => {
  assert.equal(shopWeekEnd(new Date("2026-09-27T17:00:00.000Z")), "2026-09-27");
  assert.equal(shopWeekStart(new Date("2026-09-27T17:00:00.000Z")), "2026-09-21");
  assert.equal(shopWeekEnd(new Date("2026-09-26T06:30:00.000Z")), "2026-09-27");
  assert.equal(stackTier("2026-09-27", new Date("2026-09-26T06:30:00.000Z")), "committed");
  assert.equal(stackTier("2026-09-28", NOW), "stretch");
});

test("store upsert, reorder, bundle, off-book, and done snapshot", () =>
  withTempDb(() => {
    const saved = upsertDealStackEntry("342134173423", { blocker: "Pack + Pirate Ship label" });
    assert.equal(saved.blocker, "Pack + Pirate Ship label");
    setStackOrder(["deal:342134173423", "deal:346140673754"]);
    setStackOrder(["deal:346140673754", "deal:342134173423"]);
    const ranks = listStackState().entries.filter((entry) => entry.kind === "deal").sort((a, b) => (a.manualRank ?? 0) - (b.manualRank ?? 0));
    assert.deepEqual(ranks.map((entry) => entry.hubspotDealId), ["346140673754", "342134173423"]);
    const bundle = createBundle({ label: "Simon pickup", mode: "pickup", dealIds: SIMON });
    updateBundle(bundle.id, { removeDealIds: ["348796900087"], addDealIds: ["348796900087"] });
    assert.equal(listStackState().entries.filter((entry) => entry.bundleId === bundle.id).length, 3);
    deleteBundle(bundle.id);
    assert.equal(listStackState().bundles.length, 0);
    assert.equal(listStackState().entries.find((entry) => entry.hubspotDealId === "348773062379")?.blocker, "");
    const off = createOffbook({ title: "Friend order", contactName: "Darell", mode: "pickup", targetDate: "2026-09-27" });
    markStackDone(`offbook:${off.id}`, [], NOW);
    const done = listStackState().entries.find((entry) => entry.id === off.id);
    assert.equal(done?.doneName, "Friend order");
    assert.ok(done?.doneAt);
    const view = buildPriorityStack(queue([]), listStackState(), { now: NOW });
    assert.equal(view.outTheDoor.length, 1);
    assert.equal(view.rows.some((row) => row.offbookId === off.id), false);
  }));

test("schemas reject a long blocker, a bad deal id, a bad date, and an unknown key", () => {
  assert.equal(updateStackEntrySchema.safeParse({ blocker: "x".repeat(501) }).success, false);
  assert.equal(createStackBundleSchema.safeParse({ label: "Simon", dealIds: ["nope", "12"] }).success, false);
  assert.equal(offbookEntrySchema.safeParse({ title: "Darell", targetDate: "Sunday" }).success, false);
  assert.equal(stackOrderSchema.safeParse({ keys: ["deal:abc"] }).success, false);
  assert.equal(stackDoneSchema.safeParse({ key: "nope" }).success, false);
  assert.equal(autoCompare(
    { key: "a", name: "A", targetDate: "2026-09-25", readiness: 1, amount: 1, priorityScore: 100, manualRank: null },
    { key: "b", name: "B", targetDate: "2026-09-25", readiness: 1, amount: 1, priorityScore: 1, manualRank: null },
  ) < 0, true);
});

test("priority stack routes do not PATCH HubSpot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "priority-stack-http-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
  };
  const calls: string[] = [];
  const mock = http.createServer((_req, res) => {
    calls.push(_req.method || "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  resetOrderLinkStore();
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const headers = { "content-type": "application/json", "x-paid-order-access-code": "stack-test" };
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/priority-stack/offbook`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Friend order", contactName: "Darell", mode: "pickup", targetDate: "2026-09-27" }),
    });
    assert.equal(created.status, 201);
    const listed = await fetch(`http://127.0.0.1:${port}/api/priority-stack`, { headers });
    const body = await listed.json();
    assert.equal(body.ok, true);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].name, "Friend order");
    assert.equal(body.totals.committed, 0);
    assert.equal(body.totals.offBookUnpriced, 1);
    assert.equal(calls.filter((method) => method === "PATCH").length, 0);
  } finally {
    server.close();
    mock.close();
    resetOrderLinkStore();
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
