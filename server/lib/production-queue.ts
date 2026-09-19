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
import { deriveShipAddressReadiness, looksLikePickup, pickupAddressReadiness, addressIsSatisfied } from "../../shared/ship-address";
import { fetchDealAssociatedContact } from "./deal-ops";
import { listFulfillmentChecklists } from "./fulfillment";
import { failureSummary, listProductionFailures } from "./failures";
import { listKitSummaries } from "./kits";
import { getDb, listOrderLinks } from "./order-links";
import { ensureDefaultPrinters, listPrinterProfileMaps, resolvePrinterIdForRecord } from "./printers";
import { contactToShipEngineAddress } from "./shipengine";

/** Map HubSpot deal id → intake shippingRequired (false = pickup). */
export function intakeShippingRequiredByDealId(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const link of listOrderLinks()) {
    const dealIds = new Set<string>();
    if (link.hubspotDealId) dealIds.add(String(link.hubspotDealId));
    try {
      const deals = JSON.parse(link.hubspotDealsJson || "[]") as Array<{ dealId?: string }>;
      for (const deal of deals) {
        if (deal?.dealId) dealIds.add(String(deal.dealId));
      }
    } catch {
      // ignore bad JSON
    }
    for (const dealId of dealIds) {
      // Pickup wins if any linked intake says no shipping.
      if (map.get(dealId) === false) continue;
      map.set(dealId, link.shippingRequired !== false);
    }
  }
  return map;
}

