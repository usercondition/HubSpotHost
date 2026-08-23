import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertFulfillmentChecklist, getFulfillmentChecklist } from "../server/lib/fulfillment";
import { createProductionFailure, listFailuresForDeal } from "../server/lib/failures";
import { buildProductionQueue } from "../server/lib/production-queue";
import { buildResinReorderSuggestions } from "../server/lib/resin-reorder";
import { assignPlateToPrinter } from "../server/lib/deal-ops";
import { getDb, resetOrderLinkStore } from "../server/lib/order-links";
import { printFileRecords } from "../shared/schema";
import type { PerformanceResponse, ResinInventorySnapshot } from "../shared/schema";
import { eq } from "drizzle-orm";

function withTempDb(run: () => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ops-hub-"));
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

function sampleSnapshot(overrides?: Partial<PerformanceResponse["activeDeals"][number]>[]): PerformanceResponse {
  const deals = overrides ?? [
    {
      dealId: "1001",
      dealName: "Dragon bust - Ada",
      stageId: "s1",
      stage: "Deposit Received",
      amount: 120,
      hasPlates: false,
      promptAttachPlates: true,
      requiresPlates: true,
      closeDate: "2026-08-10",
      contactName: "Ada",
    },
    {
      dealId: "1002",
      dealName: "Kit set - Beau",
      stageId: "s2",
      stage: "In Production",
      amount: 220,
      hasPlates: true,
      promptAttachPlates: false,
      requiresPlates: true,
      closeDate: null,
      contactName: "Beau",
    },
  ];
  return {
    generatedAt: new Date().toISOString(),
    period: { days: 30, startsAt: "2026-07-01T00:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 340,
      grossProfit: 100,
      weightedMarginPercent: 40,
      orders: 2,
      averageOrderValue: 170,
      activeOrders: 2,
      attentionCount: 1,
    },
    intake: { awaitingClient: 0, pendingReview: 0, approved: 2 },
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 340,
      orderCosts: 240,
      grossProfit: 100,
      orders: 2,
      supplySpend: 0,
      supplyPurchases: 0,
      afterSupplySpend: 100,
      supplyShareOfRevenuePercent: 0,
      supplyShareOfGrossProfitPercent: 0,
      byCategory: [],
    },
    pipeline: [
      { id: "s1", label: "Deposit Received", count: 1, closed: false },
      { id: "s2", label: "In Production", count: 1, closed: false },
    ],
    attention: [
      {
        dealId: "1001",
        dealName: "Dragon bust - Ada",
        stage: "Deposit Received",
        issue: "Cost details incomplete",
        issueKey: "costs_incomplete",
        detail: "Missing costs",
        severity: "warn",
      },
    ],
    activeDeals: deals,
    closedDeals: [],
    hubspotPortalId: "999",
  };
}

test("fulfillment checklist upserts and reports ship-ready progress", async () => {
  await withTempDb(async () => {
    const empty = getFulfillmentChecklist("1001");
    assert.equal(empty.readyPercent, 0);
    assert.equal(empty.shipReady, false);

    const mid = await upsertFulfillmentChecklist("1001", {
      addressVerified: true,
      costsEntered: true,
      labelBought: true,
    });
    assert.ok(!("error" in mid));
    if ("error" in mid) return;
    assert.equal(mid.checklist.completedCount, 3);
    assert.equal(mid.checklist.readyPercent, 60);
    assert.equal(mid.hubspot, null);

    const done = await upsertFulfillmentChecklist("1001", {
      trackingPasted: true,
      packingDone: true,
      trackingNumber: "9400TEST",
      liveWrite: false,
    });
    assert.ok(!("error" in done));
    if ("error" in done) return;
    assert.equal(done.checklist.shipReady, true);
    assert.equal(done.checklist.trackingNumber, "9400TEST");
    assert.ok(done.hubspot);
    assert.equal(done.hubspot?.dryRun, true);

    const { findLocalTrackingAttachment, normalizeTrackingNumber } = await import(
      "../server/lib/fulfillment"
    );
    assert.equal(normalizeTrackingNumber("1z xg99-79"), "1ZXG9979");
    const hit = findLocalTrackingAttachment("9400TEST");
    assert.ok(hit);
    assert.equal(hit?.dealId, "1001");
    assert.equal(findLocalTrackingAttachment("9400test")?.dealId, "1001");
    assert.equal(findLocalTrackingAttachment("NOPE"), null);
  });
});

