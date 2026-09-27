/**
 * Owner-entered shop overhead. This is Print Ops-only bookkeeping: this module
 * deliberately has no HubSpot dependency or write path.
 */
import crypto from "node:crypto";
import { getSqlite } from "./order-links";

export const EXPENSE_CATEGORIES = ["Models/Patreon", "Model marketplace (MMF)", "Software/AI", "Hosting", "Materials", "Equipment", "Shipping supplies", "Other"] as const;
export const EXPENSE_CADENCES = ["one-off", "monthly", "yearly", "usage"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];

export type ExpenseInput = {
  idempotencyKey: string; vendor: string; name: string; category: ExpenseCategory;
  amountCents: number; currency?: "USD" | "EUR"; usdAmountCents?: number | null; cadence: ExpenseCadence;
  startDate: string; endDate?: string | null; paymentCount?: number | null; paymentNote?: string; notes?: string;
};

function ensureTables() {
  getSqlite().exec(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, name TEXT NOT NULL,
    category TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
    usd_amount_cents INTEGER, cadence TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
    payment_count INTEGER, payment_note TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS expense_audit (
    id TEXT PRIMARY KEY, expense_id TEXT NOT NULL, action TEXT NOT NULL, old_values_json TEXT,
    new_values_json TEXT, created_at TEXT NOT NULL
  );`);
}

function validate(input: ExpenseInput) {
  if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new Error("An idempotency key is required.");
  if (!input.vendor.trim() || !input.name.trim()) throw new Error("Vendor and name are required.");
  if (!EXPENSE_CATEGORIES.includes(input.category) || !EXPENSE_CADENCES.includes(input.cadence)) throw new Error("Choose a valid category and cadence.");
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new Error("Amount must be a non-negative number of cents.");
  if (input.currency === "EUR" && (!Number.isInteger(input.usdAmountCents) || (input.usdAmountCents ?? 0) < 0)) throw new Error("EUR expenses require the entered USD amount.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error("Start date must be YYYY-MM-DD.");
}

export function listExpenses(includeArchived = false) {
  ensureTables();
  return getSqlite().prepare(`SELECT * FROM expenses ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY start_date DESC, created_at DESC`).all();
}

export function createExpense(input: ExpenseInput) {
  ensureTables(); validate(input);
  const db = getSqlite(); const existing = db.prepare("SELECT * FROM expenses WHERE idempotency_key = ?").get(input.idempotencyKey);
  if (existing) return existing;
  const now = new Date().toISOString(); const id = crypto.randomUUID();
  db.prepare(`INSERT INTO expenses (id,idempotency_key,vendor,name,category,amount_cents,currency,usd_amount_cents,cadence,start_date,end_date,payment_count,payment_note,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.idempotencyKey, input.vendor.trim(), input.name.trim(), input.category, input.amountCents, input.currency ?? "USD", input.usdAmountCents ?? null, input.cadence, input.startDate, input.endDate ?? null, input.paymentCount ?? null, input.paymentNote ?? "", input.notes ?? "", now, now);
  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  db.prepare("INSERT INTO expense_audit (id,expense_id,action,new_values_json,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), id, "created", JSON.stringify(row), now);
  return row;
}

export function archiveExpense(id: string) {
  ensureTables(); const db = getSqlite(); const before = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!before) return null; const now = new Date().toISOString();
  db.prepare("UPDATE expenses SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  const after = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  db.prepare("INSERT INTO expense_audit (id,expense_id,action,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?,?)").run(crypto.randomUUID(), id, "archived", JSON.stringify(before), JSON.stringify(after), now);
  return after;
}

export function updateExpense(id: string, input: ExpenseInput) {
  ensureTables(); validate(input);
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
  const startAt = new Date(`${start}T00:00:00Z`).getTime(), endAt = new Date(`${end}T23:59:59Z`).getTime();
  return rows.reduce((sum, row: any) => {
    const amount = row.currency === "EUR" ? row.usd_amount_cents : row.amount_cents;
    const installmentEnd = row.payment_count && (row.cadence === "monthly" || row.cadence === "yearly")
      ? addCadence(row.start_date, row.cadence, row.payment_count)
      : null;
    const effectiveEnd = [row.end_date, installmentEnd].filter(Boolean).sort()[0] as string | undefined;
    if (!Number.isFinite(amount) || row.start_date > end || (effectiveEnd && effectiveEnd < start)) return sum;
    if (row.cadence === "monthly" || row.cadence === "yearly") {
      const daily = amount / (row.cadence === "monthly" ? 30.4375 : 365.25);
      return sum + Math.round(daily * Math.max(0, Math.floor((endAt - startAt) / 86_400_000) + 1));
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
  const amount = row.currency === "EUR" ? row.usd_amount_cents : row.amount_cents;
  if (!Number.isFinite(amount) || row.cadence === "one-off" || row.cadence === "usage") return null;
  return row.cadence === "yearly" ? Math.round(amount / 12) : amount;
}
