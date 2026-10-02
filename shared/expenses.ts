export const EXPENSE_CATEGORIES = ["Models/Patreon", "Model marketplace (MMF)", "Software/AI", "Hosting", "Utilities", "Materials", "Equipment", "Equipment financing", "Shipping supplies", "Other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export function monthlyEquivalentCents(row: { amount_cents: number; usd_amount_cents?: number | null; currency?: string; cadence: string }): number | null {
  const amount = row.currency === "EUR" ? row.usd_amount_cents : row.amount_cents;
  if (!Number.isFinite(amount) || row.cadence === "one-off" || row.cadence === "usage-based" || row.cadence === "usage") return null;
  return row.cadence === "yearly" ? Math.round((amount ?? 0) / 12) : amount ?? null;
}

export function recurringPaymentNumber(row: { start_date: string; next_due_date?: string | null; cadence: string; payment_number?: number | null }): number | null {
  if (row.payment_number != null) return row.payment_number;
  if (!row.next_due_date || !["monthly", "installment", "yearly"].includes(row.cadence)) return null;
  const start = new Date(`${row.start_date}T12:00:00Z`);
  const due = new Date(`${row.next_due_date}T12:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(due.getTime()) || due < start) return null;
  const months = (due.getUTCFullYear() - start.getUTCFullYear()) * 12 + due.getUTCMonth() - start.getUTCMonth();
  return Math.floor(months / (row.cadence === "yearly" ? 12 : 1)) + 1;
}

export function effectiveExpenseEnd(row: { end_date?: string | null; start_date: string; cadence: string; payment_count?: number | null }): string | null {
  let installmentEnd: string | null = null;
  if (row.payment_count && (row.cadence === "monthly" || row.cadence === "yearly" || row.cadence === "installment")) {
    const date = new Date(`${row.start_date}T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + (row.cadence === "yearly" ? 12 : 1) * row.payment_count);
    date.setUTCDate(date.getUTCDate() - 1);
    installmentEnd = date.toISOString().slice(0, 10);
  }
  return [row.end_date, installmentEnd].filter(Boolean).sort()[0] as string | null;
}