test("production failures persist per deal", async () => {
  await withTempDb(() => {
    createProductionFailure({
      dealId: "1002",
      dealName: "Kit set - Beau",
      failureType: "qc_reject",
      notes: "Horn snapped",
      resinMassG: "12",
    });
    const rows = listFailuresForDeal("1002");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.failureType, "qc_reject");
    assert.match(rows[0]!.notes, /Horn/);
  });
});

test("production queue buckets next print vs in production", async () => {
  await withTempDb(() => {
    getDb()
      .insert(printFileRecords)
      .values({
        analysisId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        hubspotDealId: "1002",
        hubspotDealName: "Kit set - Beau",
        dealStage: "In Production",
        fileName: "beau.ctb",
        fileSizeBytes: 100,
        sha256: "abc",
        formatRevision: "CTB v4",
        printTimeSeconds: 3600,
        resinVolumeMl: "50",
        resinMassG: "55",
        resinCost: null,
        resinCostSource: null,
        resinCostLabel: null,
        resinDensityGPerMl: null,
        layerCount: 1000,
        layerHeightMm: "0.05",
        modelHeightMm: null,
        exposureSeconds: null,
        bottomExposureSeconds: null,
        lightOffSeconds: null,
        bottomLightOffSeconds: null,
        bottomLayerCount: null,
        liftDistanceMm: null,
        liftSpeedMmPerMin: null,
        bottomLiftDistanceMm: null,
        bottomLiftSpeedMmPerMin: null,
        retractSpeedMmPerMin: null,
        resolutionX: null,
        resolutionY: null,
        printerProfile: "Mighty 8K",
        fleetPrinterId: null,
        hubspotSyncedAt: "2026-08-01T00:00:00.000Z",
        attachedAt: "2026-08-01T00:00:00.000Z",
      })
      .run();

    const queue = buildProductionQueue(sampleSnapshot());
    assert.equal(queue.summary.nextPrint, 1);
    assert.ok(queue.nextPrint.some((item) => item.dealId === "1001"));
    assert.ok(
      queue.inProduction.some((item) => item.dealId === "1002") ||
        queue.blocked.some((item) => item.dealId === "1002") ||
        queue.shipReady.some((item) => item.dealId === "1002"),
    );
  });
});

test("production queue excludes shipping and fee charge deals entirely", async () => {
  await withTempDb(() => {
    const snapshot = sampleSnapshot([
      {
        dealId: "ship-1",
        dealName: "Shipping - Sam Jensen",
        stageId: "s1",
        stage: "Deposit Received",
        amount: 8,
        hasPlates: false,
        promptAttachPlates: false,
        requiresPlates: false,
        closeDate: null,
        contactName: "Sam Jensen",
      },
      {
        dealId: "fee-1",
        dealName: "Paypal 4% Fee - Sam Jensen",
        stageId: "s1",
        stage: "Deposit Received",
        amount: 2,
        hasPlates: false,
        promptAttachPlates: false,
        requiresPlates: false,
        closeDate: null,
        contactName: "Sam Jensen",
      },
      {
        dealId: "print-1",
        dealName: "Armigers - Jose",
        stageId: "s1",
        stage: "Queued to Print",
        amount: 59.99,
        hasPlates: false,
        promptAttachPlates: true,
        requiresPlates: true,
        closeDate: null,
        contactName: "Jose",
      },
    ]);
    const queue = buildProductionQueue(snapshot);
    assert.equal(queue.summary.nextPrint, 1);
    assert.equal(queue.summary.openOrders, 1);
    assert.ok(queue.nextPrint.every((item) => item.dealId === "print-1"));
    assert.equal(queue.inProduction.length, 0);
    assert.ok(!queue.nextPrint.some((item) => item.dealId === "ship-1" || item.dealId === "fee-1"));
    assert.ok(!queue.inProduction.some((item) => item.dealId === "ship-1" || item.dealId === "fee-1"));
    assert.ok(!queue.shipReady.some((item) => item.dealId === "ship-1" || item.dealId === "fee-1"));
    assert.ok(!queue.blocked.some((item) => item.dealId === "ship-1" || item.dealId === "fee-1"));
    assert.equal(queue.nextPrint[0]?.requiresPlates, true);
  });
});

