import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createExpense, logRecurringCharge, overheadForPeriod } from "../server/lib/expenses";
import { effectiveExpenseEnd, recurringPaymentNumber } from "../shared/expenses";

test("recurring expenses prorate and one-off charges count once", () => {
  const rows: any = [
    { currency: "USD", amount_cents: 3044, cadence: "monthly", start_date: "2026-01-01", end_date: null },
    { currency: "USD", amount_cents: 1200, cadence: "one-off", start_date: "2026-01-15", end_date: null },
  ];
  assert.equal(overheadForPeriod(rows, "2026-01-01", "2026-01-31"), 4200);
  assert.equal(overheadForPeriod(rows, "2026-02-01", "2026-02-28"), 2700);
});

test("proration clips to expense dates and excludes per-order categories", () => {
  const row: any = { currency: "USD", amount_cents: 1200, cadence: "monthly", start_date: "2026-09-15", end_date: "2026-09-20" };
  assert.equal(overheadForPeriod([row], "2026-09-01", "2026-09-30"), 197);
  assert.equal(overheadForPeriod([{ ...row, category: "Materials" }], "2026-09-01", "2026-09-30"), 0);
});

test("proration uses exclusive day counts for 7/30 days, installments, and all time", () => {
  const monthly: any = { currency: "USD", amount_cents: 3044, cadence: "monthly", start_date: "2026-01-01", payment_count: null };
  assert.equal(overheadForPeriod([monthly], "2026-01-01", "2026-01-08"), 700);
  assert.equal(overheadForPeriod([monthly], "2026-01-01", "2026-01-31"), 3000);
  const installment: any = { ...monthly, start_date: "2026-01-15", payment_count: 2 };
  assert.equal(overheadForPeriod([installment], "0000-01-01", "2026-03-31"), 5800);
});

test("ended installments do not contribute after their end date", () => {
  assert.equal(overheadForPeriod([{ currency: "USD", amount_cents: 10000, cadence: "monthly", start_date: "2026-01-01", end_date: "2026-03-31" }] as any, "2026-04-01", "2026-04-30"), 0);
});

test("effective end excludes a cancelled monthly subscription from today's run rate", () => {
  assert.equal(effectiveExpenseEnd({ start_date: "2026-01-01", cadence: "monthly", end_date: "2026-09-21" }), "2026-09-21");
});

test("recurring definitions never count as overhead, but their logged charge does", () => {
  const recurring: any = createExpense({
    idempotencyKey: `recurring-${crypto.randomUUID()}`, vendor: "Test hosting", name: "Usage", category: "Hosting",
    amountCents: 1200, cadence: "usage-based", startDate: "2026-09-01", nextDueDate: "2026-10-01", isRecurring: true,
  });
  assert.equal(overheadForPeriod([recurring] as any, "2026-09-01", "2026-09-30"), 0);
  const charge: any = logRecurringCharge(recurring.id, {
    idempotencyKey: `charge-${crypto.randomUUID()}`, amountCents: 1575, startDate: "2026-09-15",
  });
  assert.equal(charge.recurring_expense_id, recurring.id);
  assert.equal(overheadForPeriod([recurring, charge] as any, "2026-09-01", "2026-09-30"), 1575);
});

test("owner-provided fixed electricity accrues until a real linked charge replaces it", () => {
  const electricity = { id: "electricity", is_recurring: 1, counts_as_overhead: 1, currency: "USD", amount_cents: 15000, cadence: "monthly", start_date: "2026-10-01", end_date: null, category: "Utilities" };
  const charge = { is_recurring: 0, recurring_expense_id: "electricity", currency: "USD", amount_cents: 15250, cadence: "one-off", start_date: "2026-10-15", category: "Utilities" };
  assert.equal(overheadForPeriod([electricity] as any, "2026-10-01", "2026-10-31"), 14784);
  assert.equal(overheadForPeriod([electricity, charge] as any, "2026-10-01", "2026-10-31"), 15250);
});

test("migrated recurring accruals preserve prior overhead and legacy usage stays dated", () => {
  const before: any[] = [
    { id: "patreon", currency: "USD", amount_cents: 1200, cadence: "monthly", start_date: "2026-01-01" },
    { id: "affirm", currency: "USD", amount_cents: 24000, cadence: "monthly", start_date: "2026-01-01", payment_count: 6 },
    { id: "cursor", currency: "USD", amount_cents: 1900, cadence: "usage", start_date: "2026-09-12" },
  ];
  const after = before.map((row) => row.cadence === "usage" ? { ...row, is_recurring: 0 } : { ...row, is_recurring: 1, counts_as_overhead: 1 });
  assert.equal(overheadForPeriod(after as any, "2026-09-01", "2026-09-30"), overheadForPeriod(before as any, "2026-09-01", "2026-09-30"));
});

test("installment display derives payment number from its next due date", () => {
  assert.equal(recurringPaymentNumber({ start_date: "2026-06-01", next_due_date: "2026-10-07", cadence: "installment" }), 5);
});
