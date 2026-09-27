/**
 * Browser layout gate. Serves the production build, stubs shop APIs, and checks
 * the shell and the main boards at 1440×900 and 390×844.
 *
 * Requires `npm run build` first (dist/index.cjs). Uses Chrome when it is
 * installed, otherwise the Playwright Chromium build.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";
import { indexZipRows } from "../shared/order-origins";
import { buildShopDashboard } from "../shared/shop-dashboard";
import { overheadForPeriod } from "../server/lib/expenses";

const { chromium } = playwright;

const TODAY = "2026-09-25";
const EXPENSE_FIXTURE = [
  { currency: "USD", amount_cents: 1200, cadence: "monthly", start_date: "2026-09-01", end_date: null, payment_count: null, category: "Models/Patreon" },
  { currency: "USD", amount_cents: 9999, cadence: "yearly", start_date: "2026-01-01", end_date: null, payment_count: null, category: "Software/AI" },
  { currency: "USD", amount_cents: 8500, cadence: "monthly", start_date: "2026-06-01", end_date: null, payment_count: null, category: "Equipment" },
  { currency: "USD", amount_cents: 4200, cadence: "one-off", start_date: "2026-09-15", end_date: null, payment_count: null, category: "Materials" },
] as any;
const artifactsDir = process.env.ARTIFACTS_DIR;
function artifactPath(name: string) {
  return artifactsDir ? `${artifactsDir}/${name}` : undefined;
}

function queueItem(
  id: string,
  bucket: string,
  amount: number,
  extra: { tentative?: boolean; shipBySource?: "override" | "derived"; shipPlanNote?: string | null } = {},
) {
  return {
    dealId: id,
    dealName: `Order ${id} - Ada`,
    stageId: "print",
    stage: "Printing",
    amount,
    shipBy: "2026-10-02",
    shipBySource: extra.shipBySource ?? "derived",
    tentative: extra.tentative === true,
    shipByReason: "plan",
    addressStatus: "ready",
    addressSummary: "Seattle, WA",
    chaseDraft: "",
    shippingRequired: true,
    closeDate: null,
    contactName: "Ada",
    hasPlates: bucket !== "next_print",
    requiresPlates: true,
    plateCount: bucket === "next_print" ? 0 : 1,
    totalPrintTimeSeconds: 3600,
    assignedPrinterIds: [],
    assignedPrinterNames: [],
    unassignedPlateCount: 0,
    kitNeeded: 0,
    kitReprint: 0,
    shipPlanNote: extra.shipPlanNote ?? null,
    isStale: false,
    costsIncomplete: false,
    needsReply: false,
    readyToPack: false,
    bucket,
    fulfillment: { shipReady: false, readyPercent: 10 },
  };
}

function stackRow(partial: Record<string, unknown>) {
  return {
    key: "row",
    kind: "deal",
    rank: 1,
    manual: false,
    isNew: false,
    name: "Order",
    contactName: "Ada",
    stage: "Printing",
    bucket: "print",
    lane: "fly",
    blocker: "",
    blockerSource: "auto",
    nextStep: "",
    targetDate: "2026-10-02",
    targetSource: "derived",
    tentative: false,
    amount: 40,
    tier: "committed",
    shippingRequired: true,
    dealId: "d1",
    offbookId: null,
    bundleId: null,
    fulfillment: null,
    steps: [],
    members: [],
    ...partial,
  };
}

function deal(id: string, amount: number, cost: number) {
  const profit = amount - cost;
  return {
    dealId: id,
    dealName: id === "b2" ? "Cerastus Chassis - Castigator - Ada" : `Board ${id} - Ada`,
    promptAttachPlates: id === "b1",
    stageId: "print",
    stage: "Printing",
    amount,
    productionCost: cost,
    grossProfit: profit,
    marginPercentage: amount > 0 ? (profit / amount) * 100 : 0,
    costsComplete: true,
    hasPlates: true,
    requiresPlates: true,
    needsReply: false,
    shipByOverride: null,
    shipPlanNote: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    closeDate: null,
    contactName: "Ada",
  };
}

function dealOps(dealId: string) {
  return {
    ok: true,
    dealId,
    dealName: "Committed order - Ada",
    stageId: "print",
    stage: "Ready to Ship",
    amount: 80,
    closeDate: null,
    shipByOverride: null,
    shipPlanNote: null,
    costs: {
      amount: 80,
      material: "12",
      labor: "0",
      packaging: "0",
      shipping: "8",
      grossProfit: 60,
      marginPercentage: 75,
      costsComplete: true,
    },
    checklist: {
      dealId,
      addressVerified: false,
      costsEntered: true,
      labelBought: false,
      trackingPasted: false,
      packingDone: false,
      trackingNumber: "",
      notes: "",
      completedCount: 1,
      totalCount: 5,
      readyPercent: 20,
      shipReady: false,
      updatedAt: null,
    },
    plates: [{ id: 1, fileName: "plate.ctb", printerProfile: "MEGA 8K", assignedPrinterId: null, assignedPrinterName: null, printTimeSeconds: 3600, resinMassG: 40, attachedAt: "2026-09-20T00:00:00.000Z" }],
    packingSlip: {
      dealId,
      dealName: "Committed order - Ada",
      amount: 80,
      stage: "Ready to Ship",
      contact: { id: null, name: "Ada", email: "", phone: "", addressLines: ["1 Main"] },
      lines: [{ kind: "deal", label: "Committed order", detail: "plate" }],
      kitSummary: null,
      plateCount: 1,
      checklist: {
        dealId,
        addressVerified: false,
        costsEntered: true,
        labelBought: false,
        trackingPasted: false,
        packingDone: false,
        trackingNumber: "",
        notes: "",
        completedCount: 1,
        totalCount: 5,
        readyPercent: 20,
        shipReady: false,
        updatedAt: null,
      },
      generatedAt: "2026-09-25T19:39:00.000Z",
    },
    failures: [],
    stages: [{ id: "print", label: "Printing", closed: false }],
    printers: [],
    hubspotPortalId: "1",
    writeGate: { dryRun: true, allowWrites: false, liveWriteReady: false },
  };
}

const LIBRARY_FILES = [
  {
    driveFileId: "file-castigator",
    name: "Castigator_MEGA_8K.ctb",
    webViewLink: "https://drive.google.com/file/d/file-castigator/view",
    sizeBytes: 188743680,
    modifiedAt: "2026-09-26T20:00:00.000Z",
    mimeType: "application/octet-stream",
    extension: ".ctb",
    printer: "MEGA 8K",
    kit: "Castigator",
    customer: "Ada",
    kitTags: "Castigator",
    notes: "",
    source: "upload",
    orderKeys: ["deal:c1"],
  },
  {
    driveFileId: "file-raider",
    name: "Land_Raider_12K.ctb",
    webViewLink: "https://drive.google.com/file/d/file-raider/view",
    sizeBytes: 52428800,
    modifiedAt: "2026-09-20T18:00:00.000Z",
    mimeType: "application/octet-stream",
    extension: ".ctb",
    printer: "Mighty 12K",
    kit: "Land Raider",
    customer: "Daniel Ortega",
    kitTags: "Land Raider",
    notes: "",
    source: "indexed",
    orderKeys: ["deal:c2"],
  },
];

function bodyFor(input: string | URL) {
  const url = typeof input === "string" ? new URL(input, "http://layout.local") : input;
  const pathname = url.pathname;
  if (pathname.startsWith("/api/health")) {
    return {
      status: "ok",
      safety: { liveWriteReady: true },
      webhook: { verification: "configured" },
      hubspotSync: { issueCount: 0 },
      storage: {},
    };
  }
  if (pathname.startsWith("/api/performance")) {
    return {
      generatedAt: "2026-09-25T19:39:00.000Z",
      period: { days: 30, startsAt: "2026-08-26T00:00:00.000Z" },
      thresholds: { marginPercent: 40, staleDays: 14 },
      summary: {
        revenue: 0,
        grossProfit: 0,
        weightedMarginPercent: 0,
        orders: 2,
        averageOrderValue: 0,
        activeOrders: 2,
        attentionCount: 2,
      },
      intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
      supplySpend: { total: 0, orders: 0 },
      books: { supplySpend: 0, grossProfit: 0 },
      dashboard: (() => {
        const dashboard = buildShopDashboard({
        now: "2026-09-25T19:39:00.000Z",
        period: "30",
        awaitingClient: 1,
        supplyPurchases: [],
        bits: [{ status: "good" }, { status: "reprint" }],
        failures: [],
        printers: [
          { name: "Mighty 8K New", model: "Mighty 8K", fepChangedAt: "2026-08-01T00:00:00.000Z", hoursSinceFep: 42, recommendedFepHours: 80 },
          { name: "MEGA 8K", model: "MEGA 8K", fepChangedAt: null, hoursSinceFep: null, recommendedFepHours: null },
        ],
        plates: [
          { attachedAt: "2026-09-20T12:00:00.000Z", printTimeSeconds: 10800, resinVolumeMl: 80, resinCost: 12, printerLabel: "Mighty 8K New" },
          { attachedAt: "2026-09-18T12:00:00.000Z", printTimeSeconds: 7200, resinVolumeMl: 40, resinCost: 6, printerLabel: "Mighty 12K" },
        ],
        zips: indexZipRows([
          ["92101", "San Diego", "CA", 32.72, -117.16],
          ["10001", "New York", "NY", 40.75, -73.99],
        ]),
        orders: [
          {
            id: "ada",
            name: "Knight - Ada",
            customer: "Ada",
            createdAt: "2026-09-10T12:00:00.000Z",
            closedAt: "2026-09-18T12:00:00.000Z",
            open: false,
            won: true,
            lost: false,
            stageLabel: "Completed",
            amount: 180,
            resinCost: 22,
            postage: 9,
            packaging: 0,
            shipBy: "2026-09-20",
            tentative: false,
            needsReply: false,
            shipping: "ship",
            hasTracking: true,
            shipTo: { city: "San Diego", state: "CA", zip: "92101", country: "United States" },
          },
          {
            id: "bea",
            name: "Land Raider - Bea",
            customer: "Bea",
            createdAt: "2026-09-12T12:00:00.000Z",
            closedAt: null,
            open: true,
            won: false,
            lost: false,
            stageLabel: "Printing",
            amount: 240,
            resinCost: null,
            postage: null,
            packaging: 0,
            shipBy: "2026-09-20",
            tentative: false,
            needsReply: true,
            shipping: "ship",
            hasTracking: false,
            shipTo: { city: "New York", state: "NY", zip: "10001", country: "US" },
          },
          {
            id: "cal",
            name: "Sword - Cal",
            customer: "Cal",
            createdAt: "2026-09-14T12:00:00.000Z",
            closedAt: null,
            open: true,
            won: false,
            lost: false,
            stageLabel: "Printing",
            amount: 40,
            resinCost: 8,
            postage: 0,
            packaging: 0,
            shipBy: null,
            tentative: false,
            needsReply: false,
            shipping: "pickup",
            hasTracking: false,
            shipTo: null,
          },
        ],
        });
        const gross = dashboard.headlines.find((item) => item.id === "gross-profit")?.value ?? 0;
        const overhead = { id: "overhead", label: "Overhead", formula: "Recurring overhead prorated for the period, plus one-off expense charges.", value: overheadForPeriod(EXPENSE_FIXTURE, "2026-08-26", "2026-09-25") / 100, unit: "usd" as const, previous: null, compare: false, note: "30 days", series: [] };
        const net = { id: "net-profit", label: "Net profit after overhead", formula: "Gross profit minus period overhead.", value: Math.round((gross - overhead.value) * 100) / 100, unit: "usd" as const, previous: null, compare: false, note: "30 days", series: [] };
        dashboard.headlines.push(overhead, net);
        return dashboard;
      })(),
      pipeline: [
        { id: "print", label: "Printing", closed: false },
        { id: "done", label: "Completed", closed: true },
      ],
      attention: [
        {
          dealId: "a1",
          dealName: "Armigers",
          stage: "Printing",
          issue: "Missing plates",
          issueKey: "no_plates",
          detail: "No plate",
          severity: "warn",
        },
        {
          dealId: "a2",
          dealName: "Terrain",
          stage: "Printing",
          issue: "Costs incomplete",
          issueKey: "costs_incomplete",
          detail: "Costs",
          severity: "warn",
        },
      ],
      activeDeals: [deal("b1", 129.99, 0), deal("b2", 80, 30)],
      closedDeals: [],
      hubspotPortalId: "1",
    };
  }
  if (pathname.startsWith("/api/expenses")) {
    return {
      expenses: [
        { id: "monthly", vendor: "Patreon", name: "Creator membership", category: "Models/Patreon", amount_cents: 1200, currency: "USD", usd_amount_cents: null, cadence: "monthly", start_date: "2026-09-01", end_date: null, payment_count: null, payment_note: "", notes: "" },
        { id: "yearly", vendor: "Google One", name: "Storage", category: "Software/AI", amount_cents: 9999, currency: "USD", usd_amount_cents: null, cadence: "yearly", start_date: "2026-01-01", end_date: null, payment_count: null, payment_note: "", notes: "" },
        { id: "installment", vendor: "Affirm", name: "Printer financing", category: "Equipment", amount_cents: 8500, currency: "USD", usd_amount_cents: null, cadence: "monthly", start_date: "2026-06-01", end_date: null, payment_count: 12, payment_note: "", notes: "" },
        { id: "one-off", vendor: "Resin supplier", name: "Resin", category: "Materials", amount_cents: 4200, currency: "USD", usd_amount_cents: null, cadence: "one-off", start_date: "2026-09-15", end_date: null, payment_count: null, payment_note: "", notes: "" },
      ],
    };
  }
  if (pathname.startsWith("/api/priority-stack/updates")) {
    return {
      ok: true,
      orderKey: "deal:c1",
      entries: [
        {
          id: 1,
          orderKey: "deal:c1",
          createdAt: "2026-09-27T00:31:00.000Z",
          text: "Left leg supports failed. Reprint that piece before packing.",
          source: "voice",
          author: "Miguel",
        },
      ],
    };
  }
  if (pathname.startsWith("/api/priority-stack")) {
    const committed = stackRow({
      key: "committed",
      rank: 1,
      dealId: "c1",
      name: "Cerastus Chassis - Castigator - Ada",
      amount: 80,
      tier: "committed",
      stage: "Ready to Ship",
      fulfillment: {
        dealId: "c1",
        addressVerified: false,
        costsEntered: false,
        labelBought: false,
        trackingPasted: false,
        packingDone: false,
        trackingNumber: "",
        notes: "",
        completedCount: 1,
        totalCount: 5,
        readyPercent: 20,
        shipReady: false,
        updatedAt: null,
      },
    });
    const tentative = stackRow({
      key: "tentative",
      rank: 2,
      dealId: "c2",
      name: "Ikarus BA LR KIT - Daniel Ortega",
      contactName: "Daniel Ortega",
      amount: 1200,
      tier: "committed",
      stage: "Printing",
      tentative: true,
      targetDate: "2026-10-02",
    });
    const offbook = stackRow({
      key: "offbook",
      rank: 3,
      kind: "offbook",
      dealId: null,
      offbookId: 4,
      name: "Pickup piece",
      contactName: null,
      amount: null,
      tier: "committed",
      stage: "Queued to Print",
      shippingRequired: false,
      lane: "shop",
      steps: [{ label: "Print", done: false }],
    });
    const bundle = stackRow({
      key: "bundle",
      rank: 4,
      kind: "bundle",
      dealId: null,
      bundleId: 9,
      name: "Saturday pickup",
      amount: 45,
      tier: "stretch",
      stage: "Post-Process / QC",
      shippingRequired: false,
      blocker: "Bundle pickup runs long enough to crowd the mode label",
      members: [
        stackRow({ key: "m1", name: "Member one", contactName: "Daniel Ortega", amount: 15, dealId: "m1", blocker: "Failed piece reprint" }),
        stackRow({
          key: "m2",
          name: "Sword Brethren",
          contactName: "Wayne Hood",
          amount: 15,
          dealId: "m2",
          shippingRequired: false,
          blocker: "Pickup label must stay whole while this blocker ellipsizes",
        }),
        stackRow({
          key: "m3",
          name: "Member three",
          contactName: "Glenn Casey Chandler",
          amount: 15,
          dealId: "m3",
          blocker: "All bits plus Iron Warriors bits waiting on a reprint",
        }),
      ],
    });
    return {
      ok: true,
      generatedAt: "2026-09-25T19:39:00.000Z",
      today: TODAY,
      weekEnd: "2026-10-02",
      rows: [committed, tentative, offbook, bundle],
      outTheDoor: [
        stackRow({
          key: "shipped",
          name: "Shipped order",
          amount: 25,
          tier: "committed",
        }),
      ],
      totals: { committed: 1280, stretch: 45, later: 0, outTheDoor: 25, offBookUnpriced: 1 },
      hiddenCount: 0,
    };
  }
  if (pathname.startsWith("/api/production-queue")) {
    const nextPrint = [queueItem("q1", "next_print", 50), queueItem("q2", "next_print", 75)];
    const inProduction = [
      queueItem("q3", "in_production", 90, {
        tentative: true,
        shipBySource: "override",
        shipPlanNote: "Sun 9/27 at risk",
      }),
    ];
    return {
      ok: true,
      generatedAt: "2026-09-25T19:39:00.000Z",
      hubspotPortalId: "1",
      stages: [],
      printers: [],
      nextPrint,
      inProduction,
      shipReady: [],
      blocked: [],
      needsReply: [],
      readyToPack: [],
      recentFailures: [],
      summary: {
        nextPrint: nextPrint.length,
        inProduction: inProduction.length,
        shipReady: 0,
        blocked: 0,
        needsReply: 0,
        readyToPack: 0,
        needsAddress: 0,
        openOrders: 3,
      },
    };
  }
  if (pathname.startsWith("/api/deal-ops/")) {
    const dealId = pathname.split("/").pop() || "c1";
    return dealOps(dealId);
  }
  if (pathname.startsWith("/api/printers")) return { ok: true, printers: [] };
  if (pathname.startsWith("/api/resin-reorder")) return { buyNow: [], suggestions: [] };
  if (pathname.startsWith("/api/plate-files")) {
    if (url.searchParams.get("summary") === "1") {
      return { ok: true, total: LIBRARY_FILES.length, files: [], failures: [] };
    }
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const printer = url.searchParams.get("printer") || "";
    const orderKey = url.searchParams.get("orderKey") || "";
    const files = LIBRARY_FILES.filter((file) => {
      if (orderKey && !file.orderKeys.includes(orderKey)) return false;
      if (printer && file.printer !== printer) return false;
      if (!q) return true;
      return [file.name, file.kit, file.printer, file.customer, file.kitTags].join(" ").toLowerCase().includes(q);
    });
    return { ok: true, files, failures: [] };
  }
  if (pathname.startsWith("/api/google/drive")) {
    return { ok: true, configured: true, connected: false, email: "", reconnect: false };
  }
  return { ok: true };
}

function spread(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { min, max, delta: max - min };
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function boxes(root: playwright.Page | playwright.Locator, selector: string) {
  return root.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      const host = el.closest(".ops-tab") || el.closest(".ops-rail-link") || el.closest(".queue-lane") || el.parentElement;
      const hostRect = host ? host.getBoundingClientRect() : null;
      return {
        id: el.getAttribute("data-testid"),
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        right: rect.right,
        center: rect.left + rect.width / 2,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        rightInset: hostRect ? hostRect.right - rect.right : null,
        leftInset: hostRect ? rect.left - hostRect.left : null,
      };
    }),
  );
}

test("layout alignment at 1440 and 390", { timeout: 120_000 }, async () => {
  if (!existsSync("dist/index.cjs")) {
    const built = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(built.status, 0, "production build failed");
  }
  const port = await freePort();
  const child: ChildProcess = spawn("node", ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DRY_RUN: "true" },
    stdio: "ignore",
  });
  let browser: playwright.Browser | null = null;
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) break;
      } catch {
        // server still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({ deviceScaleFactor: 1, hasTouch: true });
    await context.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bodyFor(url)),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="badge-nav-floor"]')?.textContent?.trim() === "2",
    );
    await page.waitForFunction(
      () => document.querySelector('[data-testid="badge-nav-library"]')?.textContent?.trim() === "2",
    );
    await page.locator("[data-testid='link-nav-library']").waitFor();
    const assertOneStatsPage = async () => {
      await page.locator("[data-testid='stats-origin-svg']").waitFor();
      assert.equal(await page.locator("main [data-testid='page-transition']").count(), 1, "one page transition remains after navigation");
      assert.equal(await page.locator("main [data-testid='stats-origin-svg']").count(), 1, "one origin map remains after navigation");
    };
    await page.locator("[data-testid='link-nav-performance']").click();
    await assertOneStatsPage();
    if (artifactPath("stats-nav-1440.png")) await page.screenshot({ path: artifactPath("stats-nav-1440.png")!, fullPage: true });
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });

    const nav = await boxes(page, '[data-count-slot="nav"]');
    assert.ok(nav.length >= 3, "nav count slots rendered");
    const navRight = spread(nav.map((box) => box.right));
    const navCenter = spread(nav.map((box) => box.center));
    check(navRight.delta <= 1, `nav right edges differ by ${navRight.delta}`);
    check(navCenter.delta <= 1, `nav centers differ by ${navCenter.delta}`);
    for (const box of nav) {
      check(Math.abs(box.width - 24) <= 1, `${box.id} width ${box.width}`);
      check(Math.abs(box.height - 20) <= 1, `${box.id} height ${box.height}`);
    }

    const kpiInsets = await page.locator("[data-testid^='kpi-'] p.numeric").evaluateAll((els) =>
      els.map((el) => {
        const card = el.closest("article");
        const rect = el.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        return cardRect ? rect.left - cardRect.left : 0;
      }),
    );
    check(kpiInsets.length >= 4, "KPI values missing");
    check(spread(kpiInsets).delta <= 1, `KPI value insets differ by ${spread(kpiInsets).delta}`);

    const floorText = await page.locator("body").innerText();
    assert.equal(/calendar/i.test(floorText), false);
    assert.equal(/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(floorText), false);
    await page.locator("[data-testid='row-floor-next-1']").first().waitFor();
    const upNext = await page.locator("[data-testid='row-floor-next-1']").first().innerText();
    check(upNext.split("Ada").length - 1 === 1, `floor up-next repeats the client: ${upNext}`);
    const upNextCols = await page.locator("[data-testid='page-transition']").last().locator("[data-testid^='row-floor-next-']").evaluateAll((rows) =>
      rows
        .filter((row) => row.getClientRects().length > 0)
        .map((row) => {
          const chip = row.children[2] as HTMLElement | undefined;
          const date = row.children[3] as HTMLElement | undefined;
          const amount = row.children[4] as HTMLElement | undefined;
          return {
            chip: chip?.getBoundingClientRect().left ?? 0,
            chipRight: chip?.getBoundingClientRect().right ?? 0,
            date: date?.getBoundingClientRect().left ?? 0,
            dateRight: date?.getBoundingClientRect().right ?? 0,
            amount: amount?.getBoundingClientRect().right ?? 0,
            amountLeft: amount?.getBoundingClientRect().left ?? 0,
            chipClip: chip ? chip.scrollWidth - chip.clientWidth : 0,
            dateClip: date ? date.scrollWidth - date.clientWidth : 0,
          };
        }),
    );
    check(upNextCols.length >= 3, "floor up-next rows missing");
    check(spread(upNextCols.map((row) => row.chip)).delta <= 0.5, `up-next chip left edges differ by ${spread(upNextCols.map((row) => row.chip)).delta}`);
    check(spread(upNextCols.map((row) => row.date)).delta <= 0.5, `up-next date left edges differ by ${spread(upNextCols.map((row) => row.date)).delta}`);
    check(spread(upNextCols.map((row) => row.amount)).delta <= 0.5, `up-next amount right edges differ by ${spread(upNextCols.map((row) => row.amount)).delta}`);
    for (const row of upNextCols) {
      check(row.chipRight <= row.date + 0.5, "up-next chip runs into the date column");
      check(row.dateRight <= row.amountLeft + 0.5, "up-next date runs into the amount column");
      check(row.chipClip <= 0.5, "up-next chip is clipped");
      check(row.dateClip <= 0.5, "up-next date is clipped");
    }
    const readUpNextNames = () =>
      page.locator("[data-testid='page-transition']").last().locator("[data-testid^='row-floor-next-']").evaluateAll((rows) =>
        rows
          .filter((row) => row.getClientRects().length > 0)
          .map((row) => {
            const name = row.children[1] as HTMLElement | undefined;
            const box = name?.getBoundingClientRect();
            const overflow: string[] = [];
            if (name && box) {
              const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
              let node = walker.nextNode();
              while (node) {
                const text = (node.textContent || "").replace(/\s+/g, " ").trim();
                if (text) {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  for (const rect of range.getClientRects()) {
                    if (rect.width < 0.5 || rect.height < 0.5) continue;
                    if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5 || rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5) {
                      overflow.push(`${text} ${Math.round(rect.width)}/${Math.round(box.width)}`);
                    }
                  }
                }
                node = walker.nextNode();
              }
            }
            const client = name?.querySelector(".floor-next-client") as HTMLElement | null;
            let clientWidth = 0;
            if (client && box) {
              const range = document.createRange();
              range.selectNodeContents(client);
              for (const rect of range.getClientRects()) {
                if (rect.width < 0.5 || rect.height < 0.5) continue;
                clientWidth = Math.max(clientWidth, rect.width);
                if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5) overflow.push(`client ${Math.round(rect.width)}/${Math.round(box.width)}`);
              }
            }
            return {
              text: (name?.textContent || "").replace(/\s+/g, " ").trim(),
              overflow,
              scroll: name?.scrollWidth ?? 0,
              box: name?.clientWidth ?? 0,
              client: (client?.textContent || "").replace(/\s+/g, " ").trim(),
              clientWidth,
            };
          }),
      );
    const desktopNames = await readUpNextNames();
    check(
      desktopNames.some((row) => row.text.includes("Ikarus BA LR KIT") && row.client.includes("Daniel Ortega")),
      "Ikarus up-next row missing",
    );
    for (const row of desktopNames) {
      check(row.overflow.length === 0, `desktop up-next name clipped: ${row.text} ${row.overflow.join("|")}`);
      check(row.scroll <= row.box + 0.5, `desktop up-next name clipped (${row.scroll} > ${row.box}): ${row.text}`);
      if (row.client) check(row.clientWidth > 0 && row.clientWidth <= row.box + 0.5, `desktop up-next client ellipsized (${row.clientWidth}/${row.box}): ${row.client}`);
    }

    const current = () => page.locator("[data-testid='page-transition']").last();
    const checkStackGrid = async (label: string) => {
      await current().locator("[data-testid='button-open-bundle']").first().evaluate((el) => (el as HTMLElement).click());
      await current().locator("[data-testid='text-bundle-progress-bundle']").first().waitFor({ state: "attached" });
      const bundleProg = await current().locator("[data-testid='text-bundle-progress-bundle']").evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect();
          return `${(el.textContent || "").trim()} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }),
      );
      check(
        bundleProg.some((text) => text.startsWith("0/3 ") && !text.includes(" 0x0")),
        `${label} bundle count was ${bundleProg.join("|")}`,
      );
      const fractions = await current().locator("[data-testid='text-checklist-progress-committed']").allInnerTexts();
      check(fractions.some((text) => text.trim() === "1/5"), `${label} stack checklist was ${fractions.join("|")}`);
      const money = await boxes(current(), ".stack-row > .stack-money");
      assert.ok(money.length >= 3, `${label} stack amounts missing`);
      const moneyRight = spread(money.map((box) => box.right));
      check(moneyRight.delta <= 0.5, `${label} stack amount right edges differ by ${moneyRight.delta}`);
      if (label === "desktop") {
        const templates = await current().locator(".stack-row").evaluateAll((els) => {
          const visible = els.filter((el) => el.getClientRects().length > 0);
          return [...new Set(visible.map((el) => getComputedStyle(el).gridTemplateColumns))];
        });
        check(templates.length === 1, `${label} stack grids differ: ${templates.join(" | ")}`);
      }
    };
    const settlePage = () =>
      page.locator("[data-testid='button-open-committed']:visible").last().waitFor({ state: "visible" });
    const openDrawer = async () => {
      // A fast tab change leaves exiting Stack copies in the crossfade. Clicking
      // one of those opens a drawer that unmounts when the copy finishes leaving.
      await settlePage();
      await page.locator("[data-testid='button-open-committed']:visible").last().click();
      await page.locator("[data-testid='drawer-deal-ops'] h2").waitFor();
      await page.waitForFunction(() => {
        const el = document.querySelector("[data-testid='drawer-deal-ops']");
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const phone = window.innerWidth < 768;
        const docked = phone
          ? rect.left <= 1 && rect.top <= 1 && rect.right >= window.innerWidth - 2
          : rect.right >= window.innerWidth - 2 && rect.right <= window.innerWidth + 2 && rect.left > window.innerWidth * 0.4 && rect.top >= 40;
        return rect.width > 200 && docked && rect.bottom <= window.innerHeight + 2;
      });
    };
    const checkLibrary = async (label: string) => {
      await page.goto(`${base}/#/library`, { waitUntil: "domcontentloaded" });
      const root = current();
      await root.locator("[data-testid='library-row-file-castigator']").waitFor();
      await root.locator("[data-testid='library-row-file-raider']").waitFor();
      const sizes = await root.locator("[data-testid='library-file-size']").evaluateAll((els) =>
        els.filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect().right),
      );
      check(sizes.length >= 2, `${label} library sizes missing`);
      check(spread(sizes).delta <= 0.5, `${label} library size edges differ by ${spread(sizes).delta}`);
      const pageScroll = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, inner: window.innerWidth }));
      check(pageScroll.width <= pageScroll.inner + 1, `${label} library scrolls horizontally (${pageScroll.width} > ${pageScroll.inner})`);
      const listBox = await root.locator("[data-testid='library-list']").evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        right: el.getBoundingClientRect().right,
      }));
      check(listBox.scroll <= listBox.client + 1, `${label} library list clipped (${listBox.scroll} > ${listBox.client})`);
      check(listBox.right <= pageScroll.inner + 1, `${label} library list runs off screen`);
      const text = await root.locator("[data-testid='page-library']").innerText();
      check(!/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(text), `${label} library has dev text`);
      check(/Sep 26/.test(text) && !/\d{1,2}\/\d{1,2}/.test(text), `${label} library date was ${text}`);
      await root.locator("[data-testid='input-library-search']").fill("Castigator");
      await root.locator("[data-testid='library-row-file-raider']").waitFor({ state: "hidden" });
      await root.locator("[data-testid='library-row-file-castigator']").waitFor();
      await root.locator("[data-testid='input-library-search']").fill("");
      await root.locator("[data-testid='library-row-file-raider']").waitFor();
      await root.locator("[data-testid='chip-library-printer-mighty-12k']").click();
      await root.locator("[data-testid='library-row-file-castigator']").waitFor({ state: "hidden" });
      await root.locator("[data-testid='library-row-file-raider']").waitFor();
      await root.locator("[data-testid='input-library-search']").fill("zzzz-not-a-plate");
      await root.locator("[data-testid='text-library-empty']").waitFor();
      const empty = await root.locator("[data-testid='text-library-empty']").innerText();
      check(/Upload/.test(empty) && /Google Drive/.test(empty), `${label} empty library copy was ${empty}`);
      check(!/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(empty), `${label} empty library has dev text`);
      const switchCount = await page.locator("[data-testid='switch-prints-library']").evaluateAll((els) =>
        els.filter((el) => el.getClientRects().length > 0).length,
      );
      if (label === "phone") {
        check(switchCount === 1, "phone Prints | Library switch is missing");
        const segments = await page.locator("[data-testid='switch-prints-library'] a").evaluateAll((els) =>
          els.filter((el) => el.getClientRects().length > 0).map((el) => ({
            text: (el.textContent || "").trim(),
            active: el.getAttribute("data-active"),
            right: el.getBoundingClientRect().right,
            height: el.getBoundingClientRect().height,
          })),
        );
        check(segments.map((segment) => segment.text).join("|") === "Prints|Library", `phone switch was ${segments.map((segment) => segment.text).join("|")}`);
        check(segments[1]?.active === "true", "phone Library segment is not selected");
        check(segments.every((segment) => segment.height >= 32 && segment.height <= 40), `phone switch height was ${segments.map((segment) => segment.height).join(",")}`);
        const inner = await page.evaluate(() => window.innerWidth);
        check(segments.every((segment) => segment.right <= inner + 1), "phone switch runs off screen");
        const printsTab = await page.locator("[data-testid='link-phone-prints']").getAttribute("data-active");
        check(printsTab === "true", "phone Prints tab is not selected on Library");
        const tabLabels = await page.locator(".ops-tabbar > .ops-tab").evaluateAll((els) =>
          els.map((el) => {
            const spans = [...el.querySelectorAll(":scope > span")];
            return (spans[spans.length - 1]?.textContent || "").trim();
          }),
        );
        check(tabLabels.join("|") === "Floor|Stack|Queue|Prints|More", `phone tabs were ${tabLabels.join("|")}`);
      } else {
        check(switchCount === 0, "desktop shows the phone Prints | Library switch");
      }
      await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
      await page.goto(`${base}/#/library?orderKey=${encodeURIComponent("deal:c1")}`, { waitUntil: "domcontentloaded" });
      const filtered = current();
      await filtered.locator("[data-testid='library-row-file-castigator']").waitFor();
      await filtered.locator("[data-testid='library-row-file-raider']").waitFor({ state: "hidden" });
      const orderChip = (await filtered.locator("[data-testid='chip-library-order']").innerText()).replace(/\s+/g, " ").trim();
      check(orderChip === "Deal c1", `${label} library order chip was ${orderChip}`);
    };
    const checkDrawer = async (label: string) => {
      await openDrawer();
      await page.locator("[data-testid='text-drawer-floor']").waitFor();
      const drawerCount = await page.locator("[data-testid='text-drawer-floor']").innerText();
      check(/1\/5/.test(drawerCount), `${label} drawer floor status was ${drawerCount}`);
      const customer = await page.locator("[data-testid='drawer-customer']").innerText();
      check(/Ada/.test(customer), `${label} drawer customer was ${customer}`);
      const amount = await page.locator("[data-testid='drawer-amount']").innerText();
      check(/\$80/.test(amount), `${label} drawer amount was ${amount}`);
      const stage = await page.locator("[data-testid='drawer-stage']").innerText();
      check(/Ready to Ship/.test(stage), `${label} drawer stage was ${stage}`);
      await page.locator("[data-testid='drawer-plates']").getByText("plate.ctb").waitFor();
      const shipBy = await page.locator("[data-testid='drawer-ship-by']").innerText();
      check(/Oct 2/.test(shipBy) && !/\d{1,2}\/\d{1,2}/.test(shipBy), `${label} drawer ship-by was ${shipBy}`);
      const focused = await page.waitForFunction(() => {
        const drawer = document.querySelector("[data-testid='drawer-deal-ops']");
        return Boolean(drawer && drawer.contains(document.activeElement));
      }).then(() => true).catch(() => false);
      check(focused, `${label} focus did not move into the drawer`);
      const hit = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("[data-testid='button-close-deal-ops-drawer']")];
        const boxes = buttons.map((el) => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const inside = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
          const node = inside ? document.elementFromPoint(x, y) : null;
          const owned = Boolean(node && (node === el || el.contains(node)));
          return {
            x: Math.round(x),
            y: Math.round(y),
            inside,
            owned,
            hit: node?.getAttribute("data-testid") || node?.tagName || "none",
          };
        });
        const visible = boxes.filter((box) => box.inside);
        if (visible.length === 0) return `no on-screen close ${JSON.stringify(boxes)}`;
        if (!visible.every((box) => box.owned)) return `miss ${JSON.stringify(visible)}`;
        return "ok";
      });
      check(hit === "ok", `${label} close button is not the element under its center (${hit})`);
      const order = await page.locator("[data-testid='drawer-deal-ops']").evaluate((drawer) => {
        const title = drawer.querySelector("h2");
        const updates = drawer.querySelector("[data-testid='order-updates']");
        if (!title || !updates) return false;
        return title.getBoundingClientRect().top < updates.getBoundingClientRect().top;
      });
      check(order, `${label} drawer title is not above Updates`);
      await page.locator("[data-testid='order-updates']").waitFor();
      const stamp = (await page.locator("[data-testid='order-update-time']").first().innerText()).replace(/\s+/g, " ").trim();
      check(stamp === "Sep 26, 5:31 PM", `${label} update time was ${stamp}`);
      const update = await page.locator("[data-testid='order-update-text']").first().innerText();
      check(/Left leg supports failed/.test(update), `${label} update text was ${update}`);
      const source = (await page.locator("[data-testid='order-update-source']").first().innerText()).trim().toLowerCase();
      check(source === "voice", `${label} update source was ${source}`);
      const updateBox = await page.locator("[data-testid='order-update-text']").first().evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { right: rect.right, width: window.innerWidth, scroll: el.scrollWidth, client: el.clientWidth };
      });
      check(updateBox.right <= updateBox.width + 1, `${label} update text runs off screen`);
      check(updateBox.scroll <= updateBox.client + 1, `${label} update text is clipped`);
      await page.locator("[data-testid='slice-files']").waitFor();
      const sliceName = await page.locator("[data-testid='slice-file-name']").first().innerText();
      check(/Castigator_MEGA_8K\.ctb/.test(sliceName), `${label} slice name was ${sliceName}`);
      const filesHeading = (await page.locator("[data-testid='slice-files'] h3").innerText()).trim();
      check(filesHeading === "Files", `${label} files heading was ${filesHeading}`);
      const seeLibrary = (await page.locator("[data-testid='link-see-in-library']").getAttribute("href")) || "";
      check(/library/.test(seeLibrary) && /orderKey/.test(seeLibrary) && /c1/.test(seeLibrary), `${label} see-in-library href was ${seeLibrary}`);
      const sliceBox = await page.locator("[data-testid='slice-file-name']").first().evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const drawer = el.closest("[data-testid='drawer-deal-ops']")?.getBoundingClientRect();
        return { right: rect.right, drawerRight: drawer?.right ?? window.innerWidth, scroll: el.scrollWidth, client: el.clientWidth };
      });
      check(sliceBox.right <= sliceBox.drawerRight + 1, `${label} slice name runs off the drawer`);
      check(sliceBox.scroll <= sliceBox.client + 1, `${label} slice name is clipped`);
      const drawerText = await page.locator("[data-testid='drawer-deal-ops']").innerText();
      check(!/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(drawerText), `${label} drawer has dev text`);
      await page.locator("[data-testid='button-close-deal-ops-drawer']").evaluate((el) => (el as HTMLElement).click());
      await page.locator("[data-testid='drawer-deal-ops']").waitFor({ state: "hidden" });
      await openDrawer();
      await page.keyboard.press("Escape");
      await page.locator("[data-testid='drawer-deal-ops']").waitFor({ state: "hidden" });
      if (label === "desktop") {
        await openDrawer();
        await page.locator("[data-testid='button-deal-ops-scrim']").click({ position: { x: 24, y: 160 } });
        await page.locator("[data-testid='drawer-deal-ops']").waitFor({ state: "hidden" });
      }
    };

    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='stack-row-committed']").first().waitFor();
    await checkStackGrid("desktop");
    const tentativeLabels = await current().locator("[data-testid='button-target-tentative']").allInnerTexts();
    check(tentativeLabels.length > 0, "tentative date missing");
    for (const tentative of tentativeLabels) {
      check(/Oct 2 · tentative/.test(tentative), `tentative label was ${tentative}`);
      check(!/· plan/.test(tentative) && !/\d{1,2}\/\d{1,2}/.test(tentative), `tentative label was ${tentative}`);
    }
    await current().getByTestId("text-bundle-hint").first().waitFor();
    assert.equal(await current().locator("[data-testid='button-bundle-selected']").count(), 0);
    const stackText = await current().getByTestId("stack-list").first().innerText();
    assert.equal(/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(stackText), false);
    const cash = await current().getByTestId("stack-totals").first().innerText();
    assert.match(cash, /\$1,280/);
    assert.match(cash, /\$25/);
    assert.match(cash, /\$1,305/);
    await checkDrawer("desktop");
    await checkLibrary("desktop");

    await page.goto(`${base}/#/queue`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='column-next-print']").first().waitFor();
    assert.equal(await current().locator("[data-testid='column-in-production']").count(), 1);
    assert.equal(await current().locator("[data-testid='column-ship-ready']").count(), 0);
    assert.equal(await current().locator("[data-testid='column-blocked']").count(), 0);
    const queueLanes = await current().locator(".queue-lane").evaluateAll((lanes) =>
      lanes.map((lane) => {
        const header = lane.querySelector(".queue-lane-header .queue-amount");
        const rows = [...lane.querySelectorAll(".scan-facts .queue-amount")];
        return {
          rights: [header, ...rows].filter((el): el is Element => Boolean(el)).map((el) => el.getBoundingClientRect().right),
          headerColor: header ? getComputedStyle(header).color : "",
          rowColor: rows[0] ? getComputedStyle(rows[0]).color : "",
        };
      }),
    );
    for (const lane of queueLanes) {
      if (lane.rights.length >= 2) check(spread(lane.rights).delta <= 0.5, `queue amount edges differ by ${spread(lane.rights).delta}`);
      if (lane.rowColor) check(lane.headerColor === lane.rowColor, `queue total color ${lane.headerColor} vs row ${lane.rowColor}`);
    }
    const productionText = await current().locator("[data-testid='column-in-production']").first().evaluate((el) => el.textContent || "");
    check(/Oct 2 · tentative/.test(productionText), `queue tentative label was ${productionText}`);
    check(!/Oct 2 · set/.test(productionText), `queue tentative label was ${productionText}`);
    check(/Sun 9\/27 at risk/.test(productionText), "queue note was rewritten");
    const nextText = await current().locator("[data-testid='column-next-print']").first().evaluate((el) => el.textContent || "");
    check(/Oct 2 · plan/.test(nextText), `queue plan label was ${nextText}`);
    const queueTitle = await current().locator("[data-testid='button-queue-deal-q1'] .board-name").first().evaluate((el) => (el.textContent || "").trim());
    check(queueTitle === "Order q1", `queue title still includes the client: ${queueTitle}`);
    const queueCard = await current().locator("[data-testid='button-queue-deal-q1']").first().evaluate((el) => el.textContent || "");
    check(queueCard.split("Ada").length - 1 === 1, `queue card repeats the client: ${queueCard}`);

    await page.goto(`${base}/#/deals`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='text-deal-paid-b1']").first().waitFor();
    const orderEdges = await current().locator("[data-testid^='column-deal-stage-']").evaluateAll((lanes) =>
      lanes.map((lane) =>
        [...lane.querySelectorAll(".order-figs")].map((figs) =>
          [...figs.querySelectorAll(".order-fig-value")].map((el) => ({
            right: el.getBoundingClientRect().right,
            height: el.getBoundingClientRect().height,
            color: getComputedStyle(el).color,
          })),
        ),
      ),
    );
    const printing = orderEdges.find((groups) => groups.length >= 2) ?? [];
    check(printing.length >= 3, "order figures missing");
    for (const index of [0, 1, 2]) {
      const rights = printing.map((group) => group[index]?.right).filter((value): value is number => value != null);
      check(spread(rights).delta <= 0.5, `order figure column ${index} edges differ by ${spread(rights).delta}`);
    }
    const profitFigs = printing.flatMap((group) => (group[2] ? [group[2]] : []));
    for (const fig of profitFigs) {
      check(fig.height <= 22, `profit wrapped to ${fig.height}px`);
      check(fig.color === "rgb(61, 184, 139)", `profit color was ${fig.color}`);
    }
    const figureText = await current().locator(".order-figs").evaluateAll((groups) =>
      groups
        .filter((figs) => figs.getClientRects().length > 0)
        .map((figs) => {
          const cells = [...figs.querySelectorAll(":scope > p")];
          const items: Array<{ text: string; left: number; right: number; top: number; bottom: number; cellLeft: number; cellRight: number; cellTop: number; cellBottom: number }> = [];
          for (const cell of cells) {
            const box = cell.getBoundingClientRect();
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node) {
              const text = node.textContent?.trim() ?? "";
              if (text) {
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const rect of range.getClientRects()) {
                  if (rect.width >= 0.5 && rect.height >= 0.5) {
                    items.push({
                      text,
                      left: rect.left,
                      right: rect.right,
                      top: rect.top,
                      bottom: rect.bottom,
                      cellLeft: box.left,
                      cellRight: box.right,
                      cellTop: box.top,
                      cellBottom: box.bottom,
                    });
                  }
                }
              }
              node = walker.nextNode();
            }
          }
          return items;
        }),
    );
    check(figureText.length >= 3, "order figure text missing");
    for (const items of figureText) {
      check(items.length >= 3, "order figure text nodes missing");
      for (const item of items) {
        // Line boxes run about a pixel outside the cell. Horizontal spill is the overlap bug.
        const outside =
          item.left < item.cellLeft ||
          item.right > item.cellRight ||
          item.top < item.cellTop ||
          item.bottom > item.cellBottom;
        check(!outside, `figure text "${item.text}" leaves its cell`);
      }
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const overlapW = Math.min(items[i].right, items[j].right) - Math.max(items[i].left, items[j].left);
          const overlapH = Math.min(items[i].bottom, items[j].bottom) - Math.max(items[i].top, items[j].top);
          check(overlapW <= 1 || overlapH <= 2, `figure text "${items[i].text}" overlaps "${items[j].text}"`);
        }
      }
    }
    const profitText = await current().locator("[data-testid='text-deal-revenue-b1']").first().evaluate((el) => el.textContent || "");
    check(/\$129\.99/.test(profitText) && /100%/.test(profitText), `profit cell was ${profitText}`);
    check(!/\$129\.99\s*·\s*100%/.test(profitText), `profit percent is still on the money line: ${profitText}`);
    const chip = await current().locator("[data-testid='chip-deal-b1']").first().evaluate((el) => {
      const label = el.querySelector("span") ?? el;
      return {
        text: (label.textContent || "").replace(/\s+/g, " ").trim(),
        scroll: label.scrollWidth,
        client: label.clientWidth,
      };
    });
    check(chip.text === "Needs plates", `chip text was ${chip.text}`);
    check(chip.scroll <= chip.client + 0.5, `chip clipped (${chip.scroll} > ${chip.client})`);
    const cardTitle = await current().locator("[data-testid='link-deal-title-b1']").first().evaluate((el) => el.textContent || "");
    check(!cardTitle.includes("Ada"), `order title still includes the client: ${cardTitle}`);
    const cardText = await current().locator("[data-testid='card-deal-b1']").first().evaluate((el) => el.textContent || "");
    check(cardText.split("Ada").length - 1 === 1, `order card repeats the client: ${cardText}`);
    const longTitle = await current().locator("[data-testid='link-deal-title-b2']").first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const overflow: string[] = [];
      let lines = 0;
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent?.trim() ?? "";
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width < 0.5 || rect.height < 0.5) continue;
            lines += 1;
            if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5 || rect.bottom > box.bottom + 0.5) overflow.push(text);
          }
        }
        node = walker.nextNode();
      }
      return { text: (el.textContent || "").trim(), lines, overflow };
    });
    check(longTitle.text === "Cerastus Chassis - Castigator", `order title was ${longTitle.text}`);
    check(longTitle.lines >= 1 && longTitle.lines <= 2, `order title used ${longTitle.lines} lines`);
    check(longTitle.overflow.length === 0, `order title clipped: ${longTitle.overflow.join("|")}`);
    await current().locator("[data-testid='toggle-orders-view']").last().getByRole("button", { name: "Table" }).click();
    await current().locator("[data-testid='text-table-profit-b1']").first().waitFor();
    const tableProfit = await current().locator("[data-testid='text-table-profit-b1']").first().evaluate((el) => getComputedStyle(el).color);
    check(tableProfit === "rgb(61, 184, 139)", `table profit color was ${tableProfit}`);

    if (artifactsDir) mkdirSync(artifactsDir, { recursive: true });
    await page.goto(`${base}/#/performance`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='stats-headlines']").waitFor();
    const desktopStats = await current().evaluate((root) => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      text: root.innerText,
      tops: Array.from(root.querySelectorAll("[data-testid^='headline-']")).slice(0, 3).map((el) => el.getBoundingClientRect().top),
      align: Array.from(root.querySelectorAll("[data-testid^='headline-'] .numeric")).map((el) => getComputedStyle(el).textAlign),
    }));
    check(desktopStats.scroll <= desktopStats.inner + 1, `desktop stats scrolls horizontally (${desktopStats.scroll})`);
    check(!/\bundefined\b|\bNaN\b/.test(desktopStats.text), "stats page shows a blank number");
    check(desktopStats.tops.length === 3 && Math.max(...desktopStats.tops) - Math.min(...desktopStats.tops) <= 1, "desktop headlines are not in one row");
    check(desktopStats.align.every((align) => align === "right"), "headline numbers are not right aligned");
    assert.match(await current().locator("[data-testid='headline-overhead']").innerText(), /30 days/);
    assert.match(await current().locator("[data-testid='headline-net-profit']").innerText(), /30 days/);
    await current().locator("[data-testid='stats-origin-svg']").waitFor();
    assert.equal(await current().locator("[data-testid='stats-origin-svg']").count(), 1, "desktop renders exactly one order-origin map");
    const desktopOrigin = await current().locator("[data-testid='stats-origin-map']").evaluate((card) => {
      const svg = card.querySelector("[data-testid='stats-origin-svg']")?.getBoundingClientRect();
      const legend = card.querySelector("[data-testid='stats-origin-legend']")?.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return {
        svgBottom: svg?.bottom ?? 0,
        svgWidth: svg?.width ?? 0,
        legendTop: legend?.top ?? 0,
        cardWidth: cardRect.width,
      };
    });
    check(desktopOrigin.legendTop >= desktopOrigin.svgBottom - 1, "desktop origin legend is not below the map");
    check(desktopOrigin.svgWidth <= desktopOrigin.cardWidth + 1, "desktop origin map is wider than the card");
    await page.locator("[data-testid='stats-origin-svg'] path").first().click();
    await page.locator("[data-testid='stats-origin-svg'] circle").last().click();
    if (artifactPath("stats-map-legend-1440.png")) await current().locator("[data-testid='stats-origin-map']").screenshot({ path: artifactPath("stats-map-legend-1440.png")! });
    await page.evaluate(() => {
      const saved: Array<[HTMLElement, string]> = [];
      const nodes = Array.from(document.querySelectorAll("[data-testid='page-transition']"));
      for (let index = 0; index < nodes.length; index += 1) {
        const el = nodes[index] as HTMLElement;
        if (index < nodes.length - 1) {
          saved.push([el, el.getAttribute("style") ?? ""]);
          el.style.display = "none";
        }
      }
      let node = (nodes[nodes.length - 1] as HTMLElement | undefined)?.parentElement ?? null;
      while (node) {
        saved.push([node, node.getAttribute("style") ?? ""]);
        node.style.overflow = "visible";
        node.style.height = "auto";
        node.style.maxHeight = "none";
        node = node.parentElement;
      }
      (window as unknown as { __statsShot?: Array<[HTMLElement, string]> }).__statsShot = saved;
    });
    if (artifactPath("stats-desktop-1440.png")) await page.screenshot({ path: artifactPath("stats-desktop-1440.png")!, fullPage: true });
    if (artifactPath("performance-overhead-1440.png")) await page.screenshot({ path: artifactPath("performance-overhead-1440.png")!, fullPage: true });
    await page.evaluate(() => {
      const saved = (window as unknown as { __statsShot?: Array<[HTMLElement, string]> }).__statsShot ?? [];
      for (const [el, css] of saved) {
        if (css) el.setAttribute("style", css);
        else el.removeAttribute("style");
      }
    });

    await page.goto(`${base}/#/expenses`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add expense" }).first().waitFor();
    if (artifactPath("expenses-desktop-1440.png")) await page.screenshot({ path: artifactPath("expenses-desktop-1440.png")!, fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid='badge-phone-floor']");
    const phone = await boxes(page, '[data-count-slot="phone"]');
    assert.ok(phone.length >= 1);
    for (const box of phone) {
      check(Math.abs(box.width - 24) <= 1 && Math.abs(box.height - 20) <= 1, `${box.id} is ${box.width}×${box.height}`);
    }
    check(spread(phone.map((box) => box.rightInset ?? 0)).delta <= 1, "phone badge insets differ");
    assert.equal(await page.locator("[data-testid='link-phone-orders']").count(), 0);
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    check(scroll.width <= scroll.inner + 1, `phone page scrolls horizontally (${scroll.width} > ${scroll.inner})`);
    const chipHeights = await page.locator(".stage-chip").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const height of chipHeights) check(height <= 28, `stage chip wrapped (${height}px)`);
    const phoneNames = await readUpNextNames();
    const phoneFirst = phoneNames.find((row) => /Cerastus Chassis - Castigator/.test(row.text));
    check(Boolean(phoneFirst), `phone up-next was ${phoneNames.map((row) => row.text).join(" | ")}`);
    check((phoneFirst?.text.split("Ada").length ?? 1) - 1 === 1, `phone up-next repeats the client: ${phoneFirst?.text}`);
    check(phoneNames.some((row) => row.text.includes("Ikarus BA LR KIT") && row.client.includes("Daniel Ortega")), "phone Ikarus up-next row missing");
    for (const row of phoneNames) {
      check(row.overflow.length === 0, `phone up-next name clipped: ${row.text} ${row.overflow.join("|")}`);
      check(row.scroll <= row.box + 0.5, `phone up-next name clipped (${row.scroll} > ${row.box}): ${row.text}`);
      if (row.client) check(row.clientWidth > 0 && row.clientWidth <= row.box + 0.5, `phone up-next client ellipsized (${row.clientWidth}/${row.box}): ${row.client}`);
    }

    await page.getByTestId("button-mobile-nav-more").click();
    await page.waitForSelector("[data-testid='panel-mobile-more']");
    const moreText = await page.locator("[data-testid='panel-mobile-more']").innerText();
    assert.equal(/\bOrders\b/.test(moreText), false);
    assert.equal(/\bLibrary\b/.test(moreText), false);
    await page.getByTestId("button-mobile-nav-more").click();
    await page.locator("[data-testid='panel-mobile-more']").waitFor({ state: "hidden" });

    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='stack-row-committed']").first().waitFor();
    await checkStackGrid("phone");
    const phoneRows = await current().locator("[data-testid^='stack-row-']").evaluateAll((els) =>
      els.filter((el) => el.getClientRects().length > 0).map((el) => {
        const name = el.querySelector(".stack-name");
        const line = el.querySelector(".stack-blocker-line");
        const style = name ? getComputedStyle(name) : null;
        const lineHeight = style ? Number.parseFloat(style.lineHeight) || 20 : 20;
        return {
          id: el.getAttribute("data-testid"),
          height: el.getBoundingClientRect().height,
          name: name?.getBoundingClientRect().height ?? 0,
          blocker: line?.getBoundingClientRect().height ?? 0,
          budget: lineHeight * 3 + 36,
          nameBudget: lineHeight * 1.45,
        };
      }),
    );
    check(phoneRows.length >= 3, "phone stack rows missing");
    check(phoneRows.some((row) => row.id === "stack-row-m3"), "expanded bundle member missing from the phone gate");
    for (const row of phoneRows) {
      check(row.height <= row.budget, `${row.id} is ${row.height}px, over a 3-line budget of ${row.budget}`);
      check(row.name <= row.nameBudget, `${row.id} name is ${row.name}px`);
      check(row.blocker <= row.nameBudget + 4, `${row.id} client/blocker line is ${row.blocker}px`);
    }
    const phoneClients = await current().locator(".stack-phone-client").evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const sub = el.closest(".stack-phone-sub");
          const row = el.closest(".stack-row");
          const box = el.getBoundingClientRect();
          const rowBox = row?.getBoundingClientRect();
          const font = sub ? Number.parseFloat(getComputedStyle(sub).fontSize) : 0;
          return {
            text: (el.textContent || "").trim(),
            scroll: el.scrollWidth,
            client: el.clientWidth,
            font,
            left: box.left,
            right: box.right,
            rowLeft: rowBox?.left ?? 0,
            rowRight: rowBox?.right ?? 0,
          };
        }),
    );
    check(phoneClients.some((client) => client.text === "Glenn Casey Chandler"), "long phone client missing");
    for (const client of phoneClients) {
      check(client.font >= 12 && client.font <= 13, `${client.text} sub font is ${client.font}px`);
      check(client.scroll <= client.client + 0.5, `${client.text} clipped (${client.scroll} > ${client.client})`);
      check(client.left >= client.rowLeft - 0.5 && client.right <= client.rowRight + 0.5, `${client.text} leaves its row`);
    }
    const phoneModes = await current().locator(".stack-phone-sub").evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const client = el.querySelector(".stack-phone-client");
          const dot = el.querySelector(".stack-phone-dot");
          const mode = el.querySelector(".stack-phone-mode") as HTMLElement | null;
          const clientBox = client?.getBoundingClientRect();
          const dotBox = dot?.getBoundingClientRect();
          const modeBox = mode?.getBoundingClientRect();
          return {
            client: (client?.textContent || "").trim(),
            mode: (mode?.textContent || "").trim(),
            scroll: mode?.scrollWidth ?? 0,
            clientWidth: mode?.clientWidth ?? 0,
            beforeDot: clientBox && dotBox ? dotBox.left - clientBox.right : null,
            afterDot: dotBox && modeBox ? modeBox.left - dotBox.right : null,
          };
        }),
    );
    check(phoneModes.some((row) => row.mode === "Pickup"), "phone Pickup label missing");
    check(phoneModes.some((row) => row.mode === "Ships"), "phone Ships label missing");
    for (const row of phoneModes) {
      check(row.mode === "Ships" || row.mode === "Pickup", `phone mode was ${row.mode}`);
      check(row.scroll <= row.clientWidth + 0.5, `${row.client || "row"} ${row.mode} clipped (${row.scroll} > ${row.clientWidth})`);
      if (row.beforeDot != null) check(row.beforeDot >= 2, `${row.client}· ${row.mode} is missing the space before the dot (${row.beforeDot.toFixed(1)}px)`);
      if (row.afterDot != null) check(row.afterDot >= 2, `${row.client} ·${row.mode} is missing the space after the dot (${row.afterDot.toFixed(1)}px)`);
    }
    await checkDrawer("phone");
    await checkLibrary("phone");

    await page.goto(`${base}/#/queue`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='column-next-print']").first().waitFor();
    const phoneQueue = await current().locator(".queue-lane").evaluateAll((lanes) =>
      lanes.map((lane) => {
        const header = lane.querySelector(".queue-lane-header .queue-amount");
        const rows = [...lane.querySelectorAll(".scan-facts .queue-amount")];
        return [header, ...rows].filter((el): el is Element => Boolean(el)).map((el) => el.getBoundingClientRect().right);
      }),
    );
    for (const rights of phoneQueue) {
      if (rights.length >= 2) check(spread(rights).delta <= 0.5, `phone queue amount edges differ by ${spread(rights).delta}`);
    }
    const phoneRefresh = await page.locator("[data-testid='button-refresh-queue']").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).display),
    );
    check(phoneRefresh.length > 0 && phoneRefresh.every((display) => display === "none"), `phone queue refresh displays: ${phoneRefresh.join(",")}`);
    await page.locator("[data-testid='button-refresh-workspace-mobile']").waitFor();
    const phoneProduction = await current().locator("[data-testid='column-in-production']").first().evaluate((el) => el.textContent || "");
    check(/Oct 2 · tentative/.test(phoneProduction), `phone queue date was ${phoneProduction}`);
    const phoneQueueTitle = await current().locator("[data-testid='button-queue-deal-q1'] .board-name").first().evaluate((el) => (el.textContent || "").trim());
    check(phoneQueueTitle === "Order q1", `phone queue title still includes the client: ${phoneQueueTitle}`);

    await page.goto(`${base}/#/deals`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='text-orders-phone']").first().waitFor();
    const dealRefresh = await page.locator("[data-testid='button-refresh-deals']").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).display),
    );
    check(dealRefresh.length > 0 && dealRefresh.every((display) => display === "none"), `phone orders refresh displays: ${dealRefresh.join(",")}`);
    const dealHubspot = await page.locator("[data-testid='button-open-hubspot-deals']").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).display),
    );
    check(dealHubspot.some((display) => display !== "none"), "phone orders HubSpot link is hidden");
    await page.locator("[data-testid='button-refresh-workspace-mobile']").waitFor();

    await page.goto(`${base}/#/performance`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='stats-headlines']").waitFor();
    const phoneStats = await current().evaluate((root) => {
      const headlines = Array.from(root.querySelectorAll("[data-testid^='headline-']")).slice(0, 2);
      const rects = headlines.map((el) => el.getBoundingClientRect());
      return {
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        tops: rects.map((rect) => rect.top),
        lefts: rects.map((rect) => rect.left),
      };
    });
    check(phoneStats.scroll <= phoneStats.inner + 1, `phone stats scrolls horizontally (${phoneStats.scroll})`);
    check(phoneStats.tops.length === 2 && Math.abs((phoneStats.tops[0] ?? 0) - (phoneStats.tops[1] ?? 0)) <= 1, "phone headlines are not in two columns");
    check(Math.abs((phoneStats.lefts[0] ?? 0) - (phoneStats.lefts[1] ?? 0)) > 1, "phone headline columns overlap");
    const periodOverflow = await current().locator("[data-testid='stats-period'] button").evaluateAll((buttons) =>
      buttons.some((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }),
    );
    check(!periodOverflow, "phone period chips overflow the viewport");
    await current().locator("[data-testid='stats-origin-svg']").waitFor();
    assert.equal(await current().locator("[data-testid='stats-origin-svg']").count(), 1, "phone renders exactly one order-origin map");
    const phoneOrigin = await current().locator("[data-testid='stats-origin-map']").evaluate((card) => {
      const svg = card.querySelector("[data-testid='stats-origin-svg']")?.getBoundingClientRect();
      const legend = card.querySelector("[data-testid='stats-origin-legend']")?.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return {
        svgBottom: svg?.bottom ?? 0,
        svgWidth: svg?.width ?? 0,
        legendTop: legend?.top ?? 0,
        cardWidth: cardRect.width,
        inner: window.innerWidth,
      };
    });
    check(phoneOrigin.legendTop >= phoneOrigin.svgBottom - 1, "phone origin legend is not below the map");
    check(phoneOrigin.svgWidth <= phoneOrigin.inner + 1, `phone origin map is wider than the screen (${phoneOrigin.svgWidth})`);
    await page.locator("[data-testid='stats-origin-svg'] path").first().tap();
    await page.locator("[data-testid='stats-origin-svg'] circle").last().tap();
    assert.match(await page.locator("[data-testid='stats-origin-detail']").first().innerText(), /\d+ orders?/);
    if (artifactPath("stats-map-phone-390.png")) await current().locator("[data-testid='stats-origin-map']").screenshot({ path: artifactPath("stats-map-phone-390.png")! });
    if (artifactPath("stats-map-popover-390.png")) await current().locator("[data-testid='stats-origin-map']").screenshot({ path: artifactPath("stats-map-popover-390.png")! });
    await page.evaluate(() => {
      const saved: Array<[HTMLElement, string]> = [];
      const nodes = Array.from(document.querySelectorAll("[data-testid='page-transition']"));
      for (let index = 0; index < nodes.length; index += 1) {
        const el = nodes[index] as HTMLElement;
        if (index < nodes.length - 1) {
          saved.push([el, el.getAttribute("style") ?? ""]);
          el.style.display = "none";
        }
      }
      let node = (nodes[nodes.length - 1] as HTMLElement | undefined)?.parentElement ?? null;
      while (node) {
        saved.push([node, node.getAttribute("style") ?? ""]);
        node.style.overflow = "visible";
        node.style.height = "auto";
        node.style.maxHeight = "none";
        node = node.parentElement;
      }
      (window as unknown as { __statsShot?: Array<[HTMLElement, string]> }).__statsShot = saved;
    });
    if (artifactPath("stats-phone-390.png")) await page.screenshot({ path: artifactPath("stats-phone-390.png")!, fullPage: true });
    if (artifactPath("stats-nav-390.png")) await page.screenshot({ path: artifactPath("stats-nav-390.png")!, fullPage: true });
    if (artifactPath("stats-phone-390-v2.png")) await page.screenshot({ path: artifactPath("stats-phone-390-v2.png")!, fullPage: true });
    if (artifactPath("performance-overhead-390.png")) await page.screenshot({ path: artifactPath("performance-overhead-390.png")!, fullPage: true });
    if (artifactPath("stats-phone-390-v3.png")) await page.screenshot({ path: artifactPath("stats-phone-390-v3.png")!, fullPage: true });
    await page.evaluate(() => {
      const saved = (window as unknown as { __statsShot?: Array<[HTMLElement, string]> }).__statsShot ?? [];
      for (const [el, css] of saved) {
        if (css) el.setAttribute("style", css);
        else el.removeAttribute("style");
      }
    });

    await page.goto(`${base}/#/expenses`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add expense" }).first().waitFor();
    if (artifactPath("expenses-phone-390.png")) await page.screenshot({ path: artifactPath("expenses-phone-390.png")!, fullPage: true });
    await page.getByRole("button", { name: "Add expense" }).first().click();
    const saveVisible = await page.getByRole("button", { name: "Save" }).last().evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.top >= 0 && rect.bottom <= innerHeight && (center === el || el.contains(center));
    });
    check(saveVisible, "expense drawer Save footer is visible and uncovered");
    if (artifactPath("expenses-drawer-390.png")) await page.screenshot({ path: artifactPath("expenses-drawer-390.png")!, fullPage: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/setup`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='button-connect-google-drive']").waitFor();
    const connectText = await current().locator("[data-testid='panel-google-drive']").innerText();
    check(/Connect Google Drive/.test(connectText), `connect copy was ${connectText}`);
    check(!/refresh|ya29|client_secret/i.test(connectText), "connect panel leaks a secret");

    const lockedContext = await browser!.newContext({ deviceScaleFactor: 1 });
    const lockedPage = await lockedContext.newPage();
    await lockedPage.route("**/api/**", async (route) => {
      const lockedUrl = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bodyFor(lockedUrl)) });
    });
    await lockedPage.setViewportSize({ width: 1440, height: 900 });
    await lockedPage.goto(`${base}/#/setup`, { waitUntil: "domcontentloaded" });
    await lockedPage.locator("[data-testid='text-google-drive-locked']").waitFor();
    check((await lockedPage.locator("[data-testid='button-connect-google-drive']").count()) === 0, "locked setup shows Connect");
    await lockedContext.close();

    check(pageErrors.length === 0, pageErrors.join("\n"));
    assert.deepEqual(failures, []);
  } finally {
    await browser?.close();
    child.kill("SIGKILL");
  }
});
