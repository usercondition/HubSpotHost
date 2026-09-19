import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveShipAddressReadiness,
  draftAddressChaseMessage,
  dealNameForChase,
} from "../shared/ship-address";
import { hubspotStageLooksShipReady, type ProductionQueueItem, type ProductionQueueResponse } from "../shared/schema";
import { contactToShipEngineAddress } from "../server/lib/shipengine";
import { queueItemsForShipAddressEnrichment } from "../server/lib/production-queue";
import {
  answerTrackerQuestionRules,
  type TrackerAssistantContext,
  type TrackerAssistantQueueDeal,
} from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

test("deriveShipAddressReadiness marks ready / partial / missing", () => {
  const ready = deriveShipAddressReadiness({
    name: "Ada Lovelace",
    street1: "1 Analytical Engine Way",
    city: "Los Angeles",
    state: "CA",
    zip: "90012",
    country: "US",
    dealName: "Knight bust - Ada",
  });
  assert.equal(ready.addressStatus, "ready");
  assert.equal(ready.addressSummary, "Los Angeles, CA");
  assert.deepEqual(ready.missingFields, []);
  assert.match(ready.chaseDraft, /Hey Ada/);
  assert.match(ready.chaseDraft, /Knight bust/);

  const partial = deriveShipAddressReadiness({
    name: "Bea",
    street1: "12 Main",
    city: "Austin",
    state: "",
    zip: "78701",
    dealName: "Terrain - Bea",
  });
  assert.equal(partial.addressStatus, "partial");
  assert.ok(partial.missingFields.includes("state"));
  assert.equal(partial.addressSummary, "Austin");

  const missing = deriveShipAddressReadiness({
    name: "",
    street1: "",
    city: "",
    state: "",
    zip: "",
    dealName: "Display base - Cy",
  });
  assert.equal(missing.addressStatus, "missing");
  assert.equal(missing.addressSummary, null);
  assert.match(missing.chaseDraft, /Hey Cy/);
});

test("name-only contact is missing, not ready", () => {
  const result = deriveShipAddressReadiness({
    name: "Only Name",
    street1: "",
    city: "",
    state: "",
    zip: "",
  });
  assert.equal(result.addressStatus, "missing");
});

test("chase draft prefers first name and product title", () => {
  assert.equal(dealNameForChase("Knight bust - Ada"), "Knight bust");
  assert.match(
    draftAddressChaseMessage({
      firstName: "miguel",
      dealName: "Resin pack - Miguel",
    }),
    /^Hey Miguel — your Resin pack is ready to ship/,
  );
});

test("ShipEngine gate agrees with ready address fields", () => {
  const contact = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "",
    street1: "1 Analytical Engine Way",
    street2: "",
    city: "Los Angeles",
    state: "California",
    zip: "90012",
    country: "US",
  };
  const address = contactToShipEngineAddress(contact);
  assert.ok(address);
  assert.equal(address.state, "CA");
  const readiness = deriveShipAddressReadiness(contact);
  assert.equal(readiness.addressStatus, "ready");
});

test("Angel-shaped HubSpot contact (Ca + United States) is address-ready", () => {
  const contact = {
    name: "Angel Pineda",
    email: "marfar138@gmail.com",
    phone: "6614317094",
    street1: "3509 janene way",
    street2: "",
    city: "Bakersfield",
    state: "Ca",
    zip: "93306",
    country: "United States",
  };
  const address = contactToShipEngineAddress(contact);
  assert.ok(address);
  assert.equal(address.state, "CA");
  assert.equal(address.country, "US");
  assert.equal(deriveShipAddressReadiness(contact).addressStatus, "ready");
});

test("Post-Process / QC counts as HubSpot ship-ready stage", () => {
  assert.equal(hubspotStageLooksShipReady("Post-Process / QC"), true);
  assert.equal(hubspotStageLooksShipReady("Ready to Ship"), true);
  assert.equal(hubspotStageLooksShipReady("In Production"), false);
  assert.equal(hubspotStageLooksShipReady("Queued to Print"), false);
});

