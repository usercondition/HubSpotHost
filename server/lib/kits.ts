/**
 * Durable kit inventory per HubSpot Print Order.
 * Stores the full kit document (bits + plates + QC) as JSON.
 */
import { desc, eq } from "drizzle-orm";
import { kits, kitTrackerSchema, type KitTrackerDocument } from "../../shared/schema";
import { getDb } from "./order-links";

function nowIso(): string {
  return new Date().toISOString();
}

export type KitSummary = {
  hubspotDealId: string;
  hubspotDealName: string;
  name: string;
  totalBits: number;
  good: number;
  needed: number;
  onPlate: number;
  reprint: number;
  plateCount: number;
  updatedAt: string;
};

function summarizeKit(dealId: string, dealName: string, name: string, kit: KitTrackerDocument, updatedAt: string): KitSummary {
  return {
    hubspotDealId: dealId,
    hubspotDealName: dealName,
    name,
    totalBits: kit.bits.length,
    good: kit.bits.filter((bit) => bit.status === "good").length,
    needed: kit.bits.filter((bit) => bit.status === "needed").length,
    onPlate: kit.bits.filter((bit) => bit.status === "on_plate").length,
    reprint: kit.bits.filter((bit) => bit.status === "reprint").length,
    plateCount: kit.plates.length,
    updatedAt,
  };
}

function parseKitJson(raw: string): KitTrackerDocument | null {
  try {
    const parsed = kitTrackerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function getKitForDeal(dealId: string): {
  ok: true;
  kit: KitTrackerDocument | null;
  summary: KitSummary | null;
} {
  const id = dealId.trim();
  if (!id) return { ok: true, kit: null, summary: null };
  const row = getDb().select().from(kits).where(eq(kits.hubspotDealId, id)).get();
  if (!row) return { ok: true, kit: null, summary: null };
  const kit = parseKitJson(row.kitJson);
  if (!kit) return { ok: true, kit: null, summary: null };
  return {
    ok: true,
    kit: {
      ...kit,
      hubspotDealId: id,
      hubspotDealName: row.hubspotDealName || kit.hubspotDealName || null,
    },
    summary: summarizeKit(id, row.hubspotDealName, row.name, kit, row.updatedAt),
  };
}

export function upsertKitForDeal(
  dealId: string,
  input: { kit: KitTrackerDocument; dealName?: string },
): { ok: true; kit: KitTrackerDocument; summary: KitSummary } | { ok: false; error: string } {
  const id = dealId.trim();
  if (!/^[0-9]{1,20}$/.test(id)) return { ok: false, error: "Select a valid Print Order." };

  const parsed = kitTrackerSchema.safeParse({
    ...input.kit,
    hubspotDealId: id,
    hubspotDealName: input.dealName?.trim() || input.kit.hubspotDealName || input.kit.name,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Kit data is invalid." };
  }

  const kit: KitTrackerDocument = {
    ...parsed.data,
    hubspotDealId: id,
    updatedAt: nowIso(),
  };
  const dealName = (kit.hubspotDealName || kit.name || `Print Order ${id}`).trim();
  const name = kit.name.trim() || dealName;
  const existing = getDb().select().from(kits).where(eq(kits.hubspotDealId, id)).get();
  const createdAt = existing?.createdAt || nowIso();
  const updatedAt = kit.updatedAt || nowIso();

  getDb()
    .insert(kits)
    .values({
      hubspotDealId: id,
      hubspotDealName: dealName,
      name,
      kitJson: JSON.stringify(kit),
      createdAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: kits.hubspotDealId,
      set: {
        hubspotDealName: dealName,
        name,
        kitJson: JSON.stringify(kit),
        updatedAt,
      },
    })
    .run();

  return { ok: true, kit, summary: summarizeKit(id, dealName, name, kit, updatedAt) };
}

export function listKitSummaries(limit = 100): KitSummary[] {
  const rows = getDb()
    .select()
    .from(kits)
    .orderBy(desc(kits.updatedAt))
    .limit(Math.max(1, Math.min(limit, 300)))
    .all();
  const out: KitSummary[] = [];
  for (const row of rows) {
    const kit = parseKitJson(row.kitJson);
    if (!kit) continue;
    out.push(summarizeKit(row.hubspotDealId, row.hubspotDealName, row.name, kit, row.updatedAt));
  }
  return out;
}

export function deleteKitForDeal(dealId: string): boolean {
  const result = getDb().delete(kits).where(eq(kits.hubspotDealId, dealId.trim())).run();
  return Number(result.changes ?? 0) > 0;
}
