/**
 * Production queue: next print, in production, ship-ready, blocked.
 * Built from Performance snapshot + local plates / kits / checklists / assignments.
 */
import { desc } from "drizzle-orm";
import {
  printFileRecords,
  type PerformanceResponse,
  type ProductionQueueItem,
  type ProductionQueueResponse,
} from "../../shared/schema";
import { listFulfillmentChecklists } from "./fulfillment";
import { failureSummary, listProductionFailures } from "./failures";
import { listKitSummaries } from "./kits";
import { getDb } from "./order-links";
import { ensureDefaultPrinters, listPrinterProfileMaps, resolvePrinterIdForRecord } from "./printers";

function parseGrams(value: string | null | undefined): number {
  const n = Number(value ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function priorityScore(item: Omit<ProductionQueueItem, "priorityScore" | "bucket">): number {
  let score = 0;
  if (item.closeDate) {
    const days = Math.floor((new Date(item.closeDate).getTime() - Date.now()) / 86_400_000);
    if (Number.isFinite(days)) {
      if (days <= 0) score += 100;
      else if (days <= 3) score += 70;
      else if (days <= 7) score += 40;
    }
  }
  if (item.requiresPlates && !item.hasPlates) score += 50;
  if (item.kitReprint > 0) score += 35;
  if (item.kitNeeded > 0) score += 20;
  if (item.costsIncomplete) score += 15;
  if (item.unassignedPlateCount > 0) score += 10;
  if (item.fulfillment.shipReady) score -= 20;
  score += Math.min(30, item.amount / 20);
  return score;
}

function classifyBucket(item: Omit<ProductionQueueItem, "priorityScore" | "bucket">): ProductionQueueItem["bucket"] {
  // Print deals only reach here; charge lines are filtered out upstream.
  if (item.requiresPlates && !item.hasPlates) return "next_print";
  if (item.requiresPlates && (item.kitReprint > 0 || item.kitNeeded > 0 || item.unassignedPlateCount > 0)) {
    return "blocked";
  }
  if (item.fulfillment.shipReady || item.fulfillment.readyPercent >= 80) return "ship_ready";
  return "in_production";
}

export function buildProductionQueue(snapshot: PerformanceResponse): ProductionQueueResponse {
  const fleet = ensureDefaultPrinters();
  const maps = listPrinterProfileMaps();
  const printerName = new Map(fleet.map((printer) => [printer.id, printer.name]));

  const plates = getDb()
    .select()
    .from(printFileRecords)
    .orderBy(desc(printFileRecords.attachedAt), desc(printFileRecords.id))
    .limit(2_000)
    .all();

  const platesByDeal = new Map<string, typeof plates>();
  for (const plate of plates) {
    const list = platesByDeal.get(plate.hubspotDealId) ?? [];
    list.push(plate);
    platesByDeal.set(plate.hubspotDealId, list);
  }

  // Charge-only HubSpot deals (shipping / fees) are not production work.
  const printDeals = snapshot.activeDeals.filter((deal) => deal.requiresPlates);

  const kitByDeal = new Map(listKitSummaries(200).map((kit) => [kit.hubspotDealId, kit]));
  const checklists = listFulfillmentChecklists(printDeals.map((deal) => deal.dealId));
  const costsIncomplete = new Set(
    snapshot.attention.filter((item) => item.issueKey === "costs_incomplete").map((item) => item.dealId),
  );
  const staleDealIds = new Set(
    snapshot.attention.filter((item) => item.issueKey === "stale").map((item) => item.dealId),
  );

  const items: ProductionQueueItem[] = printDeals.map((deal) => {
    const dealPlates = platesByDeal.get(deal.dealId) ?? [];
    const assignedIds: number[] = [];
    let unassignedPlateCount = 0;
    let totalPrintTimeSeconds = 0;
    for (const plate of dealPlates) {
      const printerId = resolvePrinterIdForRecord(plate, fleet, maps);
      if (printerId == null) unassignedPlateCount += 1;
      else if (!assignedIds.includes(printerId)) assignedIds.push(printerId);
      if (plate.printTimeSeconds && plate.printTimeSeconds > 0) totalPrintTimeSeconds += plate.printTimeSeconds;
    }
    const kit = kitByDeal.get(deal.dealId);
    const base = {
      dealId: deal.dealId,
      dealName: deal.dealName,
      stageId: deal.stageId,
      stage: deal.stage,
      amount: deal.amount,
      closeDate: deal.closeDate,
      contactName: deal.contactName,
      hasPlates: deal.hasPlates || dealPlates.length > 0,
      requiresPlates: deal.requiresPlates,
      plateCount: dealPlates.length,
      totalPrintTimeSeconds: totalPrintTimeSeconds > 0 ? totalPrintTimeSeconds : null,
      assignedPrinterIds: assignedIds,
      assignedPrinterNames: assignedIds.map((id) => printerName.get(id) || `Printer ${id}`),
      unassignedPlateCount,
      kitNeeded: kit?.needed ?? 0,
      kitReprint: kit?.reprint ?? 0,
      costsIncomplete: costsIncomplete.has(deal.dealId),
      isStale: staleDealIds.has(deal.dealId),
      fulfillment: checklists.get(deal.dealId) ?? {
        dealId: deal.dealId,
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
    };
    const bucket = classifyBucket(base);
    return { ...base, bucket, priorityScore: priorityScore(base) };
  });

  items.sort((a, b) => b.priorityScore - a.priorityScore || a.dealName.localeCompare(b.dealName));

  const nextPrint = items.filter((item) => item.bucket === "next_print");
  const inProduction = items.filter((item) => item.bucket === "in_production");
  const shipReady = items.filter((item) => item.bucket === "ship_ready");
  const blocked = items.filter((item) => item.bucket === "blocked");

  return {
    generatedAt: new Date().toISOString(),
    hubspotPortalId: snapshot.hubspotPortalId,
    stages: snapshot.pipeline.map((stage) => ({
      id: stage.id,
      label: stage.label,
      closed: stage.closed,
    })),
    printers: fleet.map((printer) => ({
      id: printer.id,
      name: printer.name,
      status: printer.status,
    })),
    nextPrint,
    inProduction,
    shipReady,
    blocked,
    recentFailures: listProductionFailures(12).map(failureSummary),
    summary: {
      nextPrint: nextPrint.length,
      inProduction: inProduction.length,
      shipReady: shipReady.length,
      blocked: blocked.length,
      openOrders: items.length,
    },
  };
}

/** Re-export helper for tests / digest alignment. */
export function plateResinMassG(value: string | null | undefined): number {
  return parseGrams(value);
}
