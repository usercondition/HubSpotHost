/**
 * Send to Library lives in the overflow menu, with a short "Not in Library"
 * status. Download errors stay inside a 390px phone screen and never show
 * raw Drive text.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";

const { chromium } = playwright;
const ARTIFACTS = process.env.ARTIFACTS_DIR?.trim() || "/opt/cursor/artifacts";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const LIBRARY_FILE = {
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
  sha256: "ab".repeat(32),
  orderKeys: ["deal:c1"],
  printRecordIds: [7],
  hasPreview: true,
  stats: {
    printerProfile: "MEGA 8K",
    layerCount: 420,
    layerHeightMm: 0.05,
    printTimeSeconds: 14400,
    resinVolumeMl: 31.25,
    resinCost: 18.4,
  },
};

const LIBRARY_RAIDER = {
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
  sha256: "cd".repeat(32),
  orderKeys: ["deal:c2", "deal:c9"],
  printRecordIds: [],
  hasPreview: false,
  stats: {
    printerProfile: "Mighty 12K",
    layerCount: 800,
    layerHeightMm: 0.05,
    printTimeSeconds: 7200,
    resinVolumeMl: 40.5,
    resinCost: 22,
  },
};

const REUSE_FILE = {
  driveFileId: "file-bits",
  name: "Castellan_Bits_Plate_1.ctb",
  webViewLink: "https://drive.google.com/file/d/file-bits/view",
  sizeBytes: 4096,
  modifiedAt: "2026-09-26T20:00:00.000Z",
  mimeType: "application/octet-stream",
  extension: ".ctb",
  printer: "Mighty 8K",
  kit: "Cerastus Castigator",
  customer: "Wayne Hood",
  kitTags: "Cerastus Castigator",
  notes: "",
  source: "upload",
  sha256: "ef".repeat(32),
  orderKeys: ["deal:99"],
  printRecordIds: [],
  hasPreview: false,
  stats: null,
};

const PRINT_RECORD = {
  id: 7,
  analysisId: "analysis-7",
  hubspotDealId: "c1",
  hubspotDealName: "Cerastus Chassis - Castigator - Ada",
  dealStage: "Printing",
  fileName: "Castigator_MEGA_8K.ctb",
  fileSizeBytes: 188743680,
  sha256: "ab".repeat(32),
  formatRevision: "CTB",
  printTimeSeconds: 14400,
  resinVolumeMl: "31.25",
  resinMassG: "34.5",
  resinCost: "18.40",
  resinCostSource: "profile",
  resinCostLabel: "Shop resin price",
  resinDensityGPerMl: "1.1",
  layerCount: 420,
  layerHeightMm: "0.05",
  printerProfile: "MEGA 8K",
  fleetPrinterId: null,
  hubspotSyncedAt: "2026-09-26T20:00:00.000Z",
  attachedAt: "2026-09-26T20:00:00.000Z",
  bits: [],
  bitSummary: { total: 0, onPlate: 0, good: 0, reprint: 0 },
  library: { status: "pending", driveFileId: "", error: "Not in Library yet." },
};

function stackRow() {
  return {
    key: "committed",
    kind: "deal",
    rank: 1,
    manual: false,
    isNew: false,
    name: "Cerastus Chassis - Castigator - Ada",
    contactName: "Ada",
    stage: "Ready to Ship",
    bucket: "print",
    lane: "fly",
    blocker: "",
    blockerSource: "auto",
    nextStep: "",
    targetDate: "2026-10-02",
    targetSource: "derived",
    tentative: false,
    amount: 80,
    tier: "committed",
    shippingRequired: true,
    dealId: "c1",
    offbookId: null,
    bundleId: null,
    fulfillment: {
      dealId: "c1",
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
    steps: [],
    members: [],
  };
}

function bodyFor(url: URL, downloadError: boolean): { status: number; contentType: string; body: string } | { png: true } {
  const pathname = url.pathname;
  if (pathname.startsWith("/api/plate-previews/")) return { png: true };
  if (pathname === "/api/plate-files/download" && downloadError) {
    return {
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Error: invalid_grant ya29.SECRET googleapis.com/token" }),
    };
  }
  if (pathname.startsWith("/api/health")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", safety: { liveWriteReady: true }, webhook: { verification: "configured" }, hubspotSync: { issueCount: 0 }, storage: {} }),
    };
  }
  if (pathname.startsWith("/api/performance")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: "2026-09-25T19:39:00.000Z",
        hubspotPortalId: "1",
        intake: { awaitingClient: 0, pendingReview: 0, approved: 0 },
        attention: [],
        activeDeals: [],
        summary: { revenue: 0, grossProfit: 0, orders: 0 },
      }),
    };
  }
  if (pathname.startsWith("/api/production-queue")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        nextPrint: [],
        inProduction: [],
        shipReady: [],
        blocked: [],
        summary: { nextPrint: 0, inProduction: 0, shipReady: 0, blocked: 0 },
      }),
    };
  }
  if (pathname.startsWith("/api/priority-stack/updates")) {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, entries: [] }) };
  }
  if (pathname.startsWith("/api/priority-stack")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        generatedAt: "2026-09-25T19:39:00.000Z",
        today: "2026-09-25",
        rows: [stackRow()],
        outTheDoor: [],
        totals: { committed: 80, stretch: 0, later: 0, outTheDoor: 0, offBookUnpriced: 0 },
        hiddenCount: 0,
      }),
    };
  }
  if (pathname === "/api/plate-files/reuse") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, file: REUSE_FILE }) };
  }
  if (pathname.startsWith("/api/plate-files")) {
    if (url.searchParams.get("summary") === "1") {
      return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, total: 2, files: [], failures: [] }) };
    }
    const orderKey = url.searchParams.get("orderKey") || "";
    const catalog = orderKey ? [LIBRARY_FILE].filter((file) => file.orderKeys.includes(orderKey)) : [LIBRARY_FILE, LIBRARY_RAIDER];
    const pending = orderKey
      ? [{ printRecordId: 7, orderKey, sha256: "ab".repeat(32), name: "Castigator_MEGA_8K.ctb", error: "Not in Library yet." }]
      : [];
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, files: catalog, failures: [], pending }),
    };
  }
  if (pathname.startsWith("/api/prints")) {
    return {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        processed: 0,
        seeded: 0,
        candidates: [],
        records: [PRINT_RECORD],
        boards: [
          {
            dealId: "c1",
            dealName: "Cerastus Chassis - Castigator - Ada",
            dealStage: "Printing",
            plateCount: 1,
            totalPrintTimeSeconds: 14400,
            totalResinVolumeMl: 31.25,
            totalResinMassG: 34.5,
            totalResinCost: 18.4,
            latestAttachedAt: "2026-09-26T20:00:00.000Z",
            records: [PRINT_RECORD],
          },
        ],
        includeAttached: true,
        lastAttachedDealId: "c1",
        attachPreview: null,
      }),
    };
  }
  if (pathname.startsWith("/api/deal-ops/")) {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, hubspotPortalId: "1", plates: [], checklist: {} }) };
  }
  return { status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, printers: [], buyNow: [] }) };
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

test("Send to Library screen at 1440 and 390", { timeout: 180_000 }, async () => {
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
  let downloadError = false;
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
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const payload = bodyFor(url, downloadError);
      if ("png" in payload) {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await route.fulfill(payload);
    });
    await page.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });

    const shot = async (name: string, selector: string) => {
      const target = page.locator(selector).last();
      await target.waitFor();
      await target.screenshot({ path: `${ARTIFACTS}/${name}` });
    };
    const assertKitCatalog = async () => {
      const libraryText = await page.locator("[data-testid='page-library']").innerText();
      assert.equal(/Ada|Daniel|Wayne|Glenn/.test(libraryText), false, libraryText);
      assert.match(libraryText, /Castigator/);
      assert.match(libraryText, /Land Raider/);
      assert.match(libraryText, /Used on 1 order/);
      assert.match(libraryText, /Used on 2 orders/);
      assert.match(libraryText, /420/);
      assert.match(libraryText, /31\.25 ml/);
    };
    const showReuse = async (drawer: playwright.Locator) => {
      await drawer.locator("[data-testid='button-add-slice-file']").evaluate((el) => (el as HTMLElement).click());
      await drawer.locator("[data-testid='input-slice-file']").setInputFiles({
        name: "Castellan_Bits_Plate_1.ctb",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("plate"),
      });
      await drawer.locator("[data-testid='select-slice-printer']").selectOption("Mighty 8K");
      const reuse = drawer.locator("[data-testid='text-library-reuse']");
      await reuse.waitFor();
      const reuseText = (await reuse.innerText()).replace(/\s+/g, " ").trim();
      assert.match(reuseText, /^Already in Library: Castellan Bits Plate 1, Mighty 8K/);
      assert.match(reuseText, /Use this/);
      assert.equal(/Wayne|Ada|Daniel|Glenn/.test(reuseText), false, reuseText);
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/library`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='library-row-file-castigator']").waitFor();
    await page.locator("[data-testid='library-row-file-raider']").waitFor();
    const partRow = page.locator("[data-testid='library-row-file-castigator']");
    const partMenu = await partRow.locator("[data-testid='button-plate-menu-file-castigator']").boundingBox();
    const partSize = await partRow.locator("[data-testid='library-file-size']").boundingBox();
    const partName = await partRow.locator("[data-testid='library-file-name']").boundingBox();
    const kitMenu = await page.locator("[data-testid='library-kit-castigator'] button").first().boundingBox();
    assert.ok(partMenu && partSize && partName && kitMenu, "library part row boxes missing");
    assert.ok(partMenu.x > partSize.x, `part menu sits before size (${partMenu.x} <= ${partSize.x})`);
    assert.ok(partSize.x > partName.x + partName.width * 0.4, "part menu is still in the name column");
    assert.ok(Math.abs(partMenu.x + partMenu.width - (kitMenu.x + kitMenu.width)) <= 2, "part menu is not lined up with the kit menu");
    await partRow.screenshot({ path: `${ARTIFACTS}/library-part-row-desktop-1440.png` });
    await assertKitCatalog();
    await shot("library-desktop-1440.png", "[data-testid='page-library']");
    await page.goto(`${base}/#/library?kit=${encodeURIComponent("Castigator")}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='library-row-file-castigator']").waitFor();
    await page.locator("[data-testid='library-row-file-raider']").waitFor({ state: "hidden" });
    const openKit = await page.locator("[data-testid='page-library']").innerText();
    assert.match(openKit, /Castigator/);
    assert.equal(/Land Raider|Ada|Daniel|Wayne|Glenn/.test(openKit), false, openKit);
    await shot("library-kit-desktop-1440.png", "[data-testid='page-library']");
    await page.locator("[data-testid='button-plate-thumb-file-castigator']").click();
    await page.locator("[data-testid='panel-plate-preview']").waitFor();
    const previewText = await page.locator("[data-testid='panel-plate-preview']").innerText();
    assert.equal(/Ada|Daniel|Wayne|Glenn/.test(previewText), false, previewText);
    assert.match(previewText, /Used on 1 order/);
    assert.match(previewText, /Castigator/);
    await shot("preview-desktop-1440.png", "[data-testid='panel-plate-preview']");
    await page.locator("[data-testid='button-close-plate-preview']").click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/library`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='library-row-file-castigator']").waitFor();
    await assertKitCatalog();
    const phoneMetaBox = await page.locator("[data-testid='library-row-file-castigator'] .library-meta").evaluate((el) => ({
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      wrap: getComputedStyle(el).whiteSpace,
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    assert.match(phoneMetaBox.text, /31\.25 ml/, phoneMetaBox.text);
    assert.equal(phoneMetaBox.wrap, "normal");
    assert.ok(phoneMetaBox.scroll <= phoneMetaBox.client + 1, `phone meta still clips (${phoneMetaBox.scroll} > ${phoneMetaBox.client})`);
    await page.locator("[data-testid='library-row-file-castigator']").screenshot({ path: `${ARTIFACTS}/library-part-row-phone-390.png` });
    await shot("library-phone-390.png", "[data-testid='page-library']");
    await page.goto(`${base}/#/library?kit=${encodeURIComponent("Castigator")}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='library-row-file-castigator']").waitFor();
    await page.locator("[data-testid='library-row-file-raider']").waitFor({ state: "hidden" });
    await shot("library-kit-phone-390.png", "[data-testid='page-library']");
    await page.locator("[data-testid='button-plate-thumb-file-castigator']").click();
    await page.locator("[data-testid='panel-plate-preview']").waitFor();
    const phonePreview = await page.locator("[data-testid='panel-plate-preview']").innerText();
    assert.equal(/Ada|Daniel|Wayne|Glenn/.test(phonePreview), false, phonePreview);
    await shot("preview-phone-390.png", "[data-testid='panel-plate-preview']");
    await page.locator("[data-testid='button-close-plate-preview']").click();

    downloadError = true;
    await page.locator("[data-testid='button-plate-menu-file-castigator']").click();
    await page.locator("[data-testid='button-download-plate-file-castigator']").click();
    const error = page.locator("[data-testid='text-plate-download-error']");
    await error.waitFor();
    const errorText = await error.innerText();
    assert.equal(/ya29|googleapis|invalid_grant/i.test(errorText), false, errorText);
    assert.match(errorText, /Drive could not read that file/);
    const box = await error.boundingBox();
    assert.ok(box, "download error missing");
    assert.ok(box.x >= 0 && box.y >= 0, `error origin ${box.x},${box.y}`);
    assert.ok(box.x + box.width <= 390 + 1, `error overflows 390 (${box.x + box.width})`);
    downloadError = false;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='page-transition']").last().locator("[data-testid='button-open-committed']").evaluate((el) => (el as HTMLElement).click());
    const drawer = page.locator("[data-testid='drawer-deal-ops']").last();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid='drawer-deal-ops']");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 40 && rect.top <= 80 && rect.right >= window.innerWidth - 2;
    });
    await drawer.locator("[data-testid='slice-files']").waitFor();
    await drawer.locator("[data-testid='text-slice-pending-7']").waitFor();
    assert.equal(await drawer.locator("[data-testid='button-send-to-library-7']").count(), 0);
    await showReuse(drawer);
    await drawer.locator("[data-testid='button-pending-menu-7']").evaluate((el) => (el as HTMLElement).click());
    await drawer.locator("[data-testid='button-send-to-library-7']").waitFor();
    const drawerText = await drawer.locator("[data-testid='slice-files']").innerText();
    assert.equal(/Connect Drive or retry/i.test(drawerText), false, drawerText);
    assert.match(drawerText, /Not in Library/);
    assert.match(drawerText, /Send to Library/);
    assert.equal(await drawer.locator("[data-testid='slice-file-name']").count(), 1);
    const drawerName = await drawer.locator("[data-testid='slice-file-name']").innerText();
    assert.match(drawerName, /Castigator_MEGA_8K\.ctb/);
    const drawerBoxes = await drawer.locator("[data-testid='slice-library-pending-7']").evaluate((row) => {
      const thumb = row.querySelector(".plate-thumb")?.getBoundingClientRect();
      const name = row.querySelector("[data-testid='slice-file-name']")?.getBoundingClientRect();
      const menu = row.querySelector("[data-testid='button-pending-menu-7']")?.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        thumb: thumb ? thumb.left : -1,
        name: name ? name.left : -1,
        nameWidth: name ? name.width : 0,
        menuRight: menu ? menu.right : -1,
        rowRight: rowBox.right,
      };
    });
    assert.ok(drawerBoxes.thumb >= 0 && drawerBoxes.thumb < drawerBoxes.name, "drawer thumb is not at the left");
    assert.ok(drawerBoxes.nameWidth > 80, `drawer name collapsed (${drawerBoxes.nameWidth})`);
    assert.ok(drawerBoxes.menuRight > drawerBoxes.name + drawerBoxes.nameWidth, "drawer menu is not at the right");
    assert.ok(drawerBoxes.rowRight - drawerBoxes.menuRight < 24, "drawer menu is not at the row edge");
    await drawer.locator("[data-testid='slice-files']").screenshot({ path: `${ARTIFACTS}/drawer-files-desktop-1440.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='page-transition']").last().locator("[data-testid='button-open-committed']").evaluate((el) => (el as HTMLElement).click());
    const phoneDrawer = page.locator("[data-testid='drawer-deal-ops']").last();
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-testid='drawer-deal-ops']");
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.top <= 2 && rect.left <= 2 && rect.height > 400;
    });
    await phoneDrawer.locator("[data-testid='slice-library-pending-7']").scrollIntoViewIfNeeded();
    await showReuse(phoneDrawer);
    await phoneDrawer.locator("[data-testid='button-pending-menu-7']").evaluate((el) => (el as HTMLElement).click());
    await phoneDrawer.locator("[data-testid='button-send-to-library-7']").waitFor();
    await phoneDrawer.locator("[data-testid='slice-files']").screenshot({ path: `${ARTIFACTS}/drawer-files-phone-390.png` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/prints`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    const row = page.locator("[data-testid='row-print-record-7']");
    await row.waitFor();
    const before = await row.innerText();
    assert.match(before, /Not in Library/);
    assert.match(before, /\$18\.40/);
    assert.equal(/Connect Drive or retry/i.test(before), false, before);
    assert.equal(await row.locator("[data-testid='button-send-to-library-7']").count(), 0);
    await row.locator("[data-testid='button-print-library-menu-7']").evaluate((el) => (el as HTMLElement).click());
    await row.locator("[data-testid='button-send-to-library-7']").waitFor();
    const after = await row.innerText();
    assert.match(after, /Send to Library/);
    assert.equal(/Connect Drive or retry/i.test(after), false, after);
    await shot("prints-row-desktop-1440.png", "[data-testid='row-print-record-7']");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/prints`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    const phoneRow = page.locator("[data-testid='row-print-record-7']");
    await phoneRow.waitFor();
    await phoneRow.locator("[data-testid='button-print-library-menu-7']").evaluate((el) => (el as HTMLElement).click());
    await phoneRow.locator("[data-testid='button-send-to-library-7']").waitFor();
    assert.match(await phoneRow.innerText(), /\$18\.40/);
    await shot("prints-row-phone-390.png", "[data-testid='row-print-record-7']");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill();
  }
});