test("Labels enrichment targets include low readyPercent in-production deals", () => {
  const thin = (dealId: string, bucket: ProductionQueueItem["bucket"], readyPercent: number): ProductionQueueItem =>
    ({
      dealId,
      dealName: dealId,
      stageId: "s",
      stage: bucket === "ship_ready" ? "Ready to Ship" : "In Production",
      amount: 10,
      contactName: "Ada",
      hasPlates: true,
      requiresPlates: true,
      promptAttachPlates: false,
      costsIncomplete: false,
      needsReply: false,
      kitNeeded: 0,
      kitReprint: 0,
      unassignedPlateCount: 0,
      assignedPrinterIds: [],
      assignedPrinterNames: [],
      plateCount: 1,
      totalPrintTimeSeconds: 0,
      totalResinMassG: 0,
      latestPlateAttachedAt: null,
      fulfillment: {
        packingDone: false,
        labelBought: false,
        trackingPasted: false,
        shipReady: false,
        readyPercent,
        notes: null,
        updatedAt: null,
      },
      priorityScore: 0,
      bucket,
      readyToPack: false,
      shipBy: "2026-09-20",
      shipBySource: "derived",
      shipByReason: "test",
      shipByOverride: null,
      shipPlanNote: null,
      addressStatus: "missing",
      addressSummary: null,
      chaseDraft: "Hey Ada — your order is ready to ship. Can you confirm the best address to send it to?",
    }) as ProductionQueueItem;

  const queue = {
    generatedAt: "2026-09-19T00:00:00.000Z",
    hubspotPortalId: null,
    stages: [],
    printers: [],
    nextPrint: [],
    inProduction: [thin("angel-qc", "in_production", 40)],
    shipReady: [thin("ready-1", "ship_ready", 100)],
    blocked: [],
    needsReply: [],
    readyToPack: [],
    recentFailures: [],
    summary: {
      nextPrint: 0,
      inProduction: 1,
      shipReady: 1,
      blocked: 0,
      needsReply: 0,
      readyToPack: 0,
      needsAddress: 2,
      openOrders: 2,
    },
  } as ProductionQueueResponse;

  const ids = queueItemsForShipAddressEnrichment(queue).map((item) => item.dealId).sort();
  assert.deepEqual(ids, ["angel-qc", "ready-1"]);
});

function emptySnapshot(): PerformanceResponse {
  return {
    generatedAt: "2026-09-17T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-08-18T12:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 0,
      grossProfit: 0,
      weightedMarginPercent: 0,
      orders: 0,
      averageOrderValue: 0,
      activeOrders: 1,
      attentionCount: 0,
    },
    intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 0,
      orderCosts: 0,
      grossProfit: 0,
      orders: 0,
      supplySpend: 0,
      supplyPurchases: 0,
      afterSupplySpend: 0,
      supplyShareOfRevenuePercent: 0,
      supplyShareOfGrossProfitPercent: 0,
      byCategory: [],
    },
    pipeline: [],
    attention: [],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: null,
  };
}

test("tracker assistant lists needs-address deals with chase drafts", () => {
  const deal: TrackerAssistantQueueDeal = {
    dealId: "d9",
    dealName: "Ready knight - Bea",
    stage: "Ready to Ship",
    amount: 120,
    bucket: "ship_ready",
    costsIncomplete: false,
    hasPlates: true,
    labelBought: false,
    trackingPasted: false,
    shipReady: true,
    readyToPack: true,
    addressStatus: "missing",
    addressSummary: null,
    chaseDraft:
      "Hey Bea — your Ready knight is ready to ship. Can you confirm the best address to send it to?",
  };
  const ctx: TrackerAssistantContext = {
    snapshot: emptySnapshot(),
    awaitingLinks: [],
    pendingLinks: [],
    queue: {
      summary: {
        nextPrint: 0,
        inProduction: 0,
        shipReady: 1,
        blocked: 0,
        needsReply: 0,
        readyToPack: 1,
        needsAddress: 1,
        openOrders: 1,
      },
      nextPrint: [],
      shipReady: [deal],
      blocked: [],
      needsReply: [],
      readyToPack: [deal],
      needsLabel: [deal],
      needsAddress: [deal],
    },
  };
  const answer = answerTrackerQuestionRules("What needs an address?", ctx);
  assert.match(answer.reply, /Ready knight/);
  assert.match(answer.reply, /Hey Bea/);
  assert.match(answer.reply, /never send/i);
  assert.ok(answer.actions.some((action) => action.href.includes("/labels")));
});
