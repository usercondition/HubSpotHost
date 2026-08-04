import { desc } from "drizzle-orm";
import {
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  lineItemsForSupplyPurchase,
  normalizeSupplyLineItems,
  parseAmountNumber,
  summarizeSupplyLineItems,
  supplyPurchases,
  type CreateSupplyPurchaseInput,
  type SupplyCategory,
  type SupplyPurchase,
} from "../../shared/schema";
import { round2 } from "./calc";
import { getDb } from "./order-links";

export const SUPPLY_SPEND_WINDOW_DAYS = 30;

const MATERIAL_KEYWORDS = [
  "resin",
  "filament",
  "primer",
  "paint",
  "epoxy",
  "silicone",
  "pigment",
];
const PACKAGING_KEYWORDS = [
  "box",
  "mailer",
  "bubble",
  "tape",
  "label",
  "packing",
  "shipping",
  "envelope",
  "foam",
];
const EQUIPMENT_KEYWORDS = [
  "fep",
  "nfep",
  "screen",
  "vat",
  "printer",
  "build plate",
  "motor",
  "bearing",
  "replacement",
  "repair",
  "tool",
];
const CONSUMABLE_KEYWORDS = [
  "glove",
  "nitrile",
  "isopropyl",
  "ipa",
  "alcohol",
  "paper towel",
  "mask",
  "filter",
  "funnel",
  "rag",
  "wipe",
];

function hasKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function money(value: string): number {
  const parsed = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function purchaseDate(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00.000Z` : value);
  return parsed.toISOString();
}

export function suggestSupplyCategory(itemName: string): SupplyCategory {
  const normalized = itemName.toLowerCase();
  if (hasKeyword(normalized, MATERIAL_KEYWORDS)) return "materials";
  if (hasKeyword(normalized, PACKAGING_KEYWORDS)) return "packaging_shipping";
  if (hasKeyword(normalized, EQUIPMENT_KEYWORDS)) return "equipment_maintenance";
  if (hasKeyword(normalized, CONSUMABLE_KEYWORDS)) return "consumables";
  return "other";
}

export function createSupplyPurchase(input: CreateSupplyPurchaseInput): SupplyPurchase {
  const lines = normalizeSupplyLineItems({
    ...input,
    category: input.category,
  }).map((line) => ({
    ...line,
    category: line.category || suggestSupplyCategory(line.itemName),
  }));
  const summary = summarizeSupplyLineItems(lines);
  const totalAmount = money(input.totalAmount) || summary.lineTotal || 0;

  return getDb()
    .insert(supplyPurchases)
    .values({
      source: input.source || "Amazon",
      orderReference: input.orderReference ?? "",
      itemName: summary.itemName || input.itemName,
      category: input.category ?? summary.category,
      quantity: summary.quantity || input.quantity || 1,
      totalAmount: totalAmount.toFixed(2),
      purchasedAt: purchaseDate(input.purchasedAt),
      notes: input.notes ?? "",
      createdAt: new Date().toISOString(),
      lineItemsJson: JSON.stringify(lines),
    })
    .returning()
    .get();
}

export function listSupplyPurchases(limit = 100): SupplyPurchase[] {
  return getDb()
    .select()
    .from(supplyPurchases)
    .orderBy(desc(supplyPurchases.purchasedAt), desc(supplyPurchases.id))
    .limit(Math.max(1, Math.min(limit, 500)))
    .all();
}

export interface SupplySpendSummary {
  periodDays: number;
  total: number;
  purchases: number;
  byCategory: Array<{
    category: SupplyCategory;
    label: string;
    total: number;
    count: number;
  }>;
}

export function buildSupplySpendSummary(now = new Date()): SupplySpendSummary {
  const startsAt = new Date(now);
  startsAt.setUTCDate(startsAt.getUTCDate() - SUPPLY_SPEND_WINDOW_DAYS);
  const buckets = new Map<SupplyCategory, { total: number; count: number }>(
    SUPPLY_CATEGORIES.map((category) => [category, { total: 0, count: 0 }]),
  );
  let purchases = 0;
  let total = 0;

  for (const purchase of listSupplyPurchases(500)) {
    const purchasedAt = new Date(purchase.purchasedAt);
    if (!Number.isFinite(purchasedAt.getTime()) || purchasedAt < startsAt || purchasedAt > now) continue;
    const amount = money(purchase.totalAmount);
    total += amount;
    purchases += 1;

    const lines = lineItemsForSupplyPurchase(purchase);
    const lineAmounts = lines.map((line) => parseAmountNumber(line.lineAmount));
    const knownLineTotal = lineAmounts.reduce(
      (sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0),
      0,
    );
    const canAllocateLines =
      lines.length > 1 && lineAmounts.every((value) => Number.isFinite(value) && value > 0);

    if (canAllocateLines) {
      lines.forEach((line, index) => {
        const lineAmount = lineAmounts[index] ?? 0;
        const share =
          knownLineTotal > 0 && amount > 0 ? (lineAmount / knownLineTotal) * amount : lineAmount;
        const bucket = buckets.get(line.category);
        if (!bucket) return;
        bucket.total += share;
        bucket.count += 1;
      });
    } else {
      const bucket = buckets.get(purchase.category);
      if (!bucket) continue;
      bucket.total += amount;
      bucket.count += 1;
    }
  }

  return {
    periodDays: SUPPLY_SPEND_WINDOW_DAYS,
    total: round2(total),
    purchases,
    byCategory: SUPPLY_CATEGORIES.map((category) => {
      const bucket = buckets.get(category) ?? { total: 0, count: 0 };
      return {
        category,
        label: SUPPLY_CATEGORY_LABELS[category],
        total: round2(bucket.total),
        count: bucket.count,
      };
    }).filter((bucket) => bucket.count > 0),
  };
}
