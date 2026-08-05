import test from "node:test";
import assert from "node:assert/strict";
import { answerTrackerQuestionRules, type TrackerAssistantContext } from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

function sampleContext(overrides?: Partial<TrackerAssistantContext>): TrackerAssistantContext {
  const snapshot: PerformanceResponse = {
    generatedAt: "2026-08-04T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-07-05T12:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 900,
      grossProfit: 280,
      weightedMarginPercent: 31.1,
      orders: 3,
      averageOrderValue: 300,
      activeOrders: 2,
      attentionCount: 3,
    },
    intake: { awaitingClient: 1, pendingReview: 1, approved: 4 },
    supplySpend: { periodDays: 30, total: 40, purchases: 1, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 900,
      orderCosts: 620,
      grossProfit: 280,
      orders: 3,
      supplySpend: 40,
      supplyPurchases: 1,
      afterSupplySpend: 240,
      supplyShareOfRevenuePercent: 4.4,
      supplyShareOfGrossProfitPercent: 14.3,
      byCategory: [],
    },
    pipeline: [{ id: "deposit", label: "Deposit received", count: 2, closed: false }],
    attention: [
      {
        dealId: "d1",
        dealName: "Knight bust",
        stage: "Deposit received",
        issue: "No CTB plates attached",
        issueKey: "no_plates",
        detail: "Attach sliced plates",
        severity: "warn",
      },
      {
        dealId: "d2",
        dealName: "Display base",
        stage: "Deposit received",
        issue: "Cost details incomplete",
        issueKey: "costs_incomplete",
        detail: "Add material and shipping",
        severity: "neutral",
      },
    ],
    activeDeals: [
      { dealId: "d1", dealName: "Knight bust", stageId: "deposit", stage: "Deposit received", amount: 200, hasPlates: false },
      { dealId: "d2", dealName: "Display base", stageId: "deposit", stage: "Deposit received", amount: 45, hasPlates: true },
    ],
    hubspotPortalId: "12345",
  };

  return {
    snapshot,
    awaitingLinks: [
      {
        id: 9,
        internalLabel: "MIG-9",
        itemDescription: "Knight bust",
        agreedAmount: "200.00",
        expiresAt: "2026-08-18T00:00:00.000Z",
        status: "awaiting_client",
      },
    ],
    pendingLinks: [
      {
        id: 10,
        internalLabel: "MIG-10",
        itemDescription: "Terrain pack",
        agreedAmount: "95.00",
        clientFullName: "Jane Smith",
        status: "pending_review",
      },
    ],
    ...overrides,
  };
}

test("tracker assistant briefing prioritizes pending review then plates", () => {
  const answer = answerTrackerQuestionRules("What should I do next?", sampleContext());
  assert.equal(answer.mode, "rules");
  assert.match(answer.reply, /Review 1 submitted buyer form/);
  assert.match(answer.reply, /Attach CTB plates/);
  assert.ok(answer.actions.some((action) => action.href === "/orders"));
  assert.ok(answer.actions.some((action) => action.href.includes("/prints?dealId=d1")));
});

test("tracker assistant drafts a marketplace reminder from awaiting intake", () => {
  const answer = answerTrackerQuestionRules("Draft a Marketplace reminder", sampleContext());
  assert.match(answer.reply, /order form for Knight bust/);
  assert.match(answer.reply, /\$200\.00/);
  assert.ok(answer.actions.some((action) => action.href === "/orders"));
});

test("tracker assistant lists plate gaps with attach actions", () => {
  const answer = answerTrackerQuestionRules("Which deals need plates?", sampleContext());
  assert.match(answer.reply, /Knight bust/);
  assert.ok(answer.actions.every((action) => action.href.includes("prints") || action.href === "/prints"));
});

test("tracker assistant explains incomplete costs with HubSpot deep links", () => {
  const answer = answerTrackerQuestionRules("What is missing costs?", sampleContext());
  assert.match(answer.reply, /Display base/);
  assert.ok(
    answer.actions.some((action) => action.external && action.href.includes("/record/0-3/d2")),
  );
});
