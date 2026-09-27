export const EXPENSE_CATEGORIES = ["Models/Patreon", "Model marketplace (MMF)", "Software/AI", "Hosting", "Materials", "Equipment", "Shipping supplies", "Other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export function monthlyEquivalentCents(row: { amount_cents: number; usd_amount_cents?: number | null; currency?: string; cadence: string }): number | null {
  const amount = row.currency === "EUR" ? row.usd_amount_cents : row.amount_cents;
  if (!Number.isFinite(amount) || row.cadence === "one-off" || row.cadence === "usage") return null;
  return row.cadence === "yearly" ? Math.round((amount ?? 0) / 12) : amount ?? null;
}
