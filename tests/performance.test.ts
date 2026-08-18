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
    attachedPrintDealIds: [],
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
    ],
  });

  assert.equal(snapshot.summary.orders, 3);
  assert.equal(snapshot.summary.revenue, 500);
  assert.equal(snapshot.summary.grossProfit, 210);
  assert.equal(snapshot.books.revenue, 500);
  assert.equal(snapshot.books.orderCosts, 290);
  assert.equal(snapshot.books.grossProfit, 210);
  assert.equal(snapshot.books.supplySpend, 62.5);
  assert.equal(snapshot.books.afterSupplySpend, 147.5);
  assert.equal(snapshot.books.byCategory[0]?.category, "materials");
  assert.equal(snapshot.summary.activeOrders, 2);
  assert.equal(snapshot.activeDeals.length, 2);
  assert.equal(snapshot.activeDeals[0]?.dealName, "Low-margin Knight");
  assert.equal(snapshot.activeDeals[1]?.dealName, "Needs costs");
  assert.equal(snapshot.activeDeals[0]?.hasPlates, false);
  assert.equal(snapshot.activeDeals[0]?.stageId, "deposit");
  assert.equal(snapshot.activeDeals[0]?.contactName, null);
  assert.equal(snapshot.hubspotPortalId, null);
  assert.equal(snapshot.pipeline.find((stage) => stage.id === "deposit")?.count, 2);
  assert.equal(snapshot.pipeline.find((stage) => stage.id === "closed")?.count, 1);
  assert.equal(snapshot.attention[0]?.dealName, "Low-margin Knight");
  assert.match(snapshot.attention[0]?.issue ?? "", /Margin below/);
  assert.ok(
    snapshot.attention.some(
      (item) => item.dealName === "Needs costs" && item.issue === "Cost details incomplete",
    ),
  );
  assert.ok(
    snapshot.attention.some(
      (item) => item.dealName === "Low-margin Knight" && item.issue === "No CTB plates attached",
    ),
  );
  assert.ok(
    snapshot.attention.some(
      (item) => item.dealName === "Needs costs" && item.issue === "No CTB plates attached",
    ),
  );
  assert.ok(snapshot.attention.every((item) => item.issueKey.length > 0));
  assert.equal(snapshot.supplySpend.total, 62.5);
  assert.equal(snapshot.intake.pendingReview, 1);
});

test("dismissed attention keys hide skipped plate reminders for legacy orders", () => {
  const snapshot = buildPerformanceSnapshot({
    now: new Date("2026-08-04T12:00:00.000Z"),
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    dismissedAttentionKeys: ["legacy:no_plates"],
    stages: [{ id: "deposit", label: "Deposit received", displayOrder: 0, metadata: { isClosed: false } }],
    deals: [
      {
        id: "legacy",
        properties: {
          dealname: "GK Combat Patrol - Luke price",
          dealstage: "deposit",
          createdate: "2026-07-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "200",
          print_material_cost: "40",
          print_labor_cost: "30",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
        },
      },
    ],
  });

  assert.equal(
    snapshot.attention.some((item) => item.issueKey === "no_plates"),
    false,
  );
  assert.equal(snapshot.summary.activeOrders, 1);
});

test("HubSpot closed-won flag removes deals from attention without relying on stage metadata", () => {
  const snapshot = buildPerformanceSnapshot({
    now: new Date("2026-08-04T12:00:00.000Z"),
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    stages: [{ id: "done", label: "Completed", displayOrder: 1, metadata: {} }],
    deals: [
      {
        id: "won",
        properties: {
          dealname: "Finished knight",
          dealstage: "done",
          createdate: "2026-07-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          hs_is_closed: "true",
          hs_is_closed_won: "true",
          amount: "200",
          print_material_cost: "",
          print_labor_cost: "",
          print_packaging_cost: "",
          print_actual_shipping_cost: "",
        },
      },
    ],
  });

  assert.equal(snapshot.summary.activeOrders, 0);
  assert.equal(snapshot.attention.length, 0);
});

