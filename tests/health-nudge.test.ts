import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHealthNudgeButtons,
  buildHealthNudgeText,
  collectHealthNudgeItems,
  getHealthNudgeSchedule,
  healthNudgeFingerprint,
  sendHealthNudge,
  shouldRunScheduledHealthNudge,
} from "../server/lib/health-nudge";
import type { TrackerAssistantContext } from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

function sampleSnapshot(overrides?: Partial<PerformanceResponse>): PerformanceResponse {
  const base = {
    generatedAt: "2026-08-21T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-07-22T00:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 1000,
      grossProfit: 400,
      weightedMarginPercent: 40,
      orders: 3,
      averageOrderValue: 333,
      activeOrders: 2,
      attentionCount: 2,
    },
    intake: { awaitingClient: 1, pendingReview: 1, approved: 0 },
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
        dealId: "101",
        dealName: "Castle Set",
        stage: "Queued",
        issue: "No CTB plates attached",
        issueKey: "no_plates",
        detail: "Attach sliced plates before print",
        severity: "warn" as const,
      },
      {
        dealId: "102",
        dealName: "Ship Kit",
        stage: "Printing",
        issue: "No recent activity",
        issueKey: "stale",
        detail: "No HubSpot update in 9 days",
        severity: "warn" as const,
      },
      {
        dealId: "103",
        dealName: "Low margin toy",
        stage: "Queued",
        issue: "Margin below 40%",
        issueKey: "low_margin",
        detail: "Margin is 22%",
        severity: "bad" as const,
      },
    ],
    activeDeals: [],
    closedDeals: [],
    hubspotPortalId: "123",
  };
  return { ...base, ...overrides, ...(overrides?.summary ? { summary: { ...base.summary, ...overrides.summary } } : {}), ...(overrides?.intake ? { intake: { ...base.intake, ...overrides.intake } } : {}) } as PerformanceResponse;
}

function sampleCtx(snapshot?: PerformanceResponse): TrackerAssistantContext {
  return {
    snapshot: snapshot ?? sampleSnapshot(),
    awaitingLinks: [],
    pendingLinks: [],
  } as TrackerAssistantContext;
}

test("collectHealthNudgeItems ignores low_margin and keeps actionable keys", () => {
  const collected = collectHealthNudgeItems(sampleSnapshot());
  assert.equal(collected.attention.length, 2);
  assert.ok(collected.attention.every((item) => item.issueKey !== "low_margin"));
  assert.equal(collected.intakePending, 1);
  assert.equal(collected.intakeAwaiting, 1);
  assert.equal(collected.hasWork, true);
});

test("buildHealthNudgeText lists plates, stale, and intake without raw URLs", () => {
  const built = buildHealthNudgeText(sampleCtx(), { PUBLIC_BASE_URL: "https://ops.example" });
  assert.equal(built.hasWork, true);
  assert.match(built.text, /<b>Need plates<\/b>/);
  assert.match(built.text, /Castle Set/);
  assert.match(built.text, /<b>Stale<\/b>/);
  assert.match(built.text, /<b>Intake<\/b>/);
  assert.match(built.text, /Do this next/);
  assert.match(built.text, /Attach CTB \/ slice files/);
  assert.doesNotMatch(built.text, /https?:\/\//);
  assert.doesNotMatch(built.text, /Low margin toy/);
  assert.doesNotMatch(built.text, /Open in queue:/);
  assert.doesNotMatch(built.text, /Attach sliced plates before print/);
  assert.doesNotMatch(built.text, /Need a slice/);
});

test("health nudge buttons are a short shop row, not per-deal links", () => {
  const buttons = buildHealthNudgeButtons(collectHealthNudgeItems(sampleSnapshot()), {
    PUBLIC_BASE_URL: "https://ops.example",
  });
  assert.ok(buttons);
  assert.equal(buttons.inline_keyboard.length, 1);
  const labels = buttons.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(labels, ["Floor", "Queue", "Intake", "Prints"]);
  assert.ok(buttons.inline_keyboard.flat().every((button) => button.url.startsWith("https://ops.example/#/")));
  assert.equal(buttons.inline_keyboard.flat().some((button) => button.url.includes("dealId=")), false);
});

test("shop buttons stay on the card even when the floor is clear", () => {
  const buttons = buildHealthNudgeButtons(
    collectHealthNudgeItems(
      sampleSnapshot({
        attention: [],
        intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
      }),
    ),
    { PUBLIC_BASE_URL: "https://ops.example" },
  );
  assert.deepEqual(buttons?.inline_keyboard.flat().map((button) => button.text), [
    "Floor",
    "Queue",
    "Intake",
    "Prints",
  ]);
});

test("buildHealthNudgeText is quiet when shop is clear", () => {
  const snapshot = sampleSnapshot({
    attention: [],
    intake: { awaitingClient: 0, pendingReview: 0, approved: 2 },
    summary: {
      revenue: 0,
      grossProfit: 0,
      weightedMarginPercent: 0,
      orders: 0,
      averageOrderValue: 0,
      activeOrders: 0,
      attentionCount: 0,
    },
  });
  const built = buildHealthNudgeText(sampleCtx(snapshot));
  assert.equal(built.hasWork, false);
  assert.match(built.text, /Floor is clear/);
});

test("fingerprint changes when open work changes", () => {
  const a = healthNudgeFingerprint(sampleSnapshot());
  const b = healthNudgeFingerprint(
    sampleSnapshot({
      attention: [],
      intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
    }),
  );
  assert.notEqual(a, b);
});

test("getHealthNudgeSchedule parses hour lists", () => {
  const schedule = getHealthNudgeSchedule({
    OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED: "true",
    OWNER_HEALTH_NUDGE_TZ: "UTC",
    OWNER_HEALTH_NUDGE_HOURS: "9, 12, 17",
  });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.timeZone, "UTC");
  assert.deepEqual(schedule.hours, [9, 12, 17]);
});

test("shouldRunScheduledHealthNudge respects disabled schedule", () => {
  const due = shouldRunScheduledHealthNudge({
    OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED: "false",
  });
  assert.equal(due.run, false);
  assert.match(due.reason, /disabled/i);
});

test("sendHealthNudge skips when clear and not forced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "health-nudge-"));
  try {
    const snapshot = sampleSnapshot({
      attention: [],
      intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
    });
    const result = await sendHealthNudge(
      sampleCtx(snapshot),
      {
        OWNER_HEALTH_NUDGE_STATE_FILE: join(dir, "state.json"),
        TELEGRAM_BOT_TOKEN: "123456789:AAHdummyTokenForTestsOnly_01234567",
        TELEGRAM_CHAT_ID: "12345",
      },
      { force: false },
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.skipped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
