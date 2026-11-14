import test from "node:test";
import assert from "node:assert/strict";
import { buildTrackingRows, type TrackingShipment } from "../shared/order-tracking";
import type { ProductionQueueItem } from "../shared/schema";

function item(partial: Partial<ProductionQueueItem> & Pick<ProductionQueueItem, "dealId" | "bucket">): ProductionQueueItem {
  return {
    dealName: "Order",
    stageId: "s",
    stage: "Queued to Print",
    amount: 10,
    shipBy: "2026-11-14",
    shipBySource: "derived",
    tentative: false,
    shipByReason: "",
    addressStatus: "unknown",
    addressSummary: null,
    chaseDraft: "",
    shippingRequired: true,
    closeDate: null,
    contactName: null,
    hasPlates: false,
    requiresPlates: true,
    plateCount: 0,
    totalPrintTimeSeconds: null,
    assignedPrinterIds: [],
    assignedPrinterNames: [],
    unassignedPlateCount: 0,
    kitNeeded: 0,
    kitReprint: 0,
    costsIncomplete: false,
    isStale: false,
    needsReply: false,
    readyToPack: false,
    fulfillment: {
      dealId: partial.dealId,
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
    },
    priorityScore: 0,
    ...partial,
  };
}

function shipment(partial: Partial<TrackingShipment> & Pick<TrackingShipment, "id" | "status">): TrackingShipment {
  return {
    dealId: null,
    name: "Buyer",
    stale: false,
    trackingNumber: "1Z",
    shipDate: "2026-11-10",
    carrierCode: "ups",
    voided: false,
    ...partial,
  };
}

test("tracking rows advance queue to printed to labeled and flag stuck transit", () => {
  const rows = buildTrackingRows(
    [
      item({ dealId: "q", bucket: "next_print", dealName: "Still queued" }),
      item({ dealId: "p", bucket: "in_production", dealName: "On the printer", stage: "In Production" }),
      item({
        dealId: "l",
        bucket: "ship_ready",
        dealName: "Has a label",
        fulfillment: {
          dealId: "l",
          addressVerified: true,
          costsEntered: true,
          labelBought: true,
          trackingPasted: true,
          packingDone: true,
          trackingNumber: "9400",
          notes: "",
          completedCount: 5,
          totalCount: 5,
          readyPercent: 100,
          shipReady: true,
          updatedAt: null,
        },
      }),
    ],
    [
      shipment({ id: "s1", dealId: "q", name: "Still queued", status: "in transit", stale: true, trackingNumber: "1ZSTUCK" }),
      shipment({ id: "s2", dealId: null, name: "Walk-up", status: "delivered", trackingNumber: "940011" }),
      shipment({ id: "void", dealId: "gone", name: "Voided", status: "label created", voided: true }),
    ],
  );
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.equal(byName["On the printer"].stage, "printed");
  assert.equal(byName["Has a label"].stage, "labeled");
  assert.equal(byName["Still queued"].stage, "transit");
  assert.equal(byName["Still queued"].stuck, true);
  assert.equal(byName["Walk-up"].stage, "delivered");
  assert.equal(byName.Voided, undefined);
});
