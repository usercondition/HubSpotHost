/**
 * Production queue: next print, in production, ship-ready, blocked.
 * Built from Performance snapshot + local plates / kits / checklists / assignments.
 */
import { desc } from "drizzle-orm";
import {
  hubspotStageLooksShipReady,
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

type QueueItemBase = Omit<
  ProductionQueueItem,
  "priorityScore" | "bucket" | "readyToPack" | "shipBy" | "shipBySource"
>;

/** Ship-by planning always uses the shop's calendar, never the server's timezone. */
export const SHIP_BY_TIME_ZONE = "America/Los_Angeles";
/** Default calendar-day SLAs, kept here so the Floor and API stay aligned. */
export const SHIP_BY_SLA_DAYS = {
  queued: 10,
  inProduction: 5,
} as const;

function localCalendarDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHIP_BY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDate(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? localCalendarDate(date) : null;
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function deriveShipBy(
  item: Pick<ProductionQueueItem, "bucket" | "hasPlates" | "shipByOverride" | "createdAt">,
  options: { now?: Date; latestPlateAttachedAt?: string | null } = {},
): Pick<ProductionQueueItem, "shipBy" | "shipBySource"> {
  const override = calendarDate(item.shipByOverride);
  if (override) return { shipBy: override, shipBySource: "override" };

  const today = localCalendarDate(options.now ?? new Date());
  // Ship-ready work is due today. Printing/post-process work gets five calendar
  // days from its latest plate attachment (or deal creation); queued work gets ten.
  if (item.bucket === "ship_ready") return { shipBy: today, shipBySource: "derived" };
  const anchor =
    calendarDate(options.latestPlateAttachedAt) ??
    calendarDate(item.createdAt) ??
    today;
  const days = item.bucket === "in_production" || item.hasPlates
    ? SHIP_BY_SLA_DAYS.inProduction
    : SHIP_BY_SLA_DAYS.queued;
  return { shipBy: addCalendarDays(anchor, days), shipBySource: "derived" };
}

function priorityScore(item: QueueItemBase): number {
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

function classifyBucket(item: QueueItemBase): ProductionQueueItem["bucket"] {
  // Print deals only reach here; charge lines are filtered out upstream.
  const hubspotShipReady = hubspotStageLooksShipReady(item.stage);
  // Missing plates normally means Next print — but if HubSpot already says
  // Ready to Ship, keep the card on the ship side so Labels can see it.
  if (item.requiresPlates && !item.hasPlates && !hubspotShipReady) return "next_print";
  if (item.requiresPlates && (item.kitReprint > 0 || item.kitNeeded > 0 || item.unassignedPlateCount > 0)) {
    return "blocked";
  }
  if (item.fulfillment.shipReady || item.fulfillment.readyPercent >= 80 || hubspotShipReady) {
    return "ship_ready";
  }
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
    const latestPlateAttachedAt = dealPlates.reduce<string | null>(
      (latest, plate) => (!latest || plate.attachedAt > latest ? plate.attachedAt : latest),
      null,
    );
    const base = {
      dealId: deal.dealId,
      dealName: deal.dealName,
      stageId: deal.stageId,
      stage: deal.stage,
      amount: deal.amount,
      shipByOverride: deal.shipByOverride,
      createdAt: deal.createdAt,
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
      needsReply: deal.needsReply === true,
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
    const readyToPack =
      bucket === "ship_ready" &&
      (!base.fulfillment.packingDone || !base.fulfillment.labelBought || !base.fulfillment.trackingPasted);
    return {
      ...base,
      ...deriveShipBy({ ...base, bucket }, { latestPlateAttachedAt }),
      bucket,
      readyToPack,
      priorityScore: priorityScore(base),
    };
  });

  items.sort((a, b) => b.priorityScore - a.priorityScore || a.dealName.localeCompare(b.dealName));

  const nextPrint = items.filter((item) => item.bucket === "next_print");
  const inProduction = items.filter((item) => item.bucket === "in_production");
  const shipReady = items.filter((item) => item.bucket === "ship_ready");
  const blocked = items.filter((item) => item.bucket === "blocked");
  const needsReply = items.filter((item) => item.needsReply);
  const readyToPack = items.filter((item) => item.readyToPack);

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
    needsReply,
    readyToPack,
    recentFailures: listProductionFailures(12).map(failureSummary),
    summary: {
      nextPrint: nextPrint.length,
      inProduction: inProduction.length,
      shipReady: shipReady.length,
      blocked: blocked.length,
      needsReply: needsReply.length,
      readyToPack: readyToPack.length,
      openOrders: items.length,
    },
  };
}

/** Re-export helper for tests / digest alignment. */
export function plateResinMassG(value: string | null | undefined): number {
  return parseGrams(value);
}
