import test from "node:test";
import assert from "node:assert/strict";
import { netAfterSpendingMetric } from "../server/lib/shop-dashboard";
import { buildSpendingBottomLine } from "../server/lib/spending";

const books = { revenue: 54.99, orderCosts: 12.58, grossProfit: 42.41, ordersCounted: 1, ordersMissingCost: 10, estimated: false, supplies: 186.5, supplyReceipts: 2 };

test("dashboard net subtracts supplies and overhead and equals the Spending bottom line", () => {
  const metric = netAfterSpendingMetric(books, 65765, "30 days");
  assert.equal(metric.id, "net-profit");
  assert.equal(metric.label, "Bottom line");
  assert.equal(metric.value, -801.74);
  assert.equal(metric.value, buildSpendingBottomLine(books, 65765).bottomLine);
});

test("dashboard net is unavailable without an overhead figure and notes missing costs", () => {
  assert.equal(netAfterSpendingMetric(books, undefined, "30 days").value, null);
  assert.match(netAfterSpendingMetric({ ...books, ordersCounted: 0 }, 0, "7 days").note ?? "", /no orders with full costs/);
});
