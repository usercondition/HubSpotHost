/**
 * Spending page helpers: one bottom line across HubSpot order money, the supply
 * ledger (supply_purchases) and shop overhead (expenses). Both tables stay;
 * this module only reads them, except the guarded single-row "move to Supplies".
 */
import crypto from "node:crypto";
import { getSqlite } from "./order-links";
import type { ShopBooks } from "../../shared/shop-dashboard";

export type SpendingBottomLine = {
  revenue: number;
  orderCosts: number;
  grossProfit: number;
  supplies: number;
  overhead: number;
  bottomLine: number;
  ordersCounted: number;
  ordersMissingCost: number;
  supplyReceipts: number;
  estimated: boolean;
};

const r2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** revenue − order costs − supplies − overhead. Overhead excludes Materials/Shipping supplies rows (they are supplies). */
export function buildSpendingBottomLine(books: ShopBooks, overheadCents: number): SpendingBottomLine {
  const overhead = r2(overheadCents / 100);
  return {
    revenue: r2(books.revenue),
    orderCosts: r2(books.orderCosts),
    grossProfit: r2(books.grossProfit),
    supplies: r2(books.supplies),
    overhead,
    bottomLine: r2(books.grossProfit - books.supplies - overhead),
    ordersCounted: books.ordersCounted,
    ordersMissingCost: books.ordersMissingCost,
    supplyReceipts: books.supplyReceipts,
    estimated: books.estimated,
  };
}

/** Expense categories that are physical supplies; they belong in the supply ledger. */
export const SUPPLY_LIKE_EXPENSE_CATEGORIES: Record<string, "materials" | "packaging_shipping"> = {
  Materials: "materials",
  "Shipping supplies": "packaging_shipping",
};

export class MoveExpenseError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type ExpenseRow = {
  id: string; vendor: string; name: string; category: string; amount_cents: number; currency: string;
  usd_amount_cents: number | null; start_date: string; notes: string; is_recurring: number; archived_at: string | null;
};

export type MoveExpenseExpect = { amountCents: number; startDate: string };

function moveMarker(id: string) {
  return `moved-from-expense:${id}`;
}

/**
 * Move ONE one-off supply-like expense into supply_purchases, archive the expense
 * and record it in expense_audit. Guarded: the caller must state the expected
 * amount and date, which must match the row. Idempotent: a second call returns
 * the purchase created by the first. `apply: false` only reports what would happen.
 */
export function moveExpenseToSupplies(id: string, expect: MoveExpenseExpect, options: { apply: boolean }) {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
  if (!row) throw new MoveExpenseError("Expense not found.", 404);
  const marker = moveMarker(id);
  const existing = db.prepare("SELECT * FROM supply_purchases WHERE notes LIKE ? ORDER BY id LIMIT 1").get(`%${marker}%`) as Record<string, unknown> | undefined;
  if (existing) return { status: "already-moved" as const, expenseId: id, purchase: existing };
  if (row.archived_at) throw new MoveExpenseError("Expense is archived and was not moved by this action.", 409);
  if (row.is_recurring) throw new MoveExpenseError("Recurring expenses cannot be moved.", 409);
  const supplyCategory = SUPPLY_LIKE_EXPENSE_CATEGORIES[row.category];
  if (!supplyCategory) throw new MoveExpenseError("Only Materials or Shipping supplies expenses can move to Supplies.", 409);
  if (row.currency !== "USD") throw new MoveExpenseError("Only USD expenses can move to Supplies.", 409);
  if (row.amount_cents !== expect.amountCents || row.start_date !== expect.startDate) {
    throw new MoveExpenseError("Expense amount or date does not match what was expected; nothing moved.", 409);
  }
  const totalAmount = (row.amount_cents / 100).toFixed(2);
  const plan = {
    source: row.vendor,
    itemName: row.name,
    category: supplyCategory,
    totalAmount,
    purchasedAt: `${row.start_date}T12:00:00.000Z`,
  };
  if (!options.apply) return { status: "dry-run" as const, expenseId: id, plan };
  const now = new Date().toISOString();
  return db.transaction(() => {
    const notes = [row.notes?.trim(), `Moved from Expenses (${marker})`].filter(Boolean).join(" · ");
    const lineItems = JSON.stringify([{ itemName: row.name, quantity: 1, lineAmount: totalAmount, category: supplyCategory }]);
    const info = db.prepare(`INSERT INTO supply_purchases (source, order_reference, item_name, category, quantity, total_amount, purchased_at, notes, created_at, line_items_json)
      VALUES (?, '', ?, ?, 1, ?, ?, ?, ?, ?)`).run(plan.source, plan.itemName, plan.category, plan.totalAmount, plan.purchasedAt, notes, now, lineItems);
    db.prepare("UPDATE expenses SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    const after = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
    const purchase = db.prepare("SELECT * FROM supply_purchases WHERE id = ?").get(info.lastInsertRowid) as Record<string, unknown>;
    db.prepare("INSERT INTO expense_audit (id,expense_id,action,old_values_json,new_values_json,created_at) VALUES (?,?,?,?,?,?)")
      .run(crypto.randomUUID(), id, "moved_to_supplies", JSON.stringify(row), JSON.stringify({ expense: after, supplyPurchaseId: purchase.id }), now);
    return { status: "moved" as const, expenseId: id, purchase };
  })();
}
