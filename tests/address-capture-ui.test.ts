/**
 * Screenshots for foolproof address capture: client form, Did you mean,
 * label confirmation, and owner paste-to-fill. Desktop 1440 and phone 390.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import playwright from "playwright";

const { chromium } = playwright;

const TOKEN = "previewtoken1234567890";

const LOOKUP = {
  ok: true,
  view: {
    itemDescription: "Acastus Knight",
    agreedAmount: "40.00",
    lineItems: [],
    expiresAt: "2026-10-11T00:00:00.000Z",
    buyerNameHint: "",
    buyerUsernameHint: "",
    savedDetails: null,
  },
};

const CORRECTED = {
  ok: true,
  status: "corrected",
  needsUnit: false,
  typed: {
    street1: "10909 Hannan Rd",
    street2: "",
    city: "Romulus",
    state: "MI",
    zip: "48174",
    country: "US",
  },
  suggestion: {
    street1: "10909 Hannan Road",
    street2: "",
    city: "Romulus",
    state: "MI",
    zip: "48174-0001",
    country: "US",
  },
  messages: [],
  formattedTyped: "10909 Hannan Rd\nRomulus, MI 48174\nUS",
  formattedSuggestion: "10909 Hannan Road\nRomulus, MI 48174-0001\nUS",
};

const EMPTY_SHOP = {
  ok: true,
  rows: [],
  files: [],
  total: 0,
  nextPrint: [],
  inProduction: [],
  blocked: [],
  shipReady: [],
  readyToPack: [],
  needsReply: [],
  printers: [],
  buyNow: [],
  attention: [],
  activeDeals: [],
  intake: { pendingReview: 0, awaitingClient: 0 },
  hubspotPortalId: "",
  provider: { id: "off", enabled: false, country: null },
};

function bodyFor(url: URL, method: string): unknown {
  if (method === "POST" && url.pathname.endsWith("/validate-address")) return CORRECTED;
  if (method === "POST" && url.pathname.endsWith("/address-capture/preview")) return CORRECTED;
  if (method === "POST" && url.pathname.endsWith("/lookup")) return LOOKUP;
  if (method === "POST" && url.pathname.endsWith("/saved-details")) return { ok: true, savedDetails: null };
  if (url.pathname.endsWith("/address-provider")) return { ok: true, provider: EMPTY_SHOP.provider };
  return EMPTY_SHOP;
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

async function fillClient(page: playwright.Page) {
  await page.locator("[data-testid='input-client-full-name']").fill("Wayne Hood");
  await page.locator("[data-testid='input-client-email']").fill("wayne@example.com");
  await page.locator("[data-testid='input-client-phone']").fill("734-555-0100");
  await page.locator("[data-testid='input-shipping-street']").fill("10909 Hannan Rd");
  await page.locator("[data-testid='input-shipping-city']").fill("Romulus");
  await page.locator("[data-testid='input-shipping-state']").selectOption("MI");
  await page.locator("[data-testid='input-shipping-postal-code']").fill("48174");
  await page.locator("[data-testid='input-confirmed-item']").fill("Acastus Knight");
  await page.locator("[data-testid='checkbox-client-payment-confirmed']").check();
}

const artifactsDir = process.env.ARTIFACTS_DIR?.trim() ?? "";
const runAddressCaptureUi = process.env.ADDRESS_CAPTURE_UI === "1" && artifactsDir.length > 0;

const STACK = {
  ok: true,
  generatedAt: "2026-09-27T18:00:00.000Z",
  today: "2026-09-27",
  weekEnd: "2026-10-03",
  rows: [
    {
      key: "deal:349919419125",
      kind: "deal",
      rank: 1,
      manual: false,
      isNew: false,
      name: "Acastus Knight",
      contactName: "Wayne Hood",
      stage: "Deposit Received",
      bucket: "next_print",
      lane: "plates",
      blocker: "",
      blockerSource: "auto",
      nextStep: "",
      targetDate: "2026-10-01",
      targetSource: "unset",
      tentative: false,
      amount: 40,
      tier: "committed",
      shippingRequired: true,
      dealId: "349919419125",
      offbookId: null,
      bundleId: null,
      fulfillment: null,
      steps: [],
      members: [],
    },
  ],
  outTheDoor: [],
  totals: { committed: 40, stretch: 0, later: 0, outTheDoor: 0, offBookUnpriced: 0 },
  hiddenCount: 0,
};

const REPLACE = {
  ok: false,
  code: "replace_hubspot",
  error: "This contact already has an address. Confirm Replace HubSpot address to overwrite it.",
  current: {
    address: "10 Old Street",
    city: "Romulus",
    state: "Michigan",
    zip: "48174",
    country: "United States",
  },
  next: CORRECTED.suggestion,
};

test("address capture screenshots", { skip: !runAddressCaptureUi, timeout: 180_000 }, async () => {
  mkdirSync(artifactsDir, { recursive: true });
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
        // server still booting
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      sessionStorage.setItem("print-ops-owner-code", "preview");
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/priority-stack") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STACK) });
        return;
      }
      if (url.pathname === "/api/address-capture/apply") {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(REPLACE) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bodyFor(url, route.request().method())),
      });
    });

    const shootClient = async (width: number, height: number, suffix: string) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/order-form/${TOKEN}`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-testid='panel-shipping-address']").waitFor();
      await fillClient(page);
      await page.locator("[data-testid='panel-shipping-address']").screenshot({
        path: join(artifactsDir, suffix === "phone" ? "client-address-form-390.png" : `address-form-${suffix}.png`),
      });
      await page.locator("[data-testid='button-submit-client-details']").click();
      await page.locator("[data-testid='panel-did-you-mean']").waitFor();
      await page.locator("[data-testid='panel-did-you-mean']").screenshot({
        path: join(artifactsDir, `address-did-you-mean-${suffix}.png`),
      });
      await page.locator("[data-testid='button-use-standardized-address']").click();
      await page.locator("[data-testid='panel-label-confirm']").waitFor();
      const confirm = page.locator("[data-testid='panel-label-confirm']");
      const confirmText = await confirm.innerText();
      assert.match(confirmText, /This is exactly what will go on your shipping label/);
      assert.match(confirmText, /Wayne Hood/);
      assert.match(confirmText, /wayne@example.com/);
      assert.match(confirmText, /734-555-0100/);
      assert.match(confirmText, /10909 Hannan Road/);
      assert.match(confirmText, /I confirm my name and shipping address above are correct/);
      const ack = page.locator("[data-testid='checkbox-client-address-ack']");
      const confirmButton = page.locator("[data-testid='button-confirm-label-address']");
      assert.equal(await ack.isChecked(), false);
      assert.equal(await confirmButton.isDisabled(), true);
      await ack.check();
      assert.equal(await confirmButton.isDisabled(), false);
      await page.locator("[data-testid='input-client-phone']").fill("734-555-0199");
      assert.equal(await ack.isChecked(), false);
      assert.equal(await confirmButton.isDisabled(), true);
      await confirm.screenshot({
        path: join(artifactsDir, suffix === "phone" ? "client-address-confirm-390.png" : `address-confirm-${suffix}.png`),
      });
    };

    const shootPaste = async (width: number, height: number, suffix: string) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/paid-orders`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      const current = page.locator("[data-testid='page-transition']").last();
      const paste = current.locator("[data-testid='panel-paste-address']");
      await paste.waitFor();
      await current.locator("[data-testid='input-paste-address']").fill(
        "Wayne Hood\n10909 Hannan Rd\nRomulus, MI 48174\nUnited States",
      );
      const checkPaste = paste.locator("[data-testid='button-check-pasted-address']");
      await checkPaste.click({ force: true });
      await paste.locator("[data-testid='panel-did-you-mean']").waitFor();
      await paste.screenshot({ path: join(artifactsDir, `address-paste-${suffix}.png`) });
    };

    await shootClient(1440, 900, "desktop");
    await shootClient(390, 844, "phone");
    await shootPaste(1440, 900, "desktop");
    await shootPaste(390, 844, "phone");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/stack`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-testid='button-open-deal:349919419125']").click();
    await page.locator("[data-testid='drawer-deal-ops']").waitFor();
    await page.locator("[data-testid='button-drawer-overflow']").click();
    await page.locator("[data-testid='menu-paste-address']").click();
    const drawerPaste = page.locator("[data-testid='panel-paste-address']");
    await drawerPaste.waitFor();
    await page.locator("[data-testid='input-paste-address']").fill("Wayne Hood\n10909 Hannan Rd\nRomulus, MI 48174\nUnited States");
    await drawerPaste.locator("[data-testid='button-check-pasted-address']").click();
    await drawerPaste.locator("[data-testid='panel-did-you-mean']").waitFor();
    await page.locator("[data-testid='drawer-deal-ops']").screenshot({
      path: join(artifactsDir, "drawer-paste-address-1440.png"),
    });
    await drawerPaste.locator("[data-testid='button-use-standardized-address']").click();
    await drawerPaste.locator("[data-testid='button-confirm-label-address']").click();
    await page.locator("[data-testid='panel-replace-hubspot']").waitFor();
    const replaceText = await page.locator("[data-testid='panel-replace-hubspot']").innerText();
    assert.match(replaceText, /Replace HubSpot address/);
    assert.match(replaceText, /Michigan/);
    assert.match(replaceText, /10 Old Street/);
    await page.locator("[data-testid='drawer-deal-ops']").screenshot({
      path: join(artifactsDir, "drawer-replace-hubspot-confirm-1440.png"),
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
});
