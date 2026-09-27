/**
 * Shop expense ledger. Stored in the Print Ops SQLite file.
 * Rows are archived, never deleted. Edits keep the previous values.
 * This module does not talk to HubSpot.
 */
import { getSqlite } from "./order-links";
import { shipByCalendarDate } from "../../shared/ship-by";
import { resolveShopWindow, SHOP_PERIODS, type ShopPeriodId } from "../../shared/shop-dashboard";
import {
  monthlyEquivalentCents,
  monthlyRunRateCents,
  overheadCentsForDates,
  type ExpenseCadence,
  type ExpenseCategory,
  type ExpenseSlice,
} from "../../shared/expenses";

export interface ExpenseRecord extends ExpenseSlice {
  id: number;
  clientKey: string;
  vendor: string;
  name: string;
  category: ExpenseCategory;
  currency: "USD";
  paymentNote: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseAuditEntry {
  id: number;
  expenseId: number;
  action: "create" | "update" | "archive";
  oldJson: string | null;
  newJson: string;
  createdAt: string;
}

interface ExpenseRow {
  id: number;
  client_key: string;
  vendor: string;
  name: string;
  category: string;
  amount_cents: number;
  currency: string;
  cadence: string;
  start_date: string;
  end_date: string | null;
  payment_note: string;
  notes: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ExpenseRow): ExpenseRecord {
  return {
    id: row.id,
    clientKey: row.client_key,
    vendor: row.vendor,
    name: row.name,
    category: row.category as ExpenseCategory,
    amountCents: row.amount_cents,
    currency: "USD",
    cadence: row.cadence as ExpenseCadence,
    startDate: row.start_date,
    endDate: row.end_date,
    paymentNote: row.payment_note,
    notes: row.notes,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshot(record: ExpenseRecord): string {
  return JSON.stringify(record);
}

function readById(id: number): ExpenseRecord | null {
  const row = getSqlite().prepare(`SELECT * FROM shop_expenses WHERE id = ?`).get(id) as ExpenseRow | undefined;
  return row ? toRecord(row) : null;
}

function readByKey(clientKey: string): ExpenseRecord | null {
  const row = getSqlite().prepare(`SELECT * FROM shop_expenses WHERE client_key = ?`).get(clientKey) as ExpenseRow | undefined;
  return row ? toRecord(row) : null;
}

function writeAudit(expenseId: number, action: ExpenseAuditEntry["action"], oldJson: string | null, newJson: string): void {
  getSqlite()
    .prepare(
      `INSERT INTO shop_expense_audit (expense_id, action, old_json, new_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(expenseId, action, oldJson, newJson, new Date().toISOString());
}

export function listExpenseRecords(): ExpenseRecord[] {
  const rows = getSqlite().prepare(`SELECT * FROM shop_expenses ORDER BY start_date DESC, id DESC`).all() as ExpenseRow[];
  return rows.map(toRecord);
}

export function listExpenseAudit(expenseId: number): ExpenseAuditEntry[] {
  const rows = getSqlite()
    .prepare(`SELECT * FROM shop_expense_audit WHERE expense_id = ? ORDER BY id ASC`)
    .all(expenseId) as Array<{
    id: number;
    expense_id: number;
    action: ExpenseAuditEntry["action"];
    old_json: string | null;
    new_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    expenseId: row.expense_id,
    action: row.action,
    oldJson: row.old_json,
    newJson: row.new_json,
    createdAt: row.created_at,
  }));
}

export function expensePeriodSpan(period: ShopPeriodId, now = new Date()): { start: string | null; end: string; label: string } {
  const window = resolveShopWindow(period, now);
  const labels: Record<ShopPeriodId, string> = {
    "7": "7 days",
    "30": "30 days",
    "90": "90 days",
    ytd: "Year to date",
    all: "All time",
  };
  return {
    start: window.start == null ? null : shipByCalendarDate(new Date(window.start)),
    end: shipByCalendarDate(new Date(window.end)),
    label: labels[period],
  };
}

export function parseExpensePeriod(value: string): ShopPeriodId {
  return (SHOP_PERIODS as readonly string[]).includes(value) ? (value as ShopPeriodId) : "30";
}

function overlapsPeriod(expense: ExpenseRecord, start: string | null, end: string): boolean {
  if (expense.archived) return false;
  if (expense.cadence === "one-off") return (start == null || expense.startDate >= start) && expense.startDate <= end;
  const last = expense.endDate && expense.endDate < end ? expense.endDate : end;
  const first = start == null || expense.startDate > start ? expense.startDate : start;
  return first <= last;
}

export function listExpensesForView(query: { category?: string; period?: string; archived?: boolean; now?: Date }) {
  const period = parseExpensePeriod(query.period ?? "30");
  const span = expensePeriodSpan(period, query.now ?? new Date());
  const today = shipByCalendarDate(query.now ?? new Date());
  const category = query.category?.trim() ?? "";
  const rows = listExpenseRecords().filter((expense) => {
    if (category && expense.category !== category) return false;
    if (query.archived) return expense.archived;
    if (expense.archived) return false;
    return overlapsPeriod(expense, span.start, span.end);
  });
  const pool = listExpenseRecords().filter((expense) => !category || expense.category === category);
  const expenses = rows.map((expense) => ({
    ...expense,
    monthlyEquivalentCents: monthlyEquivalentCents(expense, today),
    periodCents: overheadCentsForDates([expense], span.start, span.end),
  }));
  return {
    period: { id: period, ...span },
    stored: pool.filter((expense) => !expense.archived).length,
    expenses,
    totals: {
      monthlyRunRateCents: monthlyRunRateCents(pool, today),
      periodCents: overheadCentsForDates(
        pool.filter((expense) => !expense.archived),
        span.start,
        span.end,
      ),
    },
  };
}

export function createExpense(input: {
  clientKey: string;
  vendor: string;
  name: string;
  category: ExpenseCategory;
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate?: string | null;
  paymentNote?: string;
  notes?: string;
}): { expense: ExpenseRecord; created: boolean } {
  const existing = readByKey(input.clientKey);
  if (existing) return { expense: existing, created: false };
  const now = new Date().toISOString();
  const end = input.endDate?.trim() || null;
  const result = getSqlite()
    .prepare(
      `INSERT INTO shop_expenses (
         client_key, vendor, name, category, amount_cents, currency, cadence, start_date, end_date,
         payment_note, notes, archived, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.clientKey,
      input.vendor.trim(),
      input.name.trim(),
      input.category,
      input.amountCents,
      input.cadence,
      input.startDate,
      end,
      (input.paymentNote ?? "").trim(),
      (input.notes ?? "").trim(),
      now,
      now,
    );
  const expense = readById(Number(result.lastInsertRowid));
  if (!expense) throw new Error("The expense was not saved.");
  writeAudit(expense.id, "create", null, snapshot(expense));
  return { expense, created: true };
}

export function updateExpense(
  id: number,
  patch: Partial<{
    vendor: string;
    name: string;
    category: ExpenseCategory;
    amountCents: number;
    cadence: ExpenseCadence;
    startDate: string;
    endDate: string | null;
    paymentNote: string;
    notes: string;
    archived: boolean;
  }>,
): ExpenseRecord | null {
  const current = readById(id);
  if (!current) return null;
  const next: ExpenseRecord = {
    ...current,
    vendor: patch.vendor?.trim() ?? current.vendor,
    name: patch.name?.trim() ?? current.name,
    category: patch.category ?? current.category,
    amountCents: patch.amountCents ?? current.amountCents,
    cadence: patch.cadence ?? current.cadence,
    startDate: patch.startDate ?? current.startDate,
    endDate: patch.endDate === undefined ? current.endDate : patch.endDate?.trim() || null,
    paymentNote: patch.paymentNote?.trim() ?? current.paymentNote,
    notes: patch.notes?.trim() ?? current.notes,
    archived: patch.archived ?? current.archived,
    updatedAt: new Date().toISOString(),
  };
  if (next.endDate && next.endDate < next.startDate) {
    throw new Error("The end date is before the start date");
  }
  const unchanged =
    current.vendor === next.vendor &&
    current.name === next.name &&
    current.category === next.category &&
    current.amountCents === next.amountCents &&
    current.cadence === next.cadence &&
    current.startDate === next.startDate &&
    current.endDate === next.endDate &&
    current.paymentNote === next.paymentNote &&
    current.notes === next.notes &&
    current.archived === next.archived;
  if (unchanged) return current;
  getSqlite()
    .prepare(
      `UPDATE shop_expenses SET
         vendor = ?, name = ?, category = ?, amount_cents = ?, cadence = ?, start_date = ?, end_date = ?,
         payment_note = ?, notes = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.vendor,
      next.name,
      next.category,
      next.amountCents,
      next.cadence,
      next.startDate,
      next.endDate,
      next.paymentNote,
      next.notes,
      next.archived ? 1 : 0,
      next.updatedAt,
      id,
    );
  const saved = readById(id);
  if (!saved) return null;
  writeAudit(id, saved.archived && !current.archived ? "archive" : "update", snapshot(current), snapshot(saved));
  return saved;
}

export function archiveExpense(id: number): ExpenseRecord | null {
  const current = readById(id);
  if (!current) return null;
  if (current.archived) return current;
  return updateExpense(id, { archived: true });
}
