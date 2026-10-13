import assert from "node:assert/strict";
import test from "node:test";
import {
  collectWorkshopOrders,
  countDueThisWeek,
  groupOrdersByStation,
  printerStatusLabel,
  printersAreRunning,
  workshopStationForOrder,
} from "../client/src/lib/workshop-stations";
import { sampleWorkshopQueue } from "../client/src/lib/workshop-sample";
import { workshopIntegrationTags } from "../client/src/lib/workshop-integrations";
import type { ProductionQueueItem, ProductionQueueResponse } from "../shared/schema";

function order(
  extra: Partial<ProductionQueueItem> & Pick<ProductionQueueItem, "dealId" | "stage" | "bucket">,
): ProductionQueueItem {
  return {
    dealName: extra.dealName ?? extra.dealId,
    stageId: extra.stageId ?? extra.stage,
    amount: 10,
    shipBy: extra.shipBy ?? "2026-10-20",
    shipBySource: "derived",
    tentative: false,
    shipByReason: "plan",
    addressStatus: "ready",
    addressSummary: "Seattle, WA",
    chaseDraft: "",
    shippingRequired: true,
    closeDate: null,
    contactName: "Ada",
    hasPlates: extra.hasPlates ?? false,
    requiresPlates: true,
    plateCount: extra.hasPlates ? 1 : 0,
    totalPrintTimeSeconds: null,
    assignedPrinterIds: [],
    assignedPrinterNames: [],
    unassignedPlateCount: 0,
    kitNeeded: 0,
    kitReprint: 0,
    costsIncomplete: false,
    isStale: false,
    needsReply: false,
    readyToPack: extra.bucket === "ship_ready",
    fulfillment: {
      dealId: extra.dealId,
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
      shipReady: extra.bucket === "ship_ready",
      updatedAt: null,
    },
    priorityScore: 1,
    ...extra,
  };
}

test("workshop stations follow HubSpot labels and queue buckets", () => {
  assert.equal(
    workshopStationForOrder({ stage: "Deposit Received", bucket: "next_print", hasPlates: false }),
    "intake",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Queued to Print", bucket: "next_print", hasPlates: false }),
    "intake",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Queued to Print", bucket: "next_print", hasPlates: true }),
    "print",
  );
  assert.equal(
    workshopStationForOrder({ stage: "In Production", bucket: "in_production", hasPlates: true }),
    "print",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Printing", bucket: "in_production", hasPlates: true }),
    "print",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Wash / Cure", bucket: "in_production", hasPlates: true }),
    "wash",
  );
  assert.equal(
    workshopStationForOrder({ stage: "QC", bucket: "in_production", hasPlates: true }),
    "qa",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Post-Process / QC", bucket: "in_production", hasPlates: true }),
    "qa",
  );
  assert.equal(
    workshopStationForOrder({ stage: "Ready to Ship", bucket: "ship_ready", hasPlates: true }),
    "pack",
  );
  assert.equal(
    workshopStationForOrder({ stage: "In Production", bucket: "ship_ready", hasPlates: true }),
    "pack",
  );
});

test("sample workshop places one order on each station", () => {
  const grouped = groupOrdersByStation(collectWorkshopOrders(sampleWorkshopQueue(new Date("2026-10-13T17:00:00Z"))));
  assert.equal(grouped.intake.length, 1);
  assert.equal(grouped.print.length, 1);
  assert.equal(grouped.wash.length, 1);
  assert.equal(grouped.qa.length, 1);
  assert.equal(grouped.pack.length, 1);
  assert.equal(printersAreRunning(collectWorkshopOrders(sampleWorkshopQueue())), true);
});

test("workshop queue collect is unique across overlapping lanes", () => {
  const pack = order({ dealId: "1", stage: "Ready to Ship", bucket: "ship_ready", hasPlates: true });
  const queue = {
    nextPrint: [],
    inProduction: [],
    shipReady: [pack],
    blocked: [pack],
  } as Pick<ProductionQueueResponse, "nextPrint" | "inProduction" | "shipReady" | "blocked">;
  assert.equal(collectWorkshopOrders(queue).length, 1);
});

test("due this week counts overdue, today, and the shop week", () => {
  const orders = [
    order({ dealId: "a", stage: "Deposit Received", bucket: "next_print", shipBy: "2026-10-10" }),
    order({ dealId: "b", stage: "Deposit Received", bucket: "next_print", shipBy: "2026-10-13" }),
    order({ dealId: "c", stage: "Deposit Received", bucket: "next_print", shipBy: "2026-10-18" }),
    order({ dealId: "d", stage: "Deposit Received", bucket: "next_print", shipBy: "2026-11-01" }),
  ];
  assert.equal(countDueThisWeek(orders, "2026-10-13"), 3);
});

test("printer status prefers live printing over idle fleet", () => {
  assert.equal(printerStatusLabel({ printers: [{ status: "active" }], printing: true }), "1 printing");
  assert.equal(printerStatusLabel({ printers: [{ status: "active" }, { status: "retired" }], printing: false }), "1 ready");
  assert.equal(printerStatusLabel({ printers: [], printing: false }), "No printers");
});

test("pegboard tags glow from sync-health style summaries", () => {
  const tags = workshopIntegrationTags({
    hubspotSync: {
      status: "ok",
      counts: {
        missingInOps: 0,
        orphans: 0,
        tracking: 0,
        shipNotes: 0,
        shipBy: 0,
        costs: 0,
        amount: 0,
        doneStillOpen: 0,
        closedNotDone: 0,
        failedWrites: 0,
        failedRecalcs: 0,
        webhook: 0,
        token: 0,
      },
      issueCount: 0,
      lastSuccessfulReadAt: null,
      lastSuccessfulWriteAt: null,
      lastCheckedAt: null,
      writes: { pending: 0, failed: 0 },
      webhook: { configured: true, arriving: true, lastDeliveryAt: null, note: "" },
    },
    storage: { configured: true, ephemeral: true, durableVolumeLikely: false, warning: "ephemeral" },
    drive: { configured: true, connected: true, reconnect: true },
    libraryCount: 0,
  });
  assert.equal(tags.find((tag) => tag.id === "hubspot")?.tone, "green");
  assert.equal(tags.find((tag) => tag.id === "railway")?.tone, "amber");
  assert.equal(tags.find((tag) => tag.id === "drive")?.tone, "amber");
  assert.equal(tags.find((tag) => tag.id === "files")?.tone, "amber");
});
