/**
 * Resin inventory: sealed stock, open bottles, and plate consumption.
 *
 * Sealed count lives on resin_products. Opening a bottle decrements sealed
 * stock and creates an open bottle. Attaching a CTB/ULTX plate burns resin
 * mass from the active open bottle when mass is known.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  resinBottleConsumptions,
  resinBottles,
  resinProducts,
  type AdjustResinSealedInput,
  type OpenResinBottleInput,
  type PrintFileMetrics,
  type PrintFileRecord,
  type ResinBottle,
  type ResinBottleEconomics,
  type ResinBottleStatus,
  type ResinInventorySnapshot,
  type ResinProduct,
  type UpsertResinProductInput,
} from "../../shared/schema";
import { round2 } from "./calc";
import { getDb } from "./order-links";
import { ensureDefaultResinProfile } from "./resin-pricing";

const DEFAULT_PRODUCT_NAME = "ELEGOO ABS-Like 3.0 Space Grey";
const DEFAULT_SEED_SEALED = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: string | number | null | undefined): number | null {
  const parsed = asNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** Seed the owner's current ELEGOO ABS 3.0 sealed stock if inventory is empty. */
export function ensureDefaultResinInventory(): ResinProduct[] {
  const db = getDb();
  const existing = db.select().from(resinProducts).all();
  if (existing.length > 0) {
    return db.select().from(resinProducts).orderBy(asc(resinProducts.name)).all();
  }

  const profile = ensureDefaultResinProfile();
  const unitCost = asNumber(profile.bottlePriceUsd) ?? 0;
  const mass = positive(profile.bottleMassG) ?? 1000;
  const now = nowIso();
  db.insert(resinProducts)
    .values({
      name: profile.name?.trim() || DEFAULT_PRODUCT_NAME,
      brand: "ELEGOO",
      bottleMassG: String(mass),
      bottleVolumeMl: profile.bottleVolumeMl,
      unitCostUsd: String(unitCost > 0 ? unitCost : 0),
      sealedCount: DEFAULT_SEED_SEALED,
      notes: "Seeded on-hand sealed stock (8 unopened bottles). Update unit cost if needed.",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return db.select().from(resinProducts).orderBy(asc(resinProducts.name)).all();
}

export function listResinProducts(): ResinProduct[] {
  ensureDefaultResinInventory();
  return getDb().select().from(resinProducts).orderBy(asc(resinProducts.name)).all();
}

export function getResinProduct(productId: number): ResinProduct | null {
  ensureDefaultResinInventory();
  return getDb().select().from(resinProducts).where(eq(resinProducts.id, productId)).get() ?? null;
}

export function upsertResinProduct(input: UpsertResinProductInput): ResinProduct {
  ensureDefaultResinInventory();
  const db = getDb();
  const now = nowIso();
  const name = input.name.trim();
  const existing = db.select().from(resinProducts).all().find(
    (row) => row.name.toLowerCase() === name.toLowerCase(),
  );

  if (existing) {
    return db
      .update(resinProducts)
      .set({
        name,
        brand: input.brand || "ELEGOO",
        bottleMassG: String(input.bottleMassG),
        bottleVolumeMl:
          input.bottleVolumeMl === undefined || input.bottleVolumeMl === null
            ? null
            : String(input.bottleVolumeMl),
        unitCostUsd: String(input.unitCostUsd),
        sealedCount:
          input.sealedCount === undefined ? existing.sealedCount : Math.max(0, input.sealedCount),
        notes: input.notes ?? "",
        updatedAt: now,
      })
      .where(eq(resinProducts.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(resinProducts)
    .values({
      name,
      brand: input.brand || "ELEGOO",
      bottleMassG: String(input.bottleMassG),
      bottleVolumeMl:
        input.bottleVolumeMl === undefined || input.bottleVolumeMl === null
          ? null
          : String(input.bottleVolumeMl),
      unitCostUsd: String(input.unitCostUsd),
      sealedCount: Math.max(0, input.sealedCount ?? 0),
      notes: input.notes ?? "",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function adjustSealedStock(
  productId: number,
  input: AdjustResinSealedInput,
): ResinProduct | null {
  const product = getResinProduct(productId);
  if (!product) return null;
  const next = Math.max(0, product.sealedCount + input.delta);
  const updates: Partial<ResinProduct> = {
    sealedCount: next,
    updatedAt: nowIso(),
  };
  if (input.unitCostUsd !== undefined) updates.unitCostUsd = String(input.unitCostUsd);
  if (input.notes) {
    updates.notes = [product.notes, input.notes].filter(Boolean).join(" · ").slice(0, 2_000);
  }
  return getDb()
    .update(resinProducts)
    .set(updates)
    .where(eq(resinProducts.id, productId))
    .returning()
    .get();
}

function clearActiveBottles(): void {
  getDb()
    .update(resinBottles)
    .set({ isActive: 0, updatedAt: nowIso() })
    .where(eq(resinBottles.isActive, 1))
    .run();
}

export function openResinBottle(input: OpenResinBottleInput): {
  product: ResinProduct;
  bottle: ResinBottle;
} | null {
  const product = getResinProduct(input.productId);
  if (!product) return null;
  if (product.sealedCount < 1) {
    throw new Error("No sealed bottles left for this resin. Add sealed stock first.");
  }

  const mass = positive(product.bottleMassG) ?? 1000;
  const unitCost = asNumber(product.unitCostUsd) ?? 0;
  const now = nowIso();

  const updatedProduct = getDb()
    .update(resinProducts)
    .set({ sealedCount: product.sealedCount - 1, updatedAt: now })
    .where(eq(resinProducts.id, product.id))
    .returning()
    .get();

  if (input.makeActive !== false) clearActiveBottles();

  const bottle = getDb()
    .insert(resinBottles)
    .values({
      productId: product.id,
      status: "open",
      isActive: input.makeActive === false ? 0 : 1,
      openedAt: now,
      initialMassG: String(mass),
      remainingMassG: String(mass),
      unitCostUsd: String(unitCost),
      notes: input.notes ?? "",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  return { product: updatedProduct, bottle };
}

export function setActiveResinBottle(bottleId: number): ResinBottle | null {
  ensureDefaultResinInventory();
  const bottle = getDb().select().from(resinBottles).where(eq(resinBottles.id, bottleId)).get();
  if (!bottle) return null;
  if (bottle.status !== "open") {
    throw new Error("Only an open bottle can be set as the active pour bottle");
  }
  clearActiveBottles();
  return getDb()
    .update(resinBottles)
    .set({ isActive: 1, updatedAt: nowIso() })
    .where(eq(resinBottles.id, bottleId))
    .returning()
    .get();
}

export function getActiveResinBottle(): ResinBottle | null {
  ensureDefaultResinInventory();
  return (
    getDb()
      .select()
      .from(resinBottles)
      .where(and(eq(resinBottles.isActive, 1), eq(resinBottles.status, "open")))
      .get() ?? null
  );
}

/**
 * Burn resin from the active open bottle when a plate is attached.
 * No-ops (returns null) when there is no active bottle or no usable mass.
 */
export function consumeResinForAttachedPlate(input: {
  record: PrintFileRecord;
  metrics: PrintFileMetrics;
  dealAmount?: string | number | null;
}): {
  bottle: ResinBottle;
  consumedMassG: number;
  remainingMassG: number;
} | null {
  const bottle = getActiveResinBottle();
  if (!bottle) return null;

  const mass =
    positive(input.metrics.resinMassG) ??
    (positive(input.metrics.resinVolumeMl) != null
      ? round2((positive(input.metrics.resinVolumeMl) as number) * 1.1)
      : null);
  if (mass == null) return null;

  const remaining = Math.max(0, (asNumber(bottle.remainingMassG) ?? 0) - mass);
  const unitCost = asNumber(bottle.unitCostUsd) ?? 0;
  const initial = positive(bottle.initialMassG) ?? mass;
  const costPerGram = initial > 0 && unitCost > 0 ? unitCost / initial : 0;
  const resinCostUsd = costPerGram > 0 ? round2(mass * costPerGram) : null;
  const now = nowIso();
  const empty = remaining <= 0.05;

  const updated = getDb()
    .update(resinBottles)
    .set({
      remainingMassG: String(round2(remaining)),
      status: empty ? "empty" : "open",
      isActive: empty ? 0 : bottle.isActive,
      updatedAt: now,
    })
    .where(eq(resinBottles.id, bottle.id))
    .returning()
    .get();

  getDb()
    .insert(resinBottleConsumptions)
    .values({
      bottleId: bottle.id,
      printFileRecordId: input.record.id,
      hubspotDealId: input.record.hubspotDealId,
      hubspotDealName: input.record.hubspotDealName,
      dealAmount: input.dealAmount == null ? "" : String(input.dealAmount),
      resinMassG: String(mass),
      resinVolumeMl:
        input.metrics.resinVolumeMl == null ? null : String(input.metrics.resinVolumeMl),
      resinCostUsd: resinCostUsd == null ? null : String(resinCostUsd),
      createdAt: now,
    })
    .run();

  return {
    bottle: updated,
    consumedMassG: mass,
    remainingMassG: round2(remaining),
  };
}

function bottleEconomics(
  bottle: ResinBottle,
  product: ResinProduct,
): ResinBottleEconomics {
  const initial = asNumber(bottle.initialMassG) ?? 0;
  const remaining = Math.max(0, asNumber(bottle.remainingMassG) ?? 0);
  const used = Math.max(0, round2(initial - remaining));
  const unitCost = asNumber(bottle.unitCostUsd) ?? 0;
  const costPerGram = initial > 0 && unitCost > 0 ? unitCost / initial : 0;
  const consumptions = getDb()
    .select()
    .from(resinBottleConsumptions)
    .where(eq(resinBottleConsumptions.bottleId, bottle.id))
    .orderBy(desc(resinBottleConsumptions.createdAt), desc(resinBottleConsumptions.id))
    .all();

  const dealAmounts = new Map<string, number>();
  for (const row of consumptions) {
    const amount = positive(row.dealAmount);
    if (!row.hubspotDealId || amount == null) continue;
    // One deal amount per deal id (do not multiply by plate count).
    if (!dealAmounts.has(row.hubspotDealId)) dealAmounts.set(row.hubspotDealId, amount);
  }
  const attributedDealRevenueUsd = round2(
    Array.from(dealAmounts.values()).reduce((sum, value) => sum + value, 0),
  );
  const materialCostUsedUsd = round2(used * costPerGram);

  return {
    bottleId: bottle.id,
    productId: product.id,
    productName: product.name,
    brand: product.brand,
    status: (bottle.status === "empty" || bottle.status === "archived"
      ? bottle.status
      : "open") as ResinBottleStatus,
    isActive: bottle.isActive === 1,
    openedAt: bottle.openedAt,
    initialMassG: initial,
    remainingMassG: remaining,
    usedMassG: used,
    usedPercent: initial > 0 ? round2((used / initial) * 100) : 0,
    unitCostUsd: unitCost,
    costPerGram: round2(costPerGram * 1000) / 1000,
    materialCostUsedUsd,
    plateCount: consumptions.length,
    distinctOrders: dealAmounts.size,
    attributedDealRevenueUsd,
    roughContributionUsd: round2(attributedDealRevenueUsd - unitCost),
    notes: bottle.notes,
    recentConsumptions: consumptions.slice(0, 12).map((row) => ({
      id: row.id,
      dealId: row.hubspotDealId,
      dealName: row.hubspotDealName,
      resinMassG: asNumber(row.resinMassG) ?? 0,
      dealAmount: positive(row.dealAmount),
      createdAt: row.createdAt,
    })),
  };
}

export function buildResinInventorySnapshot(): ResinInventorySnapshot {
  const products = listResinProducts();
  const bottles = getDb()
    .select()
    .from(resinBottles)
    .orderBy(desc(resinBottles.isActive), desc(resinBottles.openedAt), desc(resinBottles.id))
    .all();
  const productById = new Map(products.map((product) => [product.id, product]));

  const bottleViews = bottles
    .map((bottle) => {
      const product = productById.get(bottle.productId);
      return product ? bottleEconomics(bottle, product) : null;
    })
    .filter((row): row is ResinBottleEconomics => row != null);

  const openCounts = new Map<number, number>();
  for (const bottle of bottleViews) {
    if (bottle.status !== "open") continue;
    openCounts.set(bottle.productId, (openCounts.get(bottle.productId) ?? 0) + 1);
  }

  const productViews = products.map((product) => {
    const bottleMassG = asNumber(product.bottleMassG) ?? 1000;
    const unitCostUsd = asNumber(product.unitCostUsd) ?? 0;
    return {
      id: product.id,
      name: product.name,
      brand: product.brand,
      bottleMassG,
      bottleVolumeMl: asNumber(product.bottleVolumeMl),
      unitCostUsd,
      sealedCount: product.sealedCount,
      sealedValueUsd: round2(product.sealedCount * unitCostUsd),
      openBottleCount: openCounts.get(product.id) ?? 0,
      notes: product.notes,
    };
  });

  const activeBottle = bottleViews.find((bottle) => bottle.isActive) ?? null;
  const sealedBottles = productViews.reduce((sum, product) => sum + product.sealedCount, 0);
  const sealedValueUsd = round2(
    productViews.reduce((sum, product) => sum + product.sealedValueUsd, 0),
  );

  return {
    products: productViews,
    bottles: bottleViews,
    activeBottle,
    totals: {
      sealedBottles,
      sealedValueUsd,
      openBottles: bottleViews.filter((bottle) => bottle.status === "open").length,
      resinUsedGrams: round2(bottleViews.reduce((sum, bottle) => sum + bottle.usedMassG, 0)),
      materialCostUsedUsd: round2(
        bottleViews.reduce((sum, bottle) => sum + bottle.materialCostUsedUsd, 0),
      ),
      attributedDealRevenueUsd: round2(
        bottleViews.reduce((sum, bottle) => sum + bottle.attributedDealRevenueUsd, 0),
      ),
    },
  };
}
