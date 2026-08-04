import type { SupplyCategory, SupplySpendSummaryLike } from "../../shared/schema";
import { SUPPLY_CATEGORY_LABELS, type SupplyBooksBalance } from "../../shared/schema";
import { round2 } from "./calc";

/** Build a 30-day books view: revenue → order costs → gross profit → supply spend. */
export function buildSupplyBooksBalance(input: {
  periodDays: number;
  revenue: number;
  grossProfit: number;
  orders: number;
  supplySpend: SupplySpendSummaryLike;
}): SupplyBooksBalance {
  const revenue = round2(Math.max(0, input.revenue));
  const grossProfit = round2(input.grossProfit);
  const orderCosts = round2(revenue - grossProfit);
  const supplySpend = round2(Math.max(0, input.supplySpend.total));
  const afterSupplySpend = round2(grossProfit - supplySpend);
  const supplyShareOfRevenuePercent = revenue > 0 ? round2((supplySpend / revenue) * 100) : 0;
  const supplyShareOfGrossProfitPercent =
    Math.abs(grossProfit) > 0.0001 ? round2((supplySpend / Math.abs(grossProfit)) * 100) : 0;

  const byCategory = (input.supplySpend.byCategory ?? []).map((bucket) => ({
    category: bucket.category as SupplyCategory,
    label: bucket.label || SUPPLY_CATEGORY_LABELS[bucket.category as SupplyCategory] || bucket.category,
    total: round2(bucket.total),
    count: bucket.count,
    shareOfSupplyPercent: supplySpend > 0 ? round2((bucket.total / supplySpend) * 100) : 0,
  }));

  return {
    periodDays: input.periodDays,
    revenue,
    orderCosts,
    grossProfit,
    orders: input.orders,
    supplySpend,
    supplyPurchases: input.supplySpend.purchases,
    afterSupplySpend,
    supplyShareOfRevenuePercent,
    supplyShareOfGrossProfitPercent,
    byCategory,
  };
}
