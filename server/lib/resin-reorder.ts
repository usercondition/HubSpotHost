/**
 * Resin "what to buy next" from sealed stock + recent consumption burn rate.
 */
import { desc } from "drizzle-orm";
import {
  resinBottleConsumptions,
  type ResinInventorySnapshot,
  type ResinReorderResponse,
  type ResinReorderSuggestion,
} from "../../shared/schema";
import { getDb } from "./order-links";

const DEFAULT_LOOKBACK_DAYS = 30;
/** Target days of stock before suggesting a buy. */
const TARGET_DAYS = 21;
/** Suggest buy when projected days of stock fall at or below this. */
const BUY_SOON_DAYS = 10;
const BUY_CRITICAL_DAYS = 4;

function gramsFromText(value: string | null | undefined): number {
  const parsed = Number(String(value ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function buildResinReorderSuggestions(
  snapshot: ResinInventorySnapshot,
  options?: { lookbackDays?: number; now?: Date },
): ResinReorderResponse {
  const lookbackDays = Math.max(7, Math.min(90, options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const now = options?.now ?? new Date();
  const since = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();
  const generatedAt = now.toISOString();

  const consumptions = getDb()
    .select()
    .from(resinBottleConsumptions)
    .orderBy(desc(resinBottleConsumptions.createdAt))
    .limit(2_000)
    .all()
    .filter((row) => row.createdAt >= since);

  const gramsByProduct = new Map<number, number>();
  const bottleToProduct = new Map(snapshot.bottles.map((bottle) => [bottle.bottleId, bottle.productId]));
  for (const row of consumptions) {
    const productId = bottleToProduct.get(row.bottleId);
    if (productId == null) continue;
    gramsByProduct.set(productId, (gramsByProduct.get(productId) ?? 0) + gramsFromText(row.resinMassG));
  }

  const openRemainingByProduct = new Map<number, number>();
  for (const bottle of snapshot.bottles) {
    if (bottle.status !== "open") continue;
    openRemainingByProduct.set(
      bottle.productId,
      (openRemainingByProduct.get(bottle.productId) ?? 0) + Math.max(0, bottle.remainingMassG),
    );
  }

  const suggestions: ResinReorderSuggestion[] = snapshot.products.map((product) => {
    const used = gramsByProduct.get(product.id) ?? 0;
    const gramsPerDay = used / lookbackDays;
    const openRemaining = openRemainingByProduct.get(product.id) ?? 0;
    const sealedGrams = product.sealedCount * product.bottleMassG;
    const totalGrams = sealedGrams + openRemaining;
    const daysOfStock =
      gramsPerDay > 0.5 ? Math.round((totalGrams / gramsPerDay) * 10) / 10 : product.sealedCount >= 2 ? null : openRemaining > 0 ? 999 : 0;

    let urgency: ResinReorderSuggestion["urgency"] = "ok";
    let suggestedBuyCount = 0;
    let reason = "Stock looks fine for current burn.";

    if (gramsPerDay <= 0.5) {
      if (product.sealedCount <= 0 && openRemaining < product.bottleMassG * 0.25) {
        urgency = "soon";
        suggestedBuyCount = 1;
        reason = "Little recent usage, but sealed stock is empty and the open bottle is low.";
      } else if (product.sealedCount <= 1) {
        urgency = "watch";
        reason = "Low sealed stock with quiet recent usage — keep one spare on the shelf.";
        suggestedBuyCount = product.sealedCount === 0 ? 1 : 0;
      }
    } else if (daysOfStock != null) {
      if (daysOfStock <= BUY_CRITICAL_DAYS) {
        urgency = "critical";
        const needGrams = Math.max(0, TARGET_DAYS * gramsPerDay - totalGrams);
        suggestedBuyCount = Math.max(1, Math.ceil(needGrams / product.bottleMassG));
        reason = `~${daysOfStock} days left at ${gramsPerDay.toFixed(0)} g/day.`;
      } else if (daysOfStock <= BUY_SOON_DAYS) {
        urgency = "soon";
        const needGrams = Math.max(0, TARGET_DAYS * gramsPerDay - totalGrams);
        suggestedBuyCount = Math.max(1, Math.ceil(needGrams / product.bottleMassG));
        reason = `~${daysOfStock} days left — reorder before the active bottle runs out.`;
      } else if (product.sealedCount <= 1 && daysOfStock <= TARGET_DAYS) {
        urgency = "watch";
        suggestedBuyCount = 1;
        reason = `Only ${product.sealedCount} sealed bottle(s) with ~${daysOfStock} days of stock.`;
      }
    }

    return {
      productId: product.id,
      name: product.name,
      brand: product.brand,
      sealedCount: product.sealedCount,
      openRemainingGrams: Math.round(openRemaining * 10) / 10,
      bottleMassG: product.bottleMassG,
      gramsPerDay: Math.round(gramsPerDay * 10) / 10,
      daysOfStock,
      suggestedBuyCount,
      urgency,
      reason,
    };
  });

  const rank: Record<ResinReorderSuggestion["urgency"], number> = {
    critical: 0,
    soon: 1,
    watch: 2,
    ok: 3,
  };
  suggestions.sort((a, b) => rank[a.urgency] - rank[b.urgency] || a.name.localeCompare(b.name));

  return {
    generatedAt,
    lookbackDays,
    suggestions,
    buyNow: suggestions.filter((item) => item.suggestedBuyCount > 0 && (item.urgency === "critical" || item.urgency === "soon")),
  };
}
