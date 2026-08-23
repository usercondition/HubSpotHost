/**
 * Ship-ready checklist per Print Order. Complements HubSpot stages —
 * Pirate Ship / packing steps live here so the queue can score readiness.
 * Tracking + ship notes also sync onto HubSpot deal properties when writes are open.
 */
import { eq } from "drizzle-orm";
import {
  FULFILLMENT_CHECKLIST_KEYS,
  fulfillmentChecklists,
  type FulfillmentChecklistView,
  type UpdateFulfillmentChecklistInput,
} from "../../shared/schema";
import { getConfig, resolveWriteDecision } from "./config";
import { ensurePrintFileDealProperties, hubspotRequest, HubSpotError } from "./hubspot";
import { getDb } from "./order-links";

function nowIso(): string {
  return new Date().toISOString();
}

function emptyChecklist(dealId: string): FulfillmentChecklistView {
  return {
    dealId,
    addressVerified: false,
    costsEntered: false,
    labelBought: false,
    trackingPasted: false,
    packingDone: false,
    trackingNumber: "",
    notes: "",
    completedCount: 0,
    totalCount: FULFILLMENT_CHECKLIST_KEYS.length,
    readyPercent: 0,
    shipReady: false,
    updatedAt: null,
  };
}

export function toChecklistView(
  dealId: string,
  row: {
    addressVerified: boolean;
    costsEntered: boolean;
    labelBought: boolean;
    trackingPasted: boolean;
    packingDone: boolean;
    trackingNumber: string;
    notes: string;
    updatedAt: string;
  } | null,
): FulfillmentChecklistView {
  if (!row) return emptyChecklist(dealId);
  const flags = [
    row.addressVerified,
    row.costsEntered,
    row.labelBought,
    row.trackingPasted,
    row.packingDone,
  ];
  const completedCount = flags.filter(Boolean).length;
  const totalCount = flags.length;
  return {
    dealId,
    addressVerified: row.addressVerified,
    costsEntered: row.costsEntered,
    labelBought: row.labelBought,
    trackingPasted: row.trackingPasted,
    packingDone: row.packingDone,
    trackingNumber: row.trackingNumber,
    notes: row.notes,
    completedCount,
    totalCount,
    readyPercent: Math.round((completedCount / totalCount) * 100),
    shipReady: completedCount === totalCount,
    updatedAt: row.updatedAt,
  };
}

export function getFulfillmentChecklist(dealId: string): FulfillmentChecklistView {
  const id = dealId.trim();
  if (!id) return emptyChecklist("");
  const row = getDb().select().from(fulfillmentChecklists).where(eq(fulfillmentChecklists.hubspotDealId, id)).get();
  return toChecklistView(id, row ?? null);
}

