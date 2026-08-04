import test from "node:test";
import assert from "node:assert/strict";
import { buildPerformanceSnapshot } from "../server/lib/performance";

test("performance summarizes recent deals and ranks low margins before incomplete costs", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const snapshot = buildPerformanceSnapshot({
    now,
    intakeCounts: { awaiting_client: 2, pending_review: 1, created: 4, expired: 0 },
    supplySpend: {
      periodDays: 30,
      total: 62.5,
      purchases: 2,
      byCategory: [{ category: "materials", label: "Materials", total: 62.5, count: 2 }],
    },
    stages: [
      { id: "deposit", label: "Deposit received", displayOrder: 0, metadata: { isClosed: false } },
      { id: "closed", label: "Completed", displayOrder: 1, metadata: { isClosed: true } },
    ],
    deals: [
      {
        id: "one",
        properties: {
          dealname: "Low-margin Knight",
          dealstage: "deposit",
          createdate: "2026-08-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "350",
          print_material_cost: "130",
          print_labor_cost: "100",
          print_packaging_cost: "20",
          print_actual_shipping_cost: "10",
          print_plate_count: "2",
          print_estimated_resin_cost: "12",
        },
      },
      {
        id: "two",
        properties: {
          dealname: "Needs costs",
          dealstage: "deposit",
          createdate: "2026-08-02T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "100",
          print_material_cost: "",
          print_labor_cost: "",
          print_packaging_cost: "",
          print_actual_shipping_cost: "",
        },
      },
      {
        id: "three",
        properties: {
          dealname: "Finished order",
          dealstage: "closed",
          createdate: "2026-08-02T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "50",
          print_material_cost: "10",
          print_labor_cost: "10",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
        },
      },
      {
        id: "four",
        properties: {
          dealname: "Cost drift",
          dealstage: "deposit",
          createdate: "2026-06-20T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "200",
          print_material_cost: "40",
          print_labor_cost: "20",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
          print_plate_count: "1",
          print_estimated_resin_cost: "20",
        },
      },
      {
        id: "five",
        properties: {
          dealname: "Paid without plates",
          dealstage: "deposit",
          createdate: "2026-06-15T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "180",
          print_material_cost: "30",
          print_labor_cost: "25",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
          print_plate_count: "0",
        },
      },
    ],
  });

  assert.equal(snapshot.summary.orders, 3);
  assert.equal(snapshot.summary.revenue, 500);
  assert.equal(snapshot.summary.grossProfit, 210);
  assert.equal(snapshot.summary.activeOrders, 4);
  assert.equal(snapshot.pipeline.find((stage) => stage.id === "deposit")?.count, 4);
  assert.equal(snapshot.pipeline.find((stage) => stage.id === "closed")?.count, 1);
  assert.equal(snapshot.attention[0]?.dealName, "Low-margin Knight");
  assert.match(snapshot.attention[0]?.issue ?? "", /Margin below/);
  assert.equal(snapshot.attention[1]?.dealName, "Cost drift");
  assert.match(snapshot.attention[1]?.issue ?? "", /Material cost vs CTB estimate/);
  assert.equal(snapshot.attention[2]?.dealName, "Needs costs");
  assert.equal(snapshot.attention.find((item) => item.dealName === "Paid without plates")?.issue, "No CTB plates attached");
  assert.equal(snapshot.supplySpend.total, 62.5);
  assert.equal(snapshot.intake.pendingReview, 1);
});
