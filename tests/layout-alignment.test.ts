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

function queueItem(
  id: string,
  bucket: string,
  amount: number,
  extra: { tentative?: boolean; shipBySource?: "override" | "derived"; shipPlanNote?: string | null } = {},
) {
  return {
    dealId: id,
    dealName: `Order ${id}`,
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
    dealName: `Board ${id} - Ada`,
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
      rank: 1,
      dealId: "c1",
      name: "Committed order - Ada",
      amount: 80,
      tier: "committed",
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
      name: "Tentative order",
      amount: 1200,
      tier: "committed",
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
      shippingRequired: false,
      members: [
        stackRow({ key: "m1", name: "Member one", amount: 15, dealId: "m1" }),
        stackRow({ key: "m2", name: "Member two", amount: 15, dealId: "m2" }),
        stackRow({ key: "m3", name: "Member three", amount: 15, dealId: "m3" }),
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
    await page.locator("[data-testid='row-floor-next-1']").first().waitFor();
    const upNext = await page.locator("[data-testid='row-floor-next-1']").first().innerText();
    check(upNext.split("Ada").length - 1 === 1, `floor up-next repeats the client: ${upNext}`);

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
    const checkDrawer = async (label: string) => {
      await current().locator("[data-testid='button-open-committed']").first().evaluate((el) => (el as HTMLElement).click());
      await page.locator("[data-testid='drawer-deal-ops'] h2").waitFor();
      await page.locator("[data-testid='text-drawer-checklist-progress']").waitFor({ state: "attached" });
      const drawerCount = await page.locator("[data-testid='text-drawer-checklist-progress']").innerText();
      check(/1\/5/.test(drawerCount), `${label} drawer checklist was ${drawerCount}`);
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
        const headings = [...drawer.querySelectorAll("h3")];
        const plates = headings.find((heading) => /Assign plates/.test(heading.textContent || ""));
        const slip = headings.find((heading) => /Packing slip/.test(heading.textContent || ""));
        if (!title || !plates || !slip) return false;
        const titleTop = title.getBoundingClientRect().top;
        return titleTop < plates.getBoundingClientRect().top && titleTop < slip.getBoundingClientRect().top;
      });
      check(order, `${label} drawer title is not above Assign plates and Packing slip`);
      await page.locator("[data-testid='button-close-deal-ops-drawer']").evaluate((el) => (el as HTMLElement).click());
      await page.locator("[data-testid='drawer-deal-ops']").waitFor({ state: "hidden" });
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
    await current().locator("[data-testid='toggle-orders-view']").last().getByRole("button", { name: "Table" }).click();
    await current().locator("[data-testid='text-table-profit-b1']").first().waitFor();
    const tableProfit = await current().locator("[data-testid='text-table-profit-b1']").first().evaluate((el) => getComputedStyle(el).color);
    check(tableProfit === "rgb(61, 184, 139)", `table profit color was ${tableProfit}`);

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
    for (const row of phoneRows) {
      check(row.height <= row.budget, `${row.id} is ${row.height}px, over a 3-line budget of ${row.budget}`);
      check(row.name <= row.nameBudget, `${row.id} name is ${row.name}px`);
      check(row.blocker <= row.nameBudget + 4, `${row.id} client/blocker line is ${row.blocker}px`);
    }
    await checkDrawer("phone");

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

    check(pageErrors.length === 0, pageErrors.join("\n"));
    assert.deepEqual(failures, []);
  } finally {
    await browser?.close();
    child.kill("SIGKILL");
  }
});
