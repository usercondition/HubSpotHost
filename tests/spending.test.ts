import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createExpense, listExpenses, overheadForPeriod } from "../server/lib/expenses";
import { getSqlite } from "../server/lib/order-links";
import { buildSpendingBottomLine, moveExpenseToSupplies, MoveExpenseError } from "../server/lib/spending";
import { spendingTabFor } from "../client/src/lib/spending-tabs";

const books = { revenue: 500, orderCosts: 180, grossProfit: 320, ordersCounted: 4, ordersMissingCost: 1, estimated: false, supplies: 111.29, supplyReceipts: 1 };

test("bottom line = revenue − order costs − supplies − overhead", () => {
  const line = buildSpendingBottomLine(books, 12345);
  assert.equal(line.overhead, 123.45);
  assert.equal(line.bottomLine, 85.26);
  assert.equal(line.revenue - line.orderCosts, line.grossProfit);
});

test("overhead never includes Materials / Shipping supplies rows, so supplies are not double counted", () => {
  const rows: any = [
    { category: "Materials", currency: "USD", amount_cents: 11972, cadence: "one-off", start_date: "2026-09-24" },
    { category: "Shipping supplies", currency: "USD", amount_cents: 500, cadence: "one-off", start_date: "2026-09-24" },
    { category: "Software/AI", currency: "USD", amount_cents: 2000, cadence: "one-off", start_date: "2026-09-24" },
  ];
  assert.equal(overheadForPeriod(rows, "2026-09-01", "2026-09-30"), 2000);
});

test("route aliases open the matching Spending tab", () => {
  assert.equal(spendingTabFor("/supplies"), "supplies");
  assert.equal(spendingTabFor("/spending"), "supplies");
  assert.equal(spendingTabFor("/expenses"), "overhead");
  assert.equal(spendingTabFor("/spending/overhead"), "overhead");
});

function materials(amountCents = 11972) {
  return createExpense({ idempotencyKey: `spend-${crypto.randomUUID()}`, vendor: "Elegoo", name: "ELEGOO supplies (demo)", category: "Materials", amountCents, cadence: "one-off", startDate: "2026-09-24" }) as { id: string };
}

test("move to Supplies is guarded, audited and idempotent", () => {
  const db = getSqlite();
  const row = materials();
  const expect = { amountCents: 11972, startDate: "2026-09-24" };
  assert.throws(() => moveExpenseToSupplies(row.id, { ...expect, amountCents: 11973 }, { apply: true }), MoveExpenseError);
  const dry: any = moveExpenseToSupplies(row.id, expect, { apply: false });
  assert.equal(dry.status, "dry-run");
  assert.equal(dry.plan.totalAmount, "119.72");
  assert.equal(db.prepare("SELECT archived_at FROM expenses WHERE id = ?").get(row.id).archived_at, null);

  const before = (db.prepare("SELECT COUNT(*) n FROM supply_purchases").get() as { n: number }).n;
  const moved: any = moveExpenseToSupplies(row.id, expect, { apply: true });
  assert.equal(moved.status, "moved");
  assert.equal(moved.purchase.total_amount, "119.72");
  assert.equal(moved.purchase.category, "materials");
  assert.equal(moved.purchase.purchased_at, "2026-09-24T12:00:00.000Z");
  assert.ok(!listExpenses().some((e: any) => e.id === row.id), "expense no longer listed");
  const again: any = moveExpenseToSupplies(row.id, expect, { apply: true });
  assert.equal(again.status, "already-moved");
  assert.equal(again.purchase.id, moved.purchase.id);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM supply_purchases").get() as { n: number }).n, before + 1);
  const audit = db.prepare("SELECT action FROM expense_audit WHERE expense_id = ? ORDER BY created_at").all(row.id) as Array<{ action: string }>;
  assert.deepEqual(audit.map((a) => a.action), ["created", "moved_to_supplies"]);
});

test("move refuses non-supply categories and unknown ids", () => {
  const other = createExpense({ idempotencyKey: `spend-${crypto.randomUUID()}`, vendor: "Cursor", name: "Plan", category: "Software/AI", amountCents: 2000, cadence: "one-off", startDate: "2026-09-24" }) as { id: string };
  assert.throws(() => moveExpenseToSupplies(other.id, { amountCents: 2000, startDate: "2026-09-24" }, { apply: true }), /Only Materials/);
  assert.throws(() => moveExpenseToSupplies("nope", { amountCents: 1, startDate: "2026-09-24" }, { apply: true }), /not found/);
});
