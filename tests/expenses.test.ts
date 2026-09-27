import test from "node:test";
import assert from "node:assert/strict";
import { overheadForPeriod } from "../server/lib/expenses";

test("recurring expenses prorate and one-off charges count once", () => {
  const rows: any = [
    { currency: "USD", amount_cents: 3044, cadence: "monthly", start_date: "2026-01-01", end_date: null },
    { currency: "USD", amount_cents: 1200, cadence: "one-off", start_date: "2026-01-15", end_date: null },
  ];
  assert.equal(overheadForPeriod(rows, "2026-01-01", "2026-01-31"), 4300);
  assert.equal(overheadForPeriod(rows, "2026-02-01", "2026-02-28"), 2800);
});

test("ended installments do not contribute after their end date", () => {
  assert.equal(overheadForPeriod([{ currency: "USD", amount_cents: 10000, cadence: "monthly", start_date: "2026-01-01", end_date: "2026-03-31" }] as any, "2026-04-01", "2026-04-30"), 0);
});
