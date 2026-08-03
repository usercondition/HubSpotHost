import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateProfit,
  round2,
  toNumber,
  toOutputProperties,
} from "../server/lib/calc";

test("guide example: 150 amount with 76 of cost", () => {
  const r = calculateProfit({
    amount: "150",
    print_material_cost: "18",
    print_labor_cost: "45",
    print_packaging_cost: "4",
    print_actual_shipping_cost: "9",
  });
  assert.equal(r.costTotal, 76);
  assert.equal(r.grossProfit, 74);
  assert.equal(r.marginPercentage, 49.33);
});

test("blank, null and missing inputs count as zero", () => {
  const r = calculateProfit({
    amount: "200",
    print_material_cost: "",
    print_labor_cost: null,
    print_packaging_cost: undefined,
  });
  assert.equal(r.grossProfit, 200);
  assert.equal(r.marginPercentage, 100);
  assert.equal(r.costTotal, 0);
});

test("amount of zero yields zero margin, not a division error", () => {
  const r = calculateProfit({ amount: "0", print_material_cost: "25" });
  assert.equal(r.grossProfit, -25);
  assert.equal(r.marginPercentage, 0);
});

test("missing amount yields zero margin", () => {
  const r = calculateProfit({ print_labor_cost: "10" });
  assert.equal(r.grossProfit, -10);
  assert.equal(r.marginPercentage, 0);
});

test("negative gross profit and margin are reported", () => {
  const r = calculateProfit({
    amount: 100,
    print_material_cost: 60,
    print_labor_cost: 50,
  });
  assert.equal(r.grossProfit, -10);
  assert.equal(r.marginPercentage, -10);
});

test("results round to two decimals", () => {
  const r = calculateProfit({ amount: "10.25", print_material_cost: "0.125" });
  assert.equal(r.grossProfit, 10.13);
  const m = calculateProfit({ amount: "3", print_material_cost: "1" });
  assert.equal(m.marginPercentage, 66.67);
});

test("numeric coercion tolerates separators and rejects junk", () => {
  assert.equal(toNumber("1,250.50"), 1250.5);
  assert.equal(toNumber("abc"), 0);
  assert.equal(toNumber(NaN), 0);
  assert.equal(toNumber(true), 0);
  assert.equal(round2(2.345), 2.35);
});

test("output payload maps to the two existing HubSpot fields as strings", () => {
  const props = toOutputProperties(
    calculateProfit({ amount: "150", print_labor_cost: "50" }),
  );
  assert.deepEqual(props, {
    print_gross_profit: "100.00",
    print_margin_percentage: "66.67",
  });
});
