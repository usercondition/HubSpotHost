/**
 * Screenshots for foolproof address capture: client form, Did you mean,
 * label confirmation, and owner paste-to-fill. Desktop 1440 and phone 390.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
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

test("address capture screenshots", { timeout: 180_000 }, async () => {
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
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
        path: `/opt/cursor/artifacts/address-form-${suffix}.png`,
      });
      await page.locator("[data-testid='button-submit-client-details']").click();
      await page.locator("[data-testid='panel-did-you-mean']").waitFor();
      await page.locator("[data-testid='panel-did-you-mean']").screenshot({
        path: `/opt/cursor/artifacts/address-did-you-mean-${suffix}.png`,
      });
      await page.locator("[data-testid='button-use-standardized-address']").click();
      await page.locator("[data-testid='panel-label-confirm']").waitFor();
      const confirmText = await page.locator("[data-testid='panel-label-confirm']").innerText();
      assert.match(confirmText, /This is exactly what will go on your shipping label/);
      assert.match(confirmText, /10909 Hannan Road/);
      await page.locator("[data-testid='panel-label-confirm']").screenshot({
        path: `/opt/cursor/artifacts/address-confirm-${suffix}.png`,
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
      await paste.screenshot({ path: `/opt/cursor/artifacts/address-paste-${suffix}.png` });
    };

    await shootClient(1440, 900, "desktop");
    await shootClient(390, 844, "phone");
    await shootPaste(1440, 900, "desktop");
    await shootPaste(390, 844, "phone");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
});
