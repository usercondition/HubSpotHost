import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHealthDigestEdition,
  digestFontFiles,
  healthDigestCaption,
  isPngBuffer,
  renderHealthDigestPng,
  renderHealthDigestSvg,
  shopDigestTitle,
} from "../server/lib/health-digest-card";
import type { TrackerAssistantContext } from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

function ctx(overrides?: { attention?: PerformanceResponse["attention"]; intake?: PerformanceResponse["intake"] }): TrackerAssistantContext {
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
    intake: overrides?.intake ?? { awaitingClient: 2, pendingReview: 1, approved: 0 },
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
    attention: overrides?.attention ?? [
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
      {
        dealId: "4",
        dealName: "Castle Set",
        stage: "Queued",
        issue: "No CTB plates attached",
        issueKey: "no_plates",
        detail: "Attach sliced plates before print",
        severity: "warn" as const,
      },
    ],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: "123",
  } as PerformanceResponse;
  return { snapshot, awaitingLinks: [], pendingLinks: [] } as TrackerAssistantContext;
}

test("shopDigestTitle strips the health-check suffix", () => {
  assert.equal(shopDigestTitle("Print Ops — health check (manual)"), "Print Ops");
  assert.equal(shopDigestTitle(""), "Print Ops");
});

test("floor card uses Print Ops glance language, not a newspaper masthead", () => {
  const edition = buildHealthDigestEdition(ctx(), {
    now: new Date("2026-08-23T18:00:00.000Z"),
    timeZone: "UTC",
  });
  assert.equal(edition.allClear, false);
  assert.equal(edition.kicker, "Floor");
  assert.equal(edition.lede, "Do this next");
  assert.equal(edition.deck, "1 need plates · 2 need costs · 1 stale");
  assert.match(edition.intakeLine || "", /intake form/);
  assert.equal(edition.rows[0]?.badge, "Intake review");
  assert.deepEqual(
    edition.sections.map((section) => section.kicker),
    ["Need plates", "Need costs", "Stale"],
  );
  assert.deepEqual(
    edition.metrics.map((metric) => metric.label),
    ["Need plates", "Need costs", "Stale", "Intake review", "Awaiting buyer"],
  );
  const svg = renderHealthDigestSvg(edition).svg;
  assert.match(svg, /Print Ops/);
  assert.match(svg, /GLANCE/);
  assert.match(svg, /Do this next/);
  assert.match(svg, /NEED PLATES|Needs plates/);
  assert.match(svg, /Armigers - Jose/);
  assert.doesNotMatch(svg, /THE DAILY FLOOR/);
  assert.doesNotMatch(svg, /Sunday edition/);
  assert.doesNotMatch(svg, /Vol\. I/);
  assert.doesNotMatch(svg, /https:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(svg, /#\/queue|#\/prints/);
  assert.doesNotMatch(svg, /Add material, labor, packaging/);
});

test("caption stays short and does not repeat intake when only intake is open", () => {
  const edition = buildHealthDigestEdition(
    ctx({
      attention: [],
      intake: { awaitingClient: 2, pendingReview: 1, approved: 0 },
    }),
    { now: new Date("2026-08-23T18:00:00.000Z"), timeZone: "UTC" },
  );
  assert.equal(edition.lede, "Do this next");
  assert.equal(edition.intakeLine, null);
  assert.match(edition.deck, /intake form/);
  assert.match(healthDigestCaption(edition), /Do this next/);
  assert.doesNotMatch(healthDigestCaption(edition), /intake form.*intake form/);
});

test("all-clear card says Floor is clear", () => {
  const edition = buildHealthDigestEdition(
    ctx({
      attention: [],
      intake: { awaitingClient: 0, pendingReview: 0, approved: 2 },
    }),
    { now: new Date("2026-08-23T18:00:00.000Z"), timeZone: "UTC" },
  );
  assert.equal(edition.allClear, true);
  assert.equal(edition.lede, "Floor is clear");
  assert.equal(edition.sections.length, 0);
  assert.equal(healthDigestCaption(edition), "Floor is clear.");
  const rendered = renderHealthDigestSvg(edition);
  assert.match(rendered.svg, /Floor is clear/);
  assert.match(rendered.svg, /When something needs plates/);
});

test("health digest card renders a PNG Floor board", () => {
  const edition = buildHealthDigestEdition(ctx(), {
    now: new Date("2026-08-23T18:00:00.000Z"),
    timeZone: "UTC",
  });
  assert.ok(digestFontFiles().some((path) => path.includes("SpaceGrotesk")), "Space Grotesk should be bundled");
  const png = renderHealthDigestPng(edition);
  assert.ok(isPngBuffer(png));
  assert.equal(png.readUInt32BE(16), 2560, "card should rasterize at Telegram HD width");
  assert.ok(png.length > 40_000);
});