function parseGrams(value: string | null | undefined): number {
  const n = Number(value ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type QueueItemBase = Omit<
  ProductionQueueItem,
  | "priorityScore"
  | "bucket"
  | "readyToPack"
  | "shipBy"
  | "shipBySource"
  | "shipByReason"
  | "addressStatus"
  | "addressSummary"
  | "chaseDraft"
  | "shippingRequired"
>;

/** Ship-by planning always uses the shop's calendar, never the server's timezone. */
export const SHIP_BY_TIME_ZONE = "America/Los_Angeles";
export const SHIP_BY_POST_PROCESS_BUFFER_SECONDS = 24 * 60 * 60;
/** Default calendar-day SLAs used only when no print-duration estimate exists. */
export const SHIP_BY_SLA_DAYS = {
  queued: 10,
  inProduction: 5,
} as const;
/** Queued jobs with a duration estimate still need at least this much calendar lead time. */
export const SHIP_BY_QUEUED_MIN_DAYS = 3;

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

function durationHours(seconds: number): string {
  const hours = Math.round((seconds / 3_600) * 10) / 10;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours}h`;
}

function isPostProcessStage(stage: string | null | undefined): boolean {
  return /\b(post[\s-]?process(?:ing)?|wash(?:ing)?|cur(?:e|ing)|qc|quality control|inspection)\b/i.test(stage ?? "");
}

export function deriveShipBy(
  item: Pick<ProductionQueueItem, "bucket" | "hasPlates" | "shipByOverride" | "createdAt">
    & Partial<Pick<ProductionQueueItem, "stage" | "totalPrintTimeSeconds">>,
  options: { now?: Date; remainingPrintTimeSeconds?: number | null } = {},
): Pick<ProductionQueueItem, "shipBy" | "shipBySource" | "shipByReason"> {
  const override = calendarDate(item.shipByOverride);
  if (override) return { shipBy: override, shipBySource: "override", shipByReason: "HubSpot override" };

  const now = options.now ?? new Date();
  const today = localCalendarDate(now);
  // Finished work may ship today; all other calculations represent an earliest
  // feasible completion time, rounded up to its Los Angeles calendar date.
  if (item.bucket === "ship_ready") {
    return { shipBy: today, shipBySource: "derived", shipByReason: "ready to ship" };
  }
  if (item.hasPlates && isPostProcessStage(item.stage)) {
    return {
      shipBy: localCalendarDate(new Date(now.getTime() + SHIP_BY_POST_PROCESS_BUFFER_SECONDS * 1_000)),
      shipBySource: "derived",
      shipByReason: "post-process + 24h QC",
    };
  }

  const remainingSeconds = options.remainingPrintTimeSeconds ?? item.totalPrintTimeSeconds;
  if (remainingSeconds != null && Number.isFinite(remainingSeconds) && remainingSeconds > 0) {
    const earliest = localCalendarDate(new Date(now.getTime() + (remainingSeconds + SHIP_BY_POST_PROCESS_BUFFER_SECONDS) * 1_000));
    if (item.bucket === "next_print") {
      return {
        shipBy: earliest < addCalendarDays(today, SHIP_BY_QUEUED_MIN_DAYS)
          ? addCalendarDays(today, SHIP_BY_QUEUED_MIN_DAYS)
          : earliest,
        shipBySource: "derived",
        shipByReason: `queued print ${durationHours(remainingSeconds)} + 24h QC (min 3d)`,
      };
    }
    return {
      shipBy: earliest,
      shipBySource: "derived",
      shipByReason: `print ${durationHours(remainingSeconds)} + 24h QC`,
    };
  }

  if (item.bucket === "next_print") {
    return {
      shipBy: addCalendarDays(today, SHIP_BY_SLA_DAYS.queued),
      shipBySource: "derived",
      shipByReason: "queued SLA (no print estimate)",
    };
  }
  return {
    shipBy: addCalendarDays(today, SHIP_BY_SLA_DAYS.inProduction),
    shipBySource: "derived",
    shipByReason: "production SLA (no print estimate)",
  };
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
  const shippingByDeal = intakeShippingRequiredByDealId();
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
      shipPlanNote: deal.shipPlanNote,
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
    const shippingRequired =
      shippingByDeal.has(deal.dealId)
        ? shippingByDeal.get(deal.dealId) !== false
        : !looksLikePickup({
            shipPlanNote: deal.shipPlanNote,
            dealName: deal.dealName,
          });
    const readyToPack =
      bucket === "ship_ready" &&
      (!base.fulfillment.packingDone ||
        (shippingRequired &&
          (!base.fulfillment.labelBought || !base.fulfillment.trackingPasted)));
    const addressDefaults = shippingRequired
      ? deriveShipAddressReadiness({
          dealName: deal.dealName,
          contactNameHint: deal.contactName,
          shippingRequired,
          shipPlanNote: deal.shipPlanNote,
        })
      : pickupAddressReadiness();
    return {
      ...base,
      ...deriveShipBy({ ...base, bucket }),
      bucket,
      readyToPack,
      shippingRequired,
      priorityScore: priorityScore(base),
      // Defaults until attachShipAddressReadiness enriches ship-side rows.
      ...addressDefaults,
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
      needsAddress: items.filter(
        (item) =>
          item.shippingRequired &&
          (item.bucket === "ship_ready" ||
            item.readyToPack ||
            item.bucket === "in_production") &&
          !addressIsSatisfied(item.addressStatus),
      ).length,
      openOrders: items.length,
    },
  };
}

/**
 * Deals Labels shows in the order pick list (and Floor may chip once ship-side).
 * Includes in-production rows — Post-Process / QC often sits there with Ship <80%
 * and previously kept a false default "Needs address" without a HubSpot fetch.
 */
export function queueItemsForShipAddressEnrichment(
  queue: ProductionQueueResponse,
): ProductionQueueItem[] {
  const targets = new Map<string, ProductionQueueItem>();
  for (const item of [...queue.shipReady, ...queue.readyToPack, ...queue.inProduction]) {
    // Pickup orders never need HubSpot ship-to enrichment.
    if (item.shippingRequired === false || item.addressStatus === "pickup") continue;
    targets.set(item.dealId, item);
  }
  return [...targets.values()];
}

/**
 * Fetch HubSpot ship-to for Labels-visible deals and attach
 * addressStatus / addressSummary / chaseDraft. Other rows keep heuristic defaults.
 */
export async function attachShipAddressReadiness(
  queue: ProductionQueueResponse,
): Promise<ProductionQueueResponse> {
  const targetItems = queueItemsForShipAddressEnrichment(queue);
  const targets = new Map(targetItems.map((item) => [item.dealId, item]));
  if (targets.size === 0) return queue;

  const entries = await Promise.all(
    [...targets.keys()].map(async (dealId) => {
      try {
        const contact = await fetchDealAssociatedContact(dealId);
        const engineAddress = contactToShipEngineAddress(contact);
        const item = targets.get(dealId)!;
        const readiness = deriveShipAddressReadiness({
          name: contact.name,
          firstName: contact.name.split(/\s+/)[0] || null,
          street1: contact.street1,
          city: contact.city,
          state: contact.state,
          zip: contact.zip,
          country: contact.country,
          dealName: item.dealName,
          contactNameHint: item.contactName ?? contact.name,
          shippingRequired: item.shippingRequired,
          shipPlanNote: item.shipPlanNote,
        });
        if (readiness.addressStatus === "pickup") {
          return [dealId, readiness] as const;
        }
        // Prefer ShipEngine gate: ready only when label buy would accept the address.
        const addressStatus =
          engineAddress != null
            ? ("ready" as const)
            : readiness.addressStatus === "ready"
              ? ("partial" as const)
              : readiness.addressStatus;
        return [
          dealId,
          {
            addressStatus,
            addressSummary:
              engineAddress != null
                ? `${engineAddress.city}, ${engineAddress.state}`
                : readiness.addressSummary,
            chaseDraft: readiness.chaseDraft,
          },
        ] as const;
      } catch {
        return null;
      }
    }),
  );

  const byDeal = new Map<string, Pick<ProductionQueueItem, "addressStatus" | "addressSummary" | "chaseDraft">>();
  for (const entry of entries) {
    if (entry) byDeal.set(entry[0], entry[1]);
  }

  const patch = (item: ProductionQueueItem): ProductionQueueItem => {
    const next = byDeal.get(item.dealId);
    return next ? { ...item, ...next } : item;
  };

  const nextPrint = queue.nextPrint.map(patch);
  const inProduction = queue.inProduction.map(patch);
  const shipReady = queue.shipReady.map(patch);
  const blocked = queue.blocked.map(patch);
  const needsReply = queue.needsReply.map(patch);
  const readyToPack = queue.readyToPack.map(patch);
  const all = [...nextPrint, ...inProduction, ...shipReady, ...blocked];

  return {
    ...queue,
    nextPrint,
    inProduction,
    shipReady,
    blocked,
    needsReply,
    readyToPack,
    summary: {
      ...queue.summary,
      needsAddress: all.filter(
        (item) =>
          item.shippingRequired !== false &&
          (item.bucket === "ship_ready" ||
            item.readyToPack ||
            item.bucket === "in_production") &&
          !addressIsSatisfied(item.addressStatus),
      ).length,
    },
  };
}

/** Re-export helper for tests / digest alignment. */
export function plateResinMassG(value: string | null | undefined): number {
  return parseGrams(value);
}
