import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnerDigestText,
  localDigestDateKey,
  localDigestHour,
  nextPrintCandidates,
  platesOnOpenOrders,
  shouldRunScheduledDigest,
  writeLastDigestDateKey,
  readLastDigestDateKey,
  type OwnerDigestContext,
} from "../server/lib/owner-digest";
import { getTelegramConfig, sendTelegramMessage } from "../server/lib/telegram";
import type {
  PerformanceResponse,
  PrintFileRecord,
  PrinterFleetSnapshot,
  ResinInventorySnapshot,
} from "../shared/schema";

function sampleFleet(): PrinterFleetSnapshot {
  return {
    printers: [
      {
        printerId: 1,
        name: "Mighty 8K A",
        brand: "Phrozen",
        model: "Mighty 8K",
        status: "active",
        aliases: [],
        notes: "",
        recommendedFepHours: 80,
        recommendedFepLayers: 25_000,
        plateCount: 12,
        totalPrintTimeSeconds: 40_000,
        totalPrintHours: 11.1,
        totalLayers: 8_000,
        totalResinVolumeMl: 900,
        totalResinMassG: 990,
        distinctOrders: 4,
        firstJobAt: "2026-07-01T00:00:00.000Z",
        lastJobAt: "2026-08-04T18:00:00.000Z",
        matchedProfiles: ["Mighty 8K"],
        fepInstalledAt: "2026-06-01T00:00:00.000Z",
        hoursSinceFep: 72,
        layersSinceFep: 20_000,
        fepHoursUsedPercent: 90,
        fepLayersUsedPercent: 80,
        screenInstalledAt: null,
        hoursSinceScreen: 0,
        layersSinceScreen: 0,
        recentJobs: [],
        lifecycleEvents: [],
      },
      {
        printerId: 2,
        name: "Mega 8K",
        brand: "Phrozen",
        model: "Mega 8K",
        status: "active",
        aliases: [],
        notes: "",
        recommendedFepHours: 80,
        recommendedFepLayers: 25_000,
        plateCount: 3,
        totalPrintTimeSeconds: 10_000,
        totalPrintHours: 2.8,
        totalLayers: 2_000,
        totalResinVolumeMl: 200,
        totalResinMassG: 220,
        distinctOrders: 2,
        firstJobAt: "2026-08-01T00:00:00.000Z",
        lastJobAt: "2026-08-03T12:00:00.000Z",
        matchedProfiles: ["Mega 8K"],
        fepInstalledAt: "2026-07-15T00:00:00.000Z",
        hoursSinceFep: 10,
        layersSinceFep: 1_000,
        fepHoursUsedPercent: 12,
        fepLayersUsedPercent: 4,
        screenInstalledAt: null,
        hoursSinceScreen: 0,
        layersSinceScreen: 0,
        recentJobs: [],
        lifecycleEvents: [],
      },
    ],
    unassigned: {
      plateCount: 0,
      totalPrintTimeSeconds: 0,
      totalPrintHours: 0,
      totalLayers: 0,
      profiles: [],
      recentJobs: [],
    },
    fleetTotals: {
      plateCount: 15,
      totalPrintHours: 13.9,
      totalLayers: 10_000,
      activePrinters: 2,
    },
  };
}

function sampleResin(): ResinInventorySnapshot {
  return {
    products: [
      {
        id: 1,
        name: "ABS-Like Grey",
        brand: "Elegoo",
        bottleMassG: 1000,
        bottleVolumeMl: 1000,
        unitCostUsd: 30,
        sealedCount: 1,
        sealedValueUsd: 30,
        openBottleCount: 1,
        notes: "",
      },
    ],
    bottles: [],
    activeBottle: {
      bottleId: 9,
      productId: 1,
      productName: "ABS-Like Grey",
      brand: "Elegoo",
      status: "open",
      isActive: true,
      openedAt: "2026-08-01T00:00:00.000Z",
      initialMassG: 1000,
      remainingMassG: 420,
      usedMassG: 580,
      usedPercent: 58,
      unitCostUsd: 30,
      costPerGram: 0.03,
      materialCostUsedUsd: 17.4,
      plateCount: 4,
      distinctOrders: 2,
      attributedDealRevenueUsd: 240,
      roughContributionUsd: 200,
      notes: "",
      recentConsumptions: [],
    },
    totals: {
      sealedBottles: 1,
      sealedValueUsd: 30,
      openBottles: 1,
      resinUsedGrams: 580,
      materialCostUsedUsd: 17.4,
      attributedDealRevenueUsd: 240,
    },
  };
}

