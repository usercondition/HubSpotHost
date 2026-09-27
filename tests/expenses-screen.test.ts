/**
 * Expenses list and Stats overhead at 1440 and 390.
 * The rows are a layout fixture. The app does not seed vendors or prices.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";
import { buildShopDashboard } from "../shared/shop-dashboard";
import { formatUsdFromCents, overheadCentsForDates, type ExpenseSlice } from "../shared/expenses";
import { expensePeriodSpan } from "../server/lib/expenses";

const { chromium } = playwright;
const ARTIFACTS = "/opt/cursor/artifacts";
const NOW = new Date("2026-09-27T19:00:00.000Z");

const slices: ExpenseSlice[] = [
  { amountCents: 1200, cadence: "monthly", startDate: "2026-01-01", endDate: null, archived: false },
  { amountCents: 12000, cadence: "yearly", startDate: "2026-01-01", endDate: null, archived: false },
  { amountCents: 2400, cadence: "one-off", startDate: "2026-09-20", endDate: null, archived: false },
];

function expenseRow(id: number, extra: Record<string, unknown>, slice: ExpenseSlice) {
  const span = expensePeriodSpan("30", NOW);
  return {
    id,
    clientKey: `fixture-${id}`,
    currency: "USD",
    paymentNote: "",
    notes: "",
    archived: false,
    monthlyEquivalentCents: slice.cadence === "yearly" ? 1000 : slice.cadence === "monthly" ? slice.amountCents : null,
    periodCents: overheadCentsForDates([slice], span.start, span.end),
    ...slice,
    ...extra,
  };
}

const EXPENSES = [
  expenseRow(1, { vendor: "File club", name: "Monthly files", category: "models_patreon" }, slices[0]!),
  expenseRow(2, { vendor: "Host", name: "App hosting", category: "hosting" }, slices[1]!),
  expenseRow(3, { vendor: "Shop", name: "Resin jug", category: "materials" }, slices[2]!),
];

const span = expensePeriodSpan("30", NOW);
const periodTotal = formatUsdFromCents(overheadCentsForDates(slices, span.start, span.end));

const DASHBOARD = buildShopDashboard({
  now: NOW.toISOString(),
  period: "30",
  orders: [
    {
      id: "shop",
      name: "Shop order",
      customer: null,
      createdAt: "2026-09-20T12:00:00.000Z",
      closedAt: null,
      open: true,
      won: false,
      lost: false,
      stageLabel: "Printing",
      amount: 100,
      resinCost: 20,
      postage: 8,
      packaging: 0,
      shipBy: null,
      tentative: false,
      needsReply: false,
      shipping: "ship",
      hasTracking: false,
    },
  ],
  plates: [],
  bits: [],
  failures: [],
  printers: [],
  supplyPurchases: [],
  expenses: slices,
  awaitingClient: 0,
});

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function bodyFor(url: URL) {
  const pathname = url.pathname;
  if (pathname.startsWith("/api/expenses")) {
    return json({
      ok: true,
      stored: EXPENSES.length,
      period: { id: "30", label: "30 days", start: span.start, end: span.end },
      expenses: EXPENSES,
      totals: {
        monthlyRunRateCents: 2200,
        periodCents: overheadCentsForDates(slices, span.start, span.end),
      },
    });
  }
  if (pathname.startsWith("/api/health")) {
    return json({ status: "ok", safety: { liveWriteReady: true }, webhook: { verification: "configured" }, hubspotSync: { issueCount: 0 }, storage: {} });
  }
  if (pathname.startsWith("/api/performance")) {
    return json({
      generatedAt: NOW.toISOString(),
      period: { days: 30, startsAt: "2026-08-28T00:00:00.000Z" },
      thresholds: { marginPercent: 40, staleDays: 14 },
      summary: { revenue: 100, grossProfit: 72, weightedMarginPercent: 72, orders: 1, averageOrderValue: 100, activeOrders: 1, attentionCount: 0 },
      intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
      supplySpend: { total: 0, purchases: 0, periodDays: 30, byCategory: [] },
      books: { supplySpend: 0, grossProfit: 72, revenue: 100, orderCosts: 28, orders: 1, supplyPurchases: 0, afterSupplySpend: 72, supplyShareOfRevenuePercent: 0, supplyShareOfGrossProfitPercent: 0, periodDays: 30, byCategory: [] },
      pipeline: [],
      attention: [],
      activeDeals: [],
      closedDeals: [],
      hubspotPortalId: "1",
      dashboard: url.searchParams.get("dashboard") === "1" ? DASHBOARD : undefined,
    });
  }
  if (pathname.startsWith("/api/production-queue")) {
    return json({ ok: true, nextPrint: [], inProduction: [], shipReady: [], blocked: [], summary: { nextPrint: 0, inProduction: 0, shipReady: 0, blocked: 0 } });
  }
  if (pathname.startsWith("/api/priority-stack")) {
    return json({ ok: true, generatedAt: NOW.toISOString(), today: "2026-09-27", rows: [], outTheDoor: [], totals: {}, hiddenCount: 0 });
  }
  if (pathname.startsWith("/api/plate-files")) return json({ ok: true, total: 0, files: [], failures: [] });
  if (pathname.startsWith("/api/printers")) return json({ ok: true, printers: [] });
  if (pathname.startsWith("/api/resin-reorder")) return json({ ok: true, buyNow: [], suggestions: [] });
  return json({ ok: true });
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

test("Expenses and overhead screens at 1440 and 390", { timeout: 180_000 }, async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
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
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) break;
      } catch {
        /* still booting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      await route.fulfill(bodyFor(new URL(route.request().url())));
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });
    const root = () => page.locator("[data-testid='page-transition']").last();
    const shot = async (name: string, selector: string) => {
      const target = root().locator(selector);
      await target.waitFor();
      await target.screenshot({ path: `${ARTIFACTS}/${name}` });
    };
    const checkExpenses = async (label: string, width: number) => {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(`${base}/#/expenses`, { waitUntil: "domcontentloaded" });
      await root().locator("[data-testid='expense-row-1']").waitFor();
      await root().locator("[data-testid='expense-row-3']").waitFor();
      const text = await root().locator("[data-testid='page-expenses']").innerText();
      assert.match(text, /Recurring/);
      assert.match(text, /One-off/);
      assert.match(text, /Jan 1/);
      assert.match(text, /Sep 20/);
      assert.equal(/\d{1,2}\/\d{1,2}/.test(text), false, text);
      assert.equal(/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(text), false, text);
      assert.match(text, new RegExp(periodTotal.replace("$", "\\$")));
      const edges = await root().locator("[data-testid='expense-period']").evaluateAll((els) =>
        els.filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect().right),
      );
      assert.ok(edges.length >= 3, `${label} period column missing`);
      const delta = Math.max(...edges) - Math.min(...edges);
      assert.ok(delta <= 0.5, `${label} period edges differ by ${delta}`);
      const box = await root().locator("[data-testid='expense-list']").evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        page: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      assert.ok(box.scroll <= box.client + 1, `${label} expense list overflow ${box.scroll} > ${box.client}`);
      assert.ok(box.page <= box.inner + 1, `${label} page overflow ${box.page} > ${box.inner}`);
      if (width < 500) {
        const category = await root().locator("[data-testid='expense-row-1'] .expense-category").evaluate((el) => getComputedStyle(el).display);
        assert.equal(category, "none");
        await page.locator("[data-testid='switch-expenses']").waitFor();
      }
    };

    await checkExpenses("desktop", 1440);
    await shot("expenses-desktop-1440.png", "[data-testid='page-expenses']");
    await checkExpenses("phone", 390);
    await shot("expenses-phone-390.png", "[data-testid='page-expenses']");

    const checkStats = async (label: string, width: number, file: string) => {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.goto(`${base}/?shot=${label}#/performance`, { waitUntil: "domcontentloaded" });
      const headline = root().locator("[data-testid='headline-overhead']");
      await headline.waitFor();
      const formulaText = headline.getByText("divided by the days");
      if (!(await formulaText.isVisible())) {
        await headline.evaluate((el) => (el as HTMLElement).click());
      }
      await formulaText.waitFor();
      await root().locator("[data-testid='headline-net-profit']").waitFor();
      const formula = await headline.innerText();
      assert.match(formula, /divided by the days in that month/);
      assert.match(formula, /Supply receipts are not included/);
      const net = await root().locator("[data-testid='headline-net-profit']").innerText();
      assert.match(net, /net profit after overhead/i);
      assert.equal(/\bundefined\b|\bNaN\b/.test(net), false, net);
      const pageBox = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      assert.ok(pageBox.scroll <= pageBox.inner + 1, `${label} stats overflow ${pageBox.scroll}`);
      await root().locator("[data-testid='stats-headlines']").screenshot({ path: `${ARTIFACTS}/${file}` });
    };
    await checkStats("desktop", 1440, "performance-overhead-1440.png");
    await checkStats("phone", 390, "performance-overhead-390.png");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill();
  }
});