test("attached print plates suppress the missing-plate attention item", () => {
  const snapshot = buildPerformanceSnapshot({
    now: new Date("2026-08-04T12:00:00.000Z"),
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    attachedPrintDealIds: ["plated"],
    hubspotPortalId: "12345",
    stages: [{ id: "deposit", label: "Deposit received", displayOrder: 0, metadata: { isClosed: false } }],
    deals: [
      {
        id: "plated",
        properties: {
          dealname: "Plated order",
          dealstage: "deposit",
          createdate: "2026-07-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "200",
          print_material_cost: "40",
          print_labor_cost: "30",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
        },
      },
    ],
  });

  assert.equal(snapshot.summary.activeOrders, 1);
  assert.equal(snapshot.attention.length, 0);
  assert.equal(snapshot.activeDeals[0]?.hasPlates, true);
  assert.equal(snapshot.activeDeals[0]?.promptAttachPlates, false);
  assert.equal(snapshot.hubspotPortalId, "12345");
});

test("dismissed no_plates alert keeps hasPlates false but clears attach prompt", () => {
  const snapshot = buildPerformanceSnapshot({
    now: new Date("2026-08-04T12:00:00.000Z"),
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    attachedPrintDealIds: [],
    dismissedAttentionKeys: ["skip-me:no_plates"],
    stages: [{ id: "deposit", label: "Deposit received", displayOrder: 0, metadata: { isClosed: false } }],
    deals: [
      {
        id: "skip-me",
        properties: {
          dealname: "Legacy without plates",
          dealstage: "deposit",
          createdate: "2026-07-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "200",
          print_material_cost: "40",
          print_labor_cost: "30",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
        },
      },
    ],
  });

  assert.equal(snapshot.activeDeals[0]?.hasPlates, false);
  assert.equal(snapshot.activeDeals[0]?.promptAttachPlates, false);
  assert.equal(
    snapshot.attention.some((item) => item.issueKey === "no_plates"),
    false,
  );
});

test("board deals expose close date and contact parsed from Product - Client names", () => {
  const snapshot = buildPerformanceSnapshot({
    now: new Date("2026-08-04T12:00:00.000Z"),
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    attachedPrintDealIds: ["gk"],
    stages: [{ id: "printing", label: "Printing", displayOrder: 0, metadata: { isClosed: false } }],
    deals: [
      {
        id: "gk",
        properties: {
          dealname: "Knight Valiant - Jose montes",
          dealstage: "printing",
          createdate: "2026-07-01T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          closedate: "2026-08-04T00:00:00.000Z",
          amount: "125",
          print_material_cost: "40",
          print_labor_cost: "30",
          print_packaging_cost: "5",
          print_actual_shipping_cost: "5",
        },
      },
    ],
  });

  assert.equal(snapshot.activeDeals[0]?.contactName, "Jose montes");
  assert.ok(snapshot.activeDeals[0]?.closeDate);
  assert.match(snapshot.activeDeals[0]?.closeDate ?? "", /^2026-08-04/);
});

test("shipping line kind skips plate prompts and plate attention", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const snapshot = buildPerformanceSnapshot({
    now,
    intakeCounts: { awaiting_client: 0, pending_review: 0, created: 1, expired: 0 },
    attachedPrintDealIds: [],
    stages: [
      { id: "deposit", label: "Deposit received", displayOrder: 0, metadata: { isClosed: false } },
    ],
    deals: [
      {
        id: "print-deal",
        properties: {
          dealname: "Knight - Buyer",
          dealstage: "deposit",
          createdate: "2026-08-02T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "120",
          print_line_kind: "print",
          print_material_cost: "",
          print_labor_cost: "",
          print_packaging_cost: "",
          print_actual_shipping_cost: "",
        },
      },
      {
        id: "ship-deal",
        properties: {
          dealname: "Shipping - Buyer",
          dealstage: "deposit",
          createdate: "2026-08-02T10:00:00.000Z",
          hs_lastmodifieddate: "2026-08-03T10:00:00.000Z",
          amount: "15",
          print_line_kind: "shipping",
          print_material_cost: "",
          print_labor_cost: "",
          print_packaging_cost: "",
          print_actual_shipping_cost: "",
        },
      },
    ],
  });

  const printDeal = snapshot.activeDeals.find((deal) => deal.dealId === "print-deal");
  const shipDeal = snapshot.activeDeals.find((deal) => deal.dealId === "ship-deal");
  assert.equal(printDeal?.promptAttachPlates, true);
  assert.equal(shipDeal?.promptAttachPlates, false);
  assert.ok(snapshot.attention.some((item) => item.dealId === "print-deal" && item.issueKey === "no_plates"));
  assert.equal(
    snapshot.attention.some((item) => item.dealId === "ship-deal" && item.issueKey === "no_plates"),
    false,
  );
});
