import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthDigestEdition,
  digestFontFiles,
  isPngBuffer,
  renderHealthDigestPng,
  renderHealthDigestSvg,
} from "../server/lib/health-digest-card";
import type { TrackerAssistantContext } from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

function ctx(): TrackerAssistantContext {
  const snapshot = {
    generatedAt: "2026-08-23T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-07-24T00:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 1000,
      grossProfit: 400,
      weightedMarginPercent: 40,
      orders: 3,
      averageOrderValue: 333,
      activeOrders: 9,
      attentionCount: 8,
    },
    intake: { awaitingClient: 2, pendingReview: 1, approved: 0 },
    supplySpend: { periodDays: 30, total: 0, purchases: 0, byCategory: [] },
    books: {
      periodDays: 30,
      revenue: 1000,
      orderCosts: 600,
      grossProfit: 400,
      supplySpend: 0,
      afterSupplySpend: 400,
      grossMarginPercent: 40,
      afterSupplyMarginPercent: 40,
    },
    pipeline: [],
    attention: [
      {
        dealId: "1",
        dealName: "Armigers - Jose",
        stage: "Queued to Print",
        issue: "Costs incomplete",
        issueKey: "costs_incomplete",
        detail: "Add material, labor, packaging, and shipping costs as they become known",
        severity: "warn" as const,
      },
      {
        dealId: "2",
        dealName: "Knight Valiant - Jose montes",
        stage: "Printing",
        issue: "Costs incomplete",
        issueKey: "costs_incomplete",
        detail: "Add material, labor, packaging, and shipping costs as they become known",
        severity: "warn" as const,
      },
      {
        dealId: "3",
        dealName: "Ship Kit",
        stage: "Printing",
        issue: "No recent activity",
        issueKey: "stale",
        detail: "No HubSpot update in 7 days",
        severity: "warn" as const,
      },
    ],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: "123",
  } as PerformanceResponse;
  return { snapshot, awaitingLinks: [], pendingLinks: [] } as TrackerAssistantContext;
}

test("newspaper edition reads as a digest, not a link list", () => {
  const edition = buildHealthDigestEdition(ctx(), {
    now: new Date("2026-08-23T18:00:00.000Z"),
    timeZone: "UTC",
  });
  assert.equal(edition.allClear, false);
  assert.equal(edition.kicker, "The Daily Floor");
  assert.match(edition.lede, /deals need you/);
  assert.match(edition.intakeLine || "", /waiting review/);
  assert.equal(edition.sections.some((section) => section.kicker === "Costs"), true);
  assert.equal(edition.sections.some((section) => section.kicker === "Stale"), true);
  const svg = renderHealthDigestSvg(edition).svg;
  assert.match(svg, /THE DAILY FLOOR/);
  assert.match(svg, /PRINT OPS/);
  assert.match(svg, /Armigers - Jose/);
  assert.doesNotMatch(svg, /https:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(svg, /#\/queue|#\/prints/);
  assert.doesNotMatch(svg, /Add material, labor, packaging/);
});

test("health digest card renders a PNG newspaper page", () => {
  const edition = buildHealthDigestEdition(ctx(), {
    now: new Date("2026-08-23T18:00:00.000Z"),
    timeZone: "UTC",
  });
  assert.ok(digestFontFiles().length > 0, "serif fonts should be available");
  const png = renderHealthDigestPng(edition);
  assert.ok(isPngBuffer(png));
  assert.ok(png.length > 20_000);
});