/** Normalize carrier tracking for duplicate checks (case / spaces / dashes). */
export function normalizeTrackingNumber(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

export type ExistingTrackingAttachment = {
  dealId: string;
  trackingNumber: string;
  notes: string;
  updatedAt: string | null;
  source: "local" | "hubspot";
};

/** Find a Print Order that already has this tracking in the local checklist. */
export function findLocalTrackingAttachment(
  trackingNumber: string | null | undefined,
): ExistingTrackingAttachment | null {
  const needle = normalizeTrackingNumber(trackingNumber);
  if (needle.length < 6) return null;

  const rows = getDb().select().from(fulfillmentChecklists).all();
  for (const row of rows) {
    const stored = normalizeTrackingNumber(row.trackingNumber);
    if (!stored || stored !== needle) continue;
    return {
      dealId: row.hubspotDealId,
      trackingNumber: row.trackingNumber.trim(),
      notes: row.notes ?? "",
      updatedAt: row.updatedAt ?? null,
      source: "local",
    };
  }
  return null;
}

/**
 * Find tracking already stored on a HubSpot deal property (when present in the
 * fetched deal payload).
 */
export function findHubSpotTrackingAttachment(
  trackingNumber: string | null | undefined,
  deals: Array<{ id: string; properties: Record<string, string | null> }>,
): ExistingTrackingAttachment | null {
  const needle = normalizeTrackingNumber(trackingNumber);
  if (needle.length < 6) return null;

  for (const deal of deals) {
    const stored = normalizeTrackingNumber(deal.properties.print_tracking_number);
    if (!stored || stored !== needle) continue;
    return {
      dealId: deal.id,
      trackingNumber: String(deal.properties.print_tracking_number ?? "").trim(),
      notes: String(deal.properties.print_ship_notes ?? "").trim(),
      updatedAt: null,
      source: "hubspot",
    };
  }
  return null;
}

export function findExistingTrackingAttachment(
  trackingNumber: string | null | undefined,
  deals?: Array<{ id: string; properties: Record<string, string | null> }>,
): ExistingTrackingAttachment | null {
  return findLocalTrackingAttachment(trackingNumber) ?? findHubSpotTrackingAttachment(trackingNumber, deals ?? []);
}

export function listFulfillmentChecklists(dealIds: string[]): Map<string, FulfillmentChecklistView> {
  const map = new Map<string, FulfillmentChecklistView>();
  const ids = Array.from(new Set(dealIds.map((id) => id.trim()).filter(Boolean)));
  for (const id of ids) map.set(id, emptyChecklist(id));
  if (ids.length === 0) return map;

  const rows = getDb().select().from(fulfillmentChecklists).all();
  for (const row of rows) {
    if (!map.has(row.hubspotDealId)) continue;
    map.set(row.hubspotDealId, toChecklistView(row.hubspotDealId, row));
  }
  return map;
}

export type HubSpotShippingSync = {
  attempted: boolean;
  dryRun: boolean;
  gate: string;
  wrote: boolean;
};

/**
 * PATCH print_tracking_number / print_ship_notes onto the deal when write gates allow.
 */
export async function syncDealShippingToHubSpot(
  dealId: string,
  fields: { trackingNumber: string; notes: string },
  liveWrite = true,
): Promise<HubSpotShippingSync> {
  const config = getConfig();
  const decision = resolveWriteDecision(config, liveWrite);
  const properties: Record<string, string> = {
    print_tracking_number: fields.trackingNumber.slice(0, 120),
    print_ship_notes: fields.notes.slice(0, 2_000),
  };

  if (!decision.write) {
    return { attempted: true, dryRun: true, gate: decision.reason, wrote: false };
  }

  await ensurePrintFileDealProperties();
  await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return { attempted: true, dryRun: false, gate: decision.reason, wrote: true };
}

export async function upsertFulfillmentChecklist(
  dealId: string,
  input: UpdateFulfillmentChecklistInput,
): Promise<
  | { checklist: FulfillmentChecklistView; hubspot: HubSpotShippingSync | null }
  | { error: string }
> {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { error: "Select a valid Print Order." };

  const existing = getDb().select().from(fulfillmentChecklists).where(eq(fulfillmentChecklists.hubspotDealId, id)).get();
  const now = nowIso();
  const next = {
    addressVerified: input.addressVerified ?? existing?.addressVerified ?? false,
    costsEntered: input.costsEntered ?? existing?.costsEntered ?? false,
    labelBought: input.labelBought ?? existing?.labelBought ?? false,
    trackingPasted: input.trackingPasted ?? existing?.trackingPasted ?? false,
    packingDone: input.packingDone ?? existing?.packingDone ?? false,
    trackingNumber: input.trackingNumber ?? existing?.trackingNumber ?? "",
    notes: input.notes ?? existing?.notes ?? "",
  };

  // Saving a tracking number implies the checklist flag.
  if (input.trackingNumber !== undefined && next.trackingNumber.trim().length > 0) {
    next.trackingPasted = true;
  }

  getDb()
    .insert(fulfillmentChecklists)
    .values({
      hubspotDealId: id,
      ...next,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: fulfillmentChecklists.hubspotDealId,
      set: { ...next, updatedAt: now },
    })
    .run();

  const checklist = toChecklistView(id, { ...next, updatedAt: now });

  const shouldSyncHubSpot =
    input.trackingNumber !== undefined || input.notes !== undefined;
  if (!shouldSyncHubSpot) {
    return { checklist, hubspot: null };
  }

  try {
    const hubspot = await syncDealShippingToHubSpot(
      id,
      { trackingNumber: next.trackingNumber, notes: next.notes },
      input.liveWrite !== false,
    );
    return { checklist, hubspot };
  } catch (error) {
    // Local checklist already saved — surface CRM sync failure without rolling back shop-floor state.
    const message =
      error instanceof HubSpotError ? error.message : "Could not sync tracking to HubSpot.";
    return {
      checklist,
      hubspot: { attempted: true, dryRun: false, gate: message, wrote: false },
    };
  }
}
