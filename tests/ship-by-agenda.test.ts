import test from "node:test";
import assert from "node:assert/strict";
import {
  addShipByCalendarDays,
  groupShipByAgenda,
  shipByAgendaBucket,
  shipByHonestyLabel,
} from "../shared/ship-by";
import {
  answerTrackerQuestionRules,
  type TrackerAssistantContext,
  type TrackerAssistantQueueDeal,
} from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

test("ship-by agenda buckets overdue, today, week, and later", () => {
  const today = "2026-09-17";
  assert.equal(shipByAgendaBucket("2026-09-10", today), "overdue");
  assert.equal(shipByAgendaBucket("2026-09-17", today), "due_today");
  assert.equal(shipByAgendaBucket("2026-09-20", today), "this_week");
  assert.equal(shipByAgendaBucket("2026-09-30", today), "later");
  assert.equal(addShipByCalendarDays(today, 7), "2026-09-24");
});

test("groupShipByAgenda builds a 7-day week strip", () => {
  const today = "2026-09-17";
  const agenda = groupShipByAgenda(
    [
      { shipBy: "2026-09-10", dealId: "a", dealName: "Late" },
      { shipBy: "2026-09-17", dealId: "b", dealName: "Today" },
      { shipBy: "2026-09-19", dealId: "c", dealName: "Fri" },
      { shipBy: "2026-10-01", dealId: "d", dealName: "Later" },
    ],
    today,
  );
  assert.equal(agenda.overdue.length, 1);
  assert.equal(agenda.dueToday.length, 1);
  assert.equal(agenda.thisWeek.length, 1);
  assert.equal(agenda.later.length, 1);
  assert.equal(agenda.weekDays.length, 7);
  assert.equal(agenda.weekDays[0]?.date, today);
  assert.equal(agenda.weekDays[0]?.items[0]?.dealName, "Today");
  assert.equal(agenda.weekDays[2]?.items[0]?.dealName, "Fri");
  assert.match(shipByHonestyLabel("2026-09-10", today, "override"), /Overdue/);
  assert.match(shipByHonestyLabel("2026-09-10", today, "override"), /set/);
});

function slimDeal(
  overrides: Partial<TrackerAssistantQueueDeal> & Pick<TrackerAssistantQueueDeal, "dealId" | "dealName" | "shipBy">,
): TrackerAssistantQueueDeal {
  return {
    stage: "Queued",
    amount: 100,
    bucket: "next_print",
    costsIncomplete: false,
    hasPlates: false,
    labelBought: false,
    trackingPasted: false,
    shipReady: false,
    shipBySource: "derived",
    ...overrides,
  };
}

test("tracker assistant answers due / overdue from shipAgenda", () => {
  const snapshot: PerformanceResponse = {
    generatedAt: "2026-09-17T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-08-18T12:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 0,
      grossProfit: 0,
      weightedMarginPercent: 0,
      orders: 0,
      averageOrderValue: 0,
      activeOrders: 2,
      attentionCount: 0,
    },
    intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 0,
      orderCosts: 0,
      grossProfit: 0,
      orders: 0,
      supplySpend: 0,
      supplyPurchases: 0,
      afterSupplySpend: 0,
      supplyShareOfRevenuePercent: 0,
      supplyShareOfGrossProfitPercent: 0,
      byCategory: [],
    },
    pipeline: [],
    attention: [],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: null,
  };

  const overdue = slimDeal({
    dealId: "late",
    dealName: "Late bust",
    shipBy: "2026-09-10",
    shipBySource: "override",
  });
  const dueToday = slimDeal({
    dealId: "today",
    dealName: "Due knight",
    shipBy: "2026-09-17",
    shipBySource: "derived",
    bucket: "in_production",
    hasPlates: true,
  });

  const ctx: TrackerAssistantContext = {
    snapshot,
    awaitingLinks: [],
    pendingLinks: [],
    queue: {
      summary: {
        nextPrint: 1,
        inProduction: 1,
        shipReady: 0,
        blocked: 0,
        needsReply: 0,
        readyToPack: 0,
        openOrders: 2,
      },
      nextPrint: [overdue],
      shipReady: [],
      blocked: [],
      needsReply: [],
      readyToPack: [],
      needsLabel: [],
      shipAgenda: {
        today: "2026-09-17",
        overdue: [overdue],
        dueToday: [dueToday],
        thisWeek: [],
      },
    },
  };

  const answer = answerTrackerQuestionRules("What’s due / overdue this week?", ctx);
  assert.match(answer.reply, /Late bust/);
  assert.match(answer.reply, /Due knight/);
  assert.match(answer.reply, /Ship honesty/);
  assert.ok(answer.actions.some((action) => action.href === "/stack"));
  assert.ok(answer.actions.some((action) => action.href.includes("/stack?dealId=late")));
});

test("tracker briefing elevates overdue ship-bys", () => {
  const snapshot: PerformanceResponse = {
    generatedAt: "2026-09-17T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-08-18T12:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 0,
      grossProfit: 0,
      weightedMarginPercent: 0,
      orders: 0,
      averageOrderValue: 0,
      activeOrders: 1,
      attentionCount: 0,
    },
    intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 0,
      orderCosts: 0,
      grossProfit: 0,
      orders: 0,
      supplySpend: 0,
      supplyPurchases: 0,
      afterSupplySpend: 0,
      supplyShareOfRevenuePercent: 0,
      supplyShareOfGrossProfitPercent: 0,
      byCategory: [],
    },
    pipeline: [],
    attention: [],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: null,
  };

  const overdue = slimDeal({
    dealId: "late",
    dealName: "Late bust",
    shipBy: "2026-09-10",
    shipBySource: "override",
  });

  const answer = answerTrackerQuestionRules("What should I do next?", {
    snapshot,
    awaitingLinks: [],
    pendingLinks: [],
    queue: {
      summary: {
        nextPrint: 1,
        inProduction: 0,
        shipReady: 0,
        blocked: 0,
        needsReply: 0,
        readyToPack: 0,
        openOrders: 1,
      },
      nextPrint: [overdue],
      shipReady: [],
      blocked: [],
      needsReply: [],
      readyToPack: [],
      needsLabel: [],
      shipAgenda: {
        today: "2026-09-17",
        overdue: [overdue],
        dueToday: [],
        thisWeek: [],
      },
    },
  });

  assert.match(answer.reply, /1\. 1 overdue ship-by/);
  assert.match(answer.reply, /Late bust/);
});