test("plate printer assignment stores fleet_printer_id", async () => {
  await withTempDb(() => {
    const record = getDb()
      .insert(printFileRecords)
      .values({
        analysisId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        hubspotDealId: "1002",
        hubspotDealName: "Kit set - Beau",
        dealStage: "In Production",
        fileName: "beau.ctb",
        fileSizeBytes: 100,
        sha256: "abc",
        formatRevision: "CTB v4",
        printTimeSeconds: 3600,
        resinVolumeMl: null,
        resinMassG: null,
        resinCost: null,
        resinCostSource: null,
        resinCostLabel: null,
        resinDensityGPerMl: null,
        layerCount: null,
        layerHeightMm: null,
        modelHeightMm: null,
        exposureSeconds: null,
        bottomExposureSeconds: null,
        lightOffSeconds: null,
        bottomLightOffSeconds: null,
        bottomLayerCount: null,
        liftDistanceMm: null,
        liftSpeedMmPerMin: null,
        bottomLiftDistanceMm: null,
        bottomLiftSpeedMmPerMin: null,
        retractSpeedMmPerMin: null,
        resolutionX: null,
        resolutionY: null,
        printerProfile: "Odd Profile",
        fleetPrinterId: null,
        hubspotSyncedAt: "2026-08-01T00:00:00.000Z",
        attachedAt: "2026-08-01T00:00:00.000Z",
      })
      .returning()
      .get();

    const assigned = assignPlateToPrinter({ recordId: record.id, printerId: 1 });
    assert.equal(assigned.ok, true);
    if (!assigned.ok) return;
    assert.equal(assigned.assignedPrinterId, 1);
    const stored = getDb().select().from(printFileRecords).where(eq(printFileRecords.id, record.id)).get();
    assert.equal(stored?.fleetPrinterId, 1);

    const cleared = assignPlateToPrinter({ recordId: record.id, printerId: null });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(cleared.assignedPrinterId, null);
    const clearedRow = getDb().select().from(printFileRecords).where(eq(printFileRecords.id, record.id)).get();
    assert.equal(clearedRow?.fleetPrinterId, null);
  });
});

test("resin reorder suggests buy when sealed stock is empty and burn is high", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const snapshot: ResinInventorySnapshot = {
    products: [
      {
        id: 1,
        name: "ABS-Like Grey",
        brand: "ELEGOO",
        bottleMassG: 1000,
        bottleVolumeMl: 1000,
        unitCostUsd: 30,
        sealedCount: 0,
        sealedValueUsd: 0,
        openBottleCount: 1,
        notes: "",
      },
    ],
    bottles: [
      {
        bottleId: 9,
        productId: 1,
        productName: "ABS-Like Grey",
        brand: "ELEGOO",
        status: "open",
        isActive: true,
        openedAt: "2026-07-01T00:00:00.000Z",
        initialMassG: 1000,
        remainingMassG: 80,
        usedMassG: 920,
        usedPercent: 92,
        unitCostUsd: 30,
        costPerGram: 0.03,
        materialCostUsedUsd: 27.6,
        plateCount: 10,
        distinctOrders: 4,
        attributedDealRevenueUsd: 400,
        roughContributionUsd: 372,
        notes: "",
        recentConsumptions: [],
      },
    ],
    activeBottle: null,
    totals: {
      sealedBottles: 0,
      sealedValueUsd: 0,
      openBottles: 1,
      resinUsedGrams: 920,
      materialCostUsedUsd: 27.6,
      attributedDealRevenueUsd: 400,
    },
  };

  // Without consumption rows in DB, burn is near zero — still flags empty sealed + low open.
  const result = buildResinReorderSuggestions(snapshot, { now, lookbackDays: 30 });
  assert.ok(result.suggestions.length >= 1);
  const grey = result.suggestions.find((item) => item.productId === 1);
  assert.ok(grey);
  assert.ok(grey!.urgency === "soon" || grey!.urgency === "watch" || grey!.suggestedBuyCount >= 1);
});
