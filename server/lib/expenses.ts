/**
 * Owner-entered shop overhead. This is Print Ops-only bookkeeping: this module
 * deliberately has no HubSpot dependency or write path.
 */
import crypto from "node:crypto";
import { getSqlite } from "./order-links";
import { EXPENSE_CATEGORIES, monthlyEquivalentCents, type ExpenseCategory } from "../../shared/expenses";

export const EXPENSE_CADENCES = ["one-off", "monthly", "yearly", "usage"] as const;
export { EXPENSE_CATEGORIES };
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];

export type ExpenseInput = {
  idempotencyKey: string; vendor: string; name: string; category: ExpenseCategory;
  amountCents: number; currency?: "USD" | "EUR"; usdAmountCents?: number | null; cadence: ExpenseCadence;
  startDate: string; endDate?: string | null; paymentCount?: number | null; paymentNote?: string; notes?: string;
};

function validate(input: ExpenseInput) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new Error("An idempotency key is required.");
  if (!input.vendor.trim() || !input.name.trim()) throw new Error("Vendor and name are required.");
  if (!EXPENSE_CATEGORIES.includes(input.category) || !EXPENSE_CADENCES.includes(input.cadence)) throw new Error("Choose a valid category and cadence.");
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new Error("Amount must be a non-negative number of cents.");
  if (input.currency === "EUR" && (!Number.isInteger(input.usdAmountCents) || (input.usdAmountCents ?? 0) < 0)) throw new Error("EUR expenses require the entered USD amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error("Start date must be YYYY-MM-DD.");
}

export function listExpenses(includeArchived = false) {
  return getSqlite().prepare(`SELECT * FROM expenses ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY start_date DESC, created_at DESC`).all();
}

export function createExpense(input: ExpenseInput) {
  validate(input);
  const db = getSqlite(); const existing = db.prepare("SELECT * FROM expenses WHERE idempotency_key = ?").get(input.idempotencyKey);
  if (existing) return existing;
  const now = new Date().toISOString(); const id = crypto.randomUUID();
  return db.transaction(() => {
  db.prepare(`INSERT INTO expenses (id,idempotency_key,vendor,name,category,amount_cents,currency,usd_amount_cents,cadence,start_date,end_date,payment_count,payment_note,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.idempotencyKey, input.vendor.trim(), input.name.trim(), input.category, input.amountCents, input.currency ?? "USD", input.usdAmountCents ?? null, input.cadence, input.startDate, input.endDate ?? null, input.paymentCount ?? null, input.paymentNote ?? "", input.notes ?? "", now, now);
  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  db.prepare("INSERT INTO expense_audit (id,expense_id,action,new_values_json,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), id, "created", JSON.stringify(row), now);
  return row;
  })();
}

export function archiveExpense(id: string) {
  const db = getSqlite(); const before = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!before || (before as { archived_at?: string }).archived_at) return null; const now = new Date().toISOString();
  db.prepare("UPDATE expenses SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  const after = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  db.prepare("INSERT INTO expense_audit (id,expense_id,action,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?,?)").run(crypto.randomUUID(), id, "archived", JSON.stringify(before), JSON.stringify(after), now);
  return after;
}

export function updateExpense(id: string, input: ExpenseInput) {
  validate(input);
  const db = getSqlite(); const before = db.prepare("SELECT * FROM expenses WHERE id = ? AND archived_at IS NULL").get(id);
  if (!before) return null;
  const now = new Date().toISOString();
  db.prepare(`UPDATE expenses SET vendor=?,name=?,category=?,amount_cents=?,currency=?,usd_amount_cents=?,cadence=?,start_date=?,end_date=?,payment_count=?,payment_note=?,notes=?,updated_at=? WHERE id=?`)
    .run(input.vendor.trim(), input.name.trim(), input.category, input.amountCents, input.currency ?? "USD", input.usdAmountCents ?? null, input.cadence, input.startDate, input.endDate ?? null, input.paymentCount ?? null, input.paymentNote ?? "", input.notes ?? "", now, id);
  const after = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  db.prepare("INSERT INTO expense_audit (id,expense_id,action,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?,?)").run(crypto.randomUUID(), id, "updated", JSON.stringify(before), JSON.stringify(after), now);
  return after;
}

export function overheadForPeriod(rows: ReturnType<typeof listExpenses>, start: string, end: string): number {
  return rows.reduce<number>((sum, row: any) => {
    if (row.category === "Materials" || row.category === "Shipping supplies") return sum;
    const amount = row.currency === "EUR" ? row.usd_amount_cents : row.amount_cents;
    const installmentEnd = row.payment_count && (row.cadence === "monthly" || row.cadence === "yearly")
      ? addCadence(row.start_date, row.cadence, row.payment_count)
      : null;
    const effectiveEnd = [row.end_date, installmentEnd].filter(Boolean).sort()[0] as string | undefined;
    if (!Number.isFinite(amount) || row.start_date > end || (effectiveEnd && effectiveEnd < start)) return sum;
    if (row.cadence === "monthly" || row.cadence === "yearly") {
      const daily = amount / (row.cadence === "monthly" ? 30.4375 : 365.25);
      const overlapStart = row.start_date > start ? row.start_date : start;
      const overlapEnd = effectiveEnd && effectiveEnd < end ? effectiveEnd : end;
      const days = Math.max(0, Math.round((Date.parse(`${overlapEnd}T00:00:00Z`) - Date.parse(`${overlapStart}T00:00:00Z`)) / 86_400_000));
      return sum + Math.round(daily * days);
    }
    return row.start_date >= start && row.start_date <= end ? sum + amount : sum;
  }, 0);
}

function addCadence(start: string, cadence: string, payments: number): string {
  const date = new Date(`${start}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + (cadence === "yearly" ? 12 : 1) * payments);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function monthlyEquivalent(row: any): number | null {
  return monthlyEquivalentCents(row);
}
