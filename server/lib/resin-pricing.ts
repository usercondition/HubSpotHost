/**
 * Active resin pricing for Print Operations plate estimates.
 *
 * Priority when a slice plate has no embedded resin cost:
 * 1. Active resin profile bottle price (Amazon refresh or manual)
 * 2. Open inventory bottle unit cost ($/g) — same economics attach consumes
 * 3. Recent Supplies "materials" purchases that look like resin
 *
 * Estimates never overwrite HubSpot `print_material_cost`. Amazon live price
 * is best-effort HTML parsing and can fail when Amazon blocks or redesigns.
 * Attach consumption still burns the open inventory bottle independently.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  lineItemsForSupplyPurchase,
  resinBottles,
  resinProducts,
  resinProfiles,
  type PrintFileMetrics,
  type ResinCostSource,
  type ResinProfile,
  type UpsertResinProfileInput,
} from "../../shared/schema";
import { round2 } from "./calc";
import { getDb } from "./order-links";
import { listSupplyPurchases } from "./supplies";

export const DEFAULT_RESIN_NAME = "ELEGOO ABS-Like 3.0 Space Grey";
export const DEFAULT_RESIN_ASIN = "B0D6Y6JV42";
export const DEFAULT_RESIN_URL = `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`;
export const DEFAULT_BOTTLE_MASS_G = 1000;
export const DEFAULT_RESIN_DENSITY_G_PER_ML = 1.1;
export const AMAZON_FETCH_TIMEOUT_MS = 10_000;
export const AMAZON_PRICE_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * Keep the Inventory bottle cost in sync when Print Files updates the active
 * profile, so the next estimate uses the same economics in both places.
 */
function mirrorBottlePriceToInventory(profileName: string, bottlePriceUsd: number): void {
  const db = getDb();
  const products = db.select().from(resinProducts).all();
  if (products.length === 0) return;

  const normalized = profileName.trim().toLowerCase();
  const target =
    products.find((product) => product.name.trim().toLowerCase() === normalized) ?? products[0]!;
  db.update(resinProducts)
    .set({ unitCostUsd: bottlePriceUsd.toFixed(2), updatedAt: nowIso() })
    .where(eq(resinProducts.id, target.id))
    .run();
}

function nowIso(): string {
  return new Date().toISOString();
}

