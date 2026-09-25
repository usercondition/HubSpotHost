/**
 * Browser layout gate. Serves the production build, stubs shop APIs, and checks
 * the shell and the main boards at 1440×900 and 390×844.
 *
 * Requires `npm run build` first (dist/index.cjs) and Google Chrome.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";

const { chromium } = playwright;

const TODAY = "2026-09-25";

function queueItem(id: string, bucket: string, amount: number) {
  return {
    dealId: id,
    dealName: `Order ${id}`,
    stageId: "print",
    stage: "Printing",
    amount,
    shipBy: "2026-10-02",
    shipBySource: "derived",
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
    shipPlanNote: null,
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
    nextStep: "Print",
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
    dealName: `Board ${id}`,
    stageId: "print",
    stage: "Printing",
    amount,
    productionCost: cost,
    grossProfit: profit,
    marginPercentage: amount > 0 ? (profit / amount) * 100 : 0,
    costsComplete: true,
    hasPlates: true,
    requiresPlates: true,
    promptAttachPlates: false,
    needsReply: false,
    shipByOverride: null,
    shipPlanNote: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    closeDate: null,
    contactName: "Ada",
  };
}

function bodyFor(pathname: string) {
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
      activeDeals: [deal("b1", 120, 40), deal("b2", 80, 30)],
      closedDeals: [],
      hubspotPortalId: "1",
    };
  }
  if (pathname.startsWith("/api/priority-stack")) {
    const committed = stackRow({
      key: "committed",
      dealId: "c1",
      name: "Committed order",
      amount: 80,
      tier: "committed",
    });
    const tentative = stackRow({
      key: "tentative",
      dealId: "c2",
      name: "Tentative order",
      amount: 1200,
      tier: "committed",
      tentative: true,
      targetDate: "2026-10-02",
    });
    const offbook = stackRow({
      key: "offbook",
      kind: "offbook",
      dealId: null,
      offbookId: 4,
      name: "Pickup piece",
      contactName: null,
      amount: null,
      tier: "committed",
      shippingRequired: false,
      lane: "shop",
      steps: [{ label: "Print", done: false }],
    });
    const bundle = stackRow({
      key: "bundle",
      kind: "bundle",
      dealId: null,
      bundleId: 9,
      name: "Saturday pickup",
      amount: 45,
      tier: "stretch",
      shippingRequired: false,
      members: [
        stackRow({ key: "member", name: "Member", amount: 45, dealId: "m1" }),
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
    const inProduction = [queueItem("q3", "in_production", 90)];
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
  if (pathname.startsWith("/api/printers")) return { ok: true, printers: [] };
  if (pathname.startsWith("/api/resin-reorder")) return { buyNow: [], suggestions: [] };
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

    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ deviceScaleFactor: 1 });
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
        body: JSON.stringify(bodyFor(url.pathname)),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="badge-nav-floor"]')?.textContent?.trim() === "2",
    );

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

    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    const current = () => page.locator("[data-testid='page-transition']").last();
    await current().locator("[data-testid='stack-row-committed']").first().waitFor();
    const money = await boxes(current(), ".stack-row > .stack-money");
    assert.ok(money.length >= 3);
    const moneyRight = spread(money.map((box) => box.right));
    check(moneyRight.delta <= 1, `stack amount right edges differ by ${moneyRight.delta}`);
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

    await page.goto(`${base}/#/queue`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='column-next-print']").first().waitFor();
    assert.equal(await current().locator("[data-testid='column-in-production']").count(), 1);
    assert.equal(await current().locator("[data-testid='column-ship-ready']").count(), 0);
    assert.equal(await current().locator("[data-testid='column-blocked']").count(), 0);
    const byLane = await current().locator(".queue-lane").evaluateAll((lanes) =>
      lanes.map((lane) =>
        [...lane.querySelectorAll(".scan-facts span:last-child")].map((el) => el.getBoundingClientRect().right),
      ),
    );
    for (const rights of byLane) {
      if (rights.length >= 2) check(spread(rights).delta <= 1, `queue amounts differ by ${spread(rights).delta}`);
    }

    await page.goto(`${base}/#/deals`, { waitUntil: "domcontentloaded" });
    await current().locator("[data-testid='text-deal-paid-b1']").first().waitFor();
    const paid = await boxes(current(), "[data-testid^='text-deal-paid-']");
    const cost = await boxes(current(), "[data-testid^='text-deal-production-']");
    const profit = await boxes(current(), "[data-testid^='text-deal-revenue-']");
    check(paid.length >= 2, "order paid figures missing");
    check(spread(paid.map((box) => box.left)).delta <= 1, `Paid labels left edges differ by ${spread(paid.map((box) => box.left)).delta}`);
    check(spread(cost.map((box) => box.left)).delta <= 1, `Cost labels left edges differ by ${spread(cost.map((box) => box.left)).delta}`);
    check(spread(profit.map((box) => box.left)).delta <= 1, `Profit labels left edges differ by ${spread(profit.map((box) => box.left)).delta}`);

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

    await page.getByTestId("button-mobile-nav-more").click();
    await page.waitForSelector("[data-testid='panel-mobile-more']");
    const moreText = await page.locator("[data-testid='panel-mobile-more']").innerText();
    assert.equal(/\bOrders\b/.test(moreText), false);

    check(pageErrors.length === 0, pageErrors.join("\n"));
    assert.deepEqual(failures, []);
  } finally {
    await browser?.close();
    child.kill("SIGKILL");
  }
});
