import test from "node:test";
import assert from "node:assert/strict";
import { buildSupplyBooksBalance } from "../server/lib/books";

test("books balance subtracts supply spend from gross profit and shares categories", () => {
  const books = buildSupplyBooksBalance({
    periodDays: 30,
    revenue: 1000,
    grossProfit: 400,
    orders: 4,
    supplySpend: {
      periodDays: 30,
      total: 150,
      purchases: 3,
      byCategory: [
        { category: "materials", label: "Materials", total: 100, count: 2 },
        { category: "consumables", label: "Consumables", total: 50, count: 1 },
      ],
    },
  });

  assert.equal(books.orderCosts, 600);
  assert.equal(books.afterSupplySpend, 250);
  assert.equal(books.supplyShareOfRevenuePercent, 15);
  assert.equal(books.supplyShareOfGrossProfitPercent, 37.5);
  assert.equal(books.byCategory[0]?.shareOfSupplyPercent, 66.67);
  assert.equal(books.byCategory[1]?.shareOfSupplyPercent, 33.33);
});

test("books balance stays stable when revenue or supplies are empty", () => {
  const books = buildSupplyBooksBalance({
    periodDays: 30,
    revenue: 0,
    grossProfit: 0,
    orders: 0,
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
  });

  assert.equal(books.afterSupplySpend, 0);
  assert.equal(books.supplyShareOfRevenuePercent, 0);
  assert.equal(books.byCategory.length, 0);
});