function samplePlate(overrides?: Partial<PrintFileRecord>): PrintFileRecord {
  return {
    id: 1,
    analysisId: "a1",
    hubspotDealId: "d2",
    hubspotDealName: "Display base",
    dealStage: "Printing",
    fileName: "DisplayBase_P1.ctb",
    fileSizeBytes: 1_000_000,
    sha256: "abc",
    formatRevision: "4",
    printTimeSeconds: 14_400,
    resinVolumeMl: "120",
    resinMassG: "132",
    resinCost: "4.5",
    resinCostSource: "ctb",
    resinCostLabel: "slicer",
    resinDensityGPerMl: "1.1",
    layerCount: 1200,
    layerHeightMm: "0.05",
    modelHeightMm: "60",
    exposureSeconds: "2.5",
    bottomExposureSeconds: "30",
    lightOffSeconds: "1",
    bottomLightOffSeconds: "1",
    bottomLayerCount: 6,
    liftDistanceMm: "7",
    liftSpeedMmPerMin: "60",
    bottomLiftDistanceMm: "7",
    bottomLiftSpeedMmPerMin: "40",
    retractSpeedMmPerMin: "150",
    resolutionX: 7680,
    resolutionY: 4320,
    printerProfile: "Mighty 8K",
    hubspotSyncedAt: "2026-08-04T10:00:00.000Z",
    attachedAt: "2026-08-04T10:00:00.000Z",
    ...overrides,
  };
}

function sampleContext(): OwnerDigestContext {
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
        requiresPlates: true,
        closeDate: "2026-08-10",
      },
      {
        dealId: "d2",
        dealName: "Display base",
        stageId: "printing",
        stage: "Printing",
        amount: 80,
        contactName: "Ada",
        hasPlates: true,
        promptAttachPlates: false,
        requiresPlates: true,
        closeDate: null,
      },
    ],
    closedDeals: [],
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
    fleet: sampleFleet(),
    resin: sampleResin(),
    recentPlates: [samplePlate()],
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

test("owner digest includes do-first, next print, production, fleet, resin", () => {
  const ctx = sampleContext();
  const built = buildOwnerDigestText(ctx, { PUBLIC_BASE_URL: "https://example.com" }, {
    now: new Date("2026-08-05T12:00:00.000Z"),
  });
  const text = built.text;

  assert.match(text, /Print Ops — morning briefing/);
  assert.match(text, /DO FIRST/);
  assert.match(text, /Review 2 submitted buyer form/);
  assert.match(text, /NEXT PRINT/);
  assert.match(text, /Knight bust/);
  assert.match(text, /due Aug 10/);
  assert.match(text, /IN PRODUCTION/);
  assert.match(text, /DisplayBase_P1\.ctb/);
  assert.match(text, /FLEET/);
  assert.match(text, /Mighty 8K A/);
  assert.match(text, /FEP ~/);
  assert.match(text, /RESIN/);
  assert.match(text, /ABS-Like Grey/);
  assert.match(text, /Low sealed/);
  assert.match(text, /Open:/);
  assert.match(text, /<a href="https:\/\/example\.com\/#\/printers">Printers<\/a>/);
  assert.doesNotMatch(text, /Printers: https:\/\//);
  assert.ok(built.inlineKeyboard.length >= 1);
});

test("next print candidates prefer deals missing plates by close date", () => {
  const next = nextPrintCandidates(sampleContext().snapshot);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.dealId, "d1");
});

test("plates on open orders ignore closed-deal history", () => {
  const ctx = sampleContext();
  const rows = platesOnOpenOrders(ctx.snapshot, [
    samplePlate(),
    samplePlate({
      id: 2,
      hubspotDealId: "closed-old",
      hubspotDealName: "Old order",
      fileName: "Old.ctb",
      attachedAt: "2026-08-05T01:00:00.000Z",
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dealId, "d2");
  assert.equal(rows[0]!.fileName, "DisplayBase_P1.ctb");
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

  const result = await sendTelegramMessage(
    "hello",
    {
      TELEGRAM_BOT_TOKEN: "123:AA-token",
      TELEGRAM_CHAT_ID: "99",
    },
    { fetchImpl },
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messageId, 9);
  assert.match(calls[0]!.url, /api\.telegram\.org\/bot123:AA-token\/sendMessage/);
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.chat_id, "99");
  assert.equal(body.text, "hello");
  assert.equal(body.parse_mode, "HTML");
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