function money(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function positive(value: string | number | null | undefined): number | null {
  const parsed = money(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function amazonUrlForAsin(asin: string, fallback = ""): string {
  const clean = asin.trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(clean)) return `https://www.amazon.com/dp/${clean}`;
  return fallback.trim();
}

export function ensureDefaultResinProfile(): ResinProfile {
  const existing = getDb()
    .select()
    .from(resinProfiles)
    .where(eq(resinProfiles.isActive, 1))
    .orderBy(desc(resinProfiles.id))
    .get();
  if (existing) return existing;

  const stamp = nowIso();
  return getDb()
    .insert(resinProfiles)
    .values({
      name: DEFAULT_RESIN_NAME,
      amazonAsin: DEFAULT_RESIN_ASIN,
      amazonUrl: DEFAULT_RESIN_URL,
      bottleMassG: String(DEFAULT_BOTTLE_MASS_G),
      bottleVolumeMl: null,
      bottlePriceUsd: "0",
      priceSource: "manual",
      priceFetchedAt: null,
      notes: "Default resin used for plate cost estimates when a CTB has no slicer price.",
      isActive: 1,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
}

export function getActiveResinProfile(): ResinProfile {
  return ensureDefaultResinProfile();
}

export function upsertActiveResinProfile(input: UpsertResinProfileInput): ResinProfile {
  const active = ensureDefaultResinProfile();
  const asin = input.amazonAsin.trim().toUpperCase();
  const price = money(input.bottlePriceUsd);
  if (price === null) throw new Error("Enter a bottle price greater than or equal to zero");

  const volume =
    input.bottleVolumeMl === null || input.bottleVolumeMl === undefined
      ? null
      : positive(input.bottleVolumeMl);

  const updated = getDb()
    .update(resinProfiles)
    .set({
      name: input.name.trim(),
      amazonAsin: asin,
      amazonUrl: input.amazonUrl.trim() || amazonUrlForAsin(asin, active.amazonUrl),
      bottleMassG: String(input.bottleMassG),
      bottleVolumeMl: volume === null ? null : String(volume),
      bottlePriceUsd: price.toFixed(2),
      priceSource: "manual",
      notes: input.notes ?? "",
      updatedAt: nowIso(),
    })
    .where(eq(resinProfiles.id, active.id))
    .returning()
    .get();
  mirrorBottlePriceToInventory(updated.name, price);
  return updated;
}

export function parseAmazonProductPrice(html: string): number | null {
  const priceToPay = html.match(/"priceToPay"\s*:\s*\{[^}]*"amount"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (priceToPay) {
    const amount = Number(priceToPay[1]);
    if (Number.isFinite(amount) && amount > 0 && amount < 10_000) return round2(amount);
  }

  const display = html.match(/"displayPrice"\s*:\s*"\$?([0-9]+(?:\.[0-9]+)?)"/i);
  if (display) {
    const amount = Number(display[1]);
    if (Number.isFinite(amount) && amount > 0 && amount < 10_000) return round2(amount);
  }

  const coreIdx = html.search(/corePriceDisplay_desktop|corePrice_feature_div|priceToPay/i);
  if (coreIdx >= 0) {
    const window = html.slice(coreIdx, coreIdx + 2_500);
    const offscreen = window.match(/a-offscreen[^>]*>\s*\$([0-9]+(?:\.[0-9]+)?)/i);
    if (offscreen) {
      const amount = Number(offscreen[1]);
      if (Number.isFinite(amount) && amount > 0 && amount < 10_000) return round2(amount);
    }
  }

  return null;
}

export async function refreshResinPriceFromAmazon(
  fetchImpl: typeof fetch = fetch,
): Promise<{ profile: ResinProfile; price: number; cached: boolean }> {
  const profile = ensureDefaultResinProfile();
  const asin = profile.amazonAsin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new Error("Set a valid Amazon ASIN on the resin profile before refreshing");
  }

  const fetchedAt = profile.priceFetchedAt ? Date.parse(profile.priceFetchedAt) : NaN;
  const currentPrice = positive(profile.bottlePriceUsd);
  if (
    Number.isFinite(fetchedAt) &&
    Date.now() - fetchedAt < AMAZON_PRICE_CACHE_MS &&
    currentPrice !== null &&
    profile.priceSource === "amazon"
  ) {
    return { profile, price: currentPrice, cached: true };
  }

  const url = profile.amazonUrl.trim() || amazonUrlForAsin(asin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AMAZON_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; PrintOperations/1.0; +https://github.com/usercondition/HubSpotHost)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) {
      throw new Error(`Amazon returned HTTP ${response.status}`);
    }
    const html = await response.text();
    if (/enter the characters you see|robot check|api-services-support@amazon\.com/i.test(html)) {
      throw new Error("Amazon blocked the live price request. Enter the bottle price manually for now.");
    }
    const price = parseAmazonProductPrice(html);
    if (price === null) {
      throw new Error("Could not find a buy-box price on the Amazon page. Enter it manually.");
    }

    const updated = getDb()
      .update(resinProfiles)
      .set({
        bottlePriceUsd: price.toFixed(2),
        priceSource: "amazon",
        priceFetchedAt: nowIso(),
        amazonUrl: url,
        updatedAt: nowIso(),
      })
      .where(eq(resinProfiles.id, profile.id))
      .returning()
      .get();
    mirrorBottlePriceToInventory(updated.name, price);

    return { profile: updated, price, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResinRate {
  source: Exclude<ResinCostSource, "ctb">;
  bottlePriceUsd: number;
  bottleMassG: number;
  bottleVolumeMl: number | null;
  label: string;
  usdPerGram: number | null;
  usdPerMl: number | null;
}

function rateFromProfile(profile: ResinProfile): ResinRate | null {
  const bottlePriceUsd = positive(profile.bottlePriceUsd);
  const bottleMassG = positive(profile.bottleMassG) ?? DEFAULT_BOTTLE_MASS_G;
  const bottleVolumeMl = positive(profile.bottleVolumeMl);
  if (bottlePriceUsd === null) return null;

  const source: Exclude<ResinCostSource, "ctb"> =
    profile.priceSource === "amazon" ? "amazon" : "manual";
  const usdPerGram = bottleMassG > 0 ? bottlePriceUsd / bottleMassG : null;
  const volume =
    bottleVolumeMl ??
    (bottleMassG > 0 ? bottleMassG / DEFAULT_RESIN_DENSITY_G_PER_ML : null);
  const usdPerMl = volume && volume > 0 ? bottlePriceUsd / volume : null;

  return {
    source,
    bottlePriceUsd,
    bottleMassG,
    bottleVolumeMl: volume,
    label: `${profile.name} · $${bottlePriceUsd.toFixed(2)} / ${bottleMassG} g (${source})`,
    usdPerGram,
    usdPerMl,
  };
}

function parseSupplyBottleMassG(itemName: string): number | null {
  const normalized = itemName.toLowerCase();
  const kg = normalized.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  if (kg) return Number(kg[1]) * 1000;
  const gram = normalized.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (gram) return Number(gram[1]);
  const ml = normalized.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (ml) return Number(ml[1]) * DEFAULT_RESIN_DENSITY_G_PER_ML;
  return null;
}

export function resinRateFromSupplies(): ResinRate | null {
  const resinLines: Array<{
    itemName: string;
    quantity: number;
    lineAmount: string;
    purchaseTotal: string;
    soleResinLine: boolean;
  }> = [];

  for (const purchase of listSupplyPurchases(200)) {
    const allLines = lineItemsForSupplyPurchase(purchase);
    const lines = allLines.filter((line) => {
      const name = line.itemName.toLowerCase();
      return (line.category === "materials" || purchase.category === "materials") && name.includes("resin");
    });
    if (lines.length === 0) continue;
    for (const line of lines) {
      resinLines.push({
        itemName: line.itemName,
        quantity: line.quantity,
        lineAmount: line.lineAmount,
        purchaseTotal: purchase.totalAmount,
        soleResinLine: allLines.length === 1,
      });
    }
  }
  if (!resinLines.length) return null;

  let totalPrice = 0;
  let totalMass = 0;
  let samples = 0;
  for (const line of resinLines.slice(0, 12)) {
    const price = positive(line.lineAmount) ?? (line.soleResinLine ? positive(line.purchaseTotal) : null);
    const mass = parseSupplyBottleMassG(line.itemName);
    const qty = Math.max(1, line.quantity || 1);
    if (price === null || mass === null || mass <= 0) continue;
    totalPrice += price;
    totalMass += mass * qty;
    samples += 1;
  }
  if (!samples || totalMass <= 0 || totalPrice <= 0) return null;

  const usdPerGram = totalPrice / totalMass;
  const bottleMassG = DEFAULT_BOTTLE_MASS_G;
  const bottlePriceUsd = round2(usdPerGram * bottleMassG);
  const bottleVolumeMl = bottleMassG / DEFAULT_RESIN_DENSITY_G_PER_ML;

  return {
    source: "supplies",
    bottlePriceUsd,
    bottleMassG,
    bottleVolumeMl,
    label: `Supplies resin average · $${bottlePriceUsd.toFixed(2)} / ${bottleMassG} g`,
    usdPerGram,
    usdPerMl: bottlePriceUsd / bottleVolumeMl,
  };
}

/**
 * $/g from the open inventory bottle (same unit cost attach burns).
 * Queried here to avoid a circular import with resin-inventory.
 */
export function resinRateFromActiveBottle(): ResinRate | null {
  const bottle = getDb()
    .select()
    .from(resinBottles)
    .where(and(eq(resinBottles.isActive, 1), eq(resinBottles.status, "open")))
    .get();
  if (!bottle) return null;
  const unitCost = positive(bottle.unitCostUsd);
  const initialMass = positive(bottle.initialMassG);
  if (unitCost === null || initialMass === null || initialMass <= 0) return null;
  const usdPerGram = unitCost / initialMass;
  if (!(usdPerGram > 0)) return null;
  const bottleMassG = initialMass;
  const bottleVolumeMl = bottleMassG / DEFAULT_RESIN_DENSITY_G_PER_ML;
  return {
    source: "inventory",
    bottlePriceUsd: unitCost,
    bottleMassG,
    bottleVolumeMl,
    label: `Open inventory bottle · $${unitCost.toFixed(2)} / ${bottleMassG} g`,
    usdPerGram,
    usdPerMl: unitCost / bottleVolumeMl,
  };
}

export function resolveResinRate(): ResinRate | null {
  const fromProfile = rateFromProfile(ensureDefaultResinProfile());
  if (fromProfile && fromProfile.bottlePriceUsd > 0) return fromProfile;
  const fromInventory = resinRateFromActiveBottle();
  if (fromInventory) return fromInventory;
  return resinRateFromSupplies();
}

export function estimatePlateResinCost(
  metrics: Pick<PrintFileMetrics, "resinCost" | "resinMassG" | "resinVolumeMl" | "resinDensityGPerMl">,
  rate: ResinRate | null = resolveResinRate(),
): {
  resinCost: number | null;
  resinCostSource: ResinCostSource | null;
  resinCostLabel: string | null;
} {
  if (metrics.resinCost !== null && metrics.resinCost > 0) {
    return {
      resinCost: metrics.resinCost,
      resinCostSource: "ctb",
      resinCostLabel: "Chitubox resin price setting",
    };
  }

  if (!rate) {
    return { resinCost: null, resinCostSource: null, resinCostLabel: null };
  }

  if (metrics.resinMassG !== null && metrics.resinMassG > 0 && rate.usdPerGram) {
    return {
      resinCost: round2(metrics.resinMassG * rate.usdPerGram),
      resinCostSource: rate.source,
      resinCostLabel: rate.label,
    };
  }

  if (metrics.resinVolumeMl !== null && metrics.resinVolumeMl > 0 && rate.usdPerMl) {
    return {
      resinCost: round2(metrics.resinVolumeMl * rate.usdPerMl),
      resinCostSource: rate.source,
      resinCostLabel: rate.label,
    };
  }

  // Volume present but only $/g known — convert with density.
  const density = metrics.resinDensityGPerMl ?? DEFAULT_RESIN_DENSITY_G_PER_ML;
  if (metrics.resinVolumeMl !== null && metrics.resinVolumeMl > 0 && rate.usdPerGram) {
    return {
      resinCost: round2(metrics.resinVolumeMl * density * rate.usdPerGram),
      resinCostSource: rate.source,
      resinCostLabel: rate.label,
    };
  }

  return { resinCost: null, resinCostSource: null, resinCostLabel: null };
}

export function enrichPrintFileMetricsWithResinCost(metrics: PrintFileMetrics): PrintFileMetrics {
  const estimate = estimatePlateResinCost(metrics);
  return {
    ...metrics,
    resinCost: estimate.resinCost,
    resinCostSource: estimate.resinCostSource,
    resinCostLabel: estimate.resinCostLabel,
  };
}

export function resinProfileView(profile: ResinProfile = getActiveResinProfile()) {
  const rate = rateFromProfile(profile);
  const inventory = resinRateFromActiveBottle();
  const supplies = resinRateFromSupplies();
  return {
    profile,
    // Effective rate used by plate estimates (profile → inventory → supplies).
    rate: rate && rate.bottlePriceUsd > 0 ? rate : inventory ?? supplies,
    profileRate: rate,
    inventoryRate: inventory,
    suppliesRate: supplies,
    amazonUrl: profile.amazonUrl || amazonUrlForAsin(profile.amazonAsin, DEFAULT_RESIN_URL),
    canRefreshAmazon: /^[A-Z0-9]{10}$/i.test(profile.amazonAsin.trim()),
  };
}
