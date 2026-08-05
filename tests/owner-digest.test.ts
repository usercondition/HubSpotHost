import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnerDigestText,
  localDigestDateKey,
  localDigestHour,
  shouldRunScheduledDigest,
  writeLastDigestDateKey,
  readLastDigestDateKey,
} from "../server/lib/owner-digest";
import { getTelegramConfig, sendTelegramMessage } from "../server/lib/telegram";
import type { TrackerAssistantContext } from "../server/lib/tracker-assistant";
import type { PerformanceResponse } from "../shared/schema";

function sampleContext(): TrackerAssistantContext {
  const snapshot: PerformanceResponse = {
    generatedAt: "2026-08-05T12:00:00.000Z",
    period: { days: 30, startsAt: "2026-07-06T12:00:00.000Z" },
    thresholds: { marginPercent: 40, staleDays: 7 },
    summary: {
      revenue: 900,
      grossProfit: 280,
      weightedMarginPercent: 31.1,
      orders: 3,
      averageOrderValue: 300,
      activeOrders: 2,
      attentionCount: 2,
    },
    intake: { awaitingClient: 1, pendingReview: 2, approved: 4 },
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
    ],
    activeDeals: [
      {
        dealId: "d1",
        dealName: "Knight bust",
        stageId: "deposit",
        stage: "Deposit received",
        amount: 120,
        contactName: "Ada",
        hasPlates: false,
        promptAttachPlates: true,
        closeDate: null,
      },
    ],
    hubspotPortalId: "123",
  };

  return {
    snapshot,
    awaitingLinks: [
      {
        id: "a1",
        internalLabel: "ORD-1",
        itemDescription: "Base",
        agreedAmount: 40,
        expiresAt: "2026-08-20T00:00:00.000Z",
        status: "awaiting_client",
      },
    ],
    pendingLinks: [
      {
        id: "p1",
        internalLabel: "ORD-2",
        itemDescription: "Bust",
        agreedAmount: 120,
        clientFullName: "Ada Lovelace",
        status: "pending_review",
      },
    ],
  };
}

test("telegram config requires token and chat id shape", () => {
  assert.equal(getTelegramConfig({}), null);
  assert.equal(getTelegramConfig({ TELEGRAM_BOT_TOKEN: "bad", TELEGRAM_CHAT_ID: "1" }), null);
  assert.deepEqual(
    getTelegramConfig({
      TELEGRAM_BOT_TOKEN: "123:AA-valid_token",
      TELEGRAM_CHAT_ID: "6722471679",
    }),
    { token: "123:AA-valid_token", chatId: "6722471679" },
  );
});

test("owner digest text prioritizes pending review and includes actions", () => {
  const text = buildOwnerDigestText(sampleContext(), {
    PUBLIC_BASE_URL: "https://example.com",
  });
  assert.match(text, /Print Ops — morning briefing/);
  assert.match(text, /Review 2 submitted buyer form/);
  assert.match(text, /Open:/);
  assert.match(text, /https:\/\/example\.com\/#\/orders/);
});

test("sendTelegramMessage posts JSON without throwing on mock fetch", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await sendTelegramMessage("hello", {
    TELEGRAM_BOT_TOKEN: "123:AA-token",
    TELEGRAM_CHAT_ID: "99",
  }, fetchImpl);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messageId, 9);
  assert.match(calls[0]!.url, /api\.telegram\.org\/bot123:AA-token\/sendMessage/);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.chat_id, "99");
  assert.equal(body.text, "hello");
});

test("schedule gate respects timezone hour and once-per-day state", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-digest-"));
  const stateFile = join(dir, "state.json");
  const env = {
    OWNER_DIGEST_SCHEDULE_ENABLED: "true",
    OWNER_DIGEST_TZ: "UTC",
    OWNER_DIGEST_HOUR: "7",
    OWNER_DIGEST_STATE_FILE: stateFile,
    TELEGRAM_BOT_TOKEN: "123:AA-token",
    TELEGRAM_CHAT_ID: "99",
  };

  const atHour7 = new Date("2026-08-05T07:10:00.000Z");
  const atHour8 = new Date("2026-08-05T08:10:00.000Z");

  assert.equal(localDigestHour("UTC", atHour7), 7);
  assert.equal(localDigestDateKey("UTC", atHour7), "2026-08-05");
  assert.equal(shouldRunScheduledDigest(env, atHour8).run, false);
  assert.equal(shouldRunScheduledDigest(env, atHour7).run, true);

  writeLastDigestDateKey("2026-08-05", env);
  assert.equal(readLastDigestDateKey(env), "2026-08-05");
  assert.equal(shouldRunScheduledDigest(env, atHour7).run, false);

  rmSync(dir, { recursive: true, force: true });
});
