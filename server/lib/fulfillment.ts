/**
 * Ship-ready checklist per Print Order. Complements HubSpot stages —
 * Pirate Ship / packing steps live here so the queue can score readiness.
 */
import { eq } from "drizzle-orm";
import {
  FULFILLMENT_CHECKLIST_KEYS,
  fulfillmentChecklists,
  type FulfillmentChecklistView,
  type UpdateFulfillmentChecklistInput,
} from "../../shared/schema";
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

export function upsertFulfillmentChecklist(
  dealId: string,
  input: UpdateFulfillmentChecklistInput,
): FulfillmentChecklistView | { error: string } {
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

  return toChecklistView(id, { ...next, updatedAt: now });
}
