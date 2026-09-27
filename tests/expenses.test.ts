import test from "node:test";
import assert from "node:assert/strict";
import { overheadForPeriod } from "../server/lib/expenses";

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
