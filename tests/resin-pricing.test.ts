/**
 * Resin pricing helpers: Amazon HTML parse, Supplies fallback, CTB enrichment.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `resin-pricing-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update("resin-owner", "utf8")
  .digest("hex");

const store = await import("../server/lib/order-links");
const {
  DEFAULT_RESIN_ASIN,
  enrichPrintFileMetricsWithResinCost,
  estimatePlateResinCost,
  parseAmazonProductPrice,
  refreshResinPriceFromAmazon,
  resinRateFromActiveBottle,
  resinRateFromSupplies,
  resolveResinRate,
  upsertActiveResinProfile,
  getActiveResinProfile,
} = await import("../server/lib/resin-pricing");
const { createSupplyPurchase } = await import("../server/lib/supplies");
const { ensureDefaultResinInventory, openResinBottle, upsertResinProduct } = await import(
  "../server/lib/resin-inventory"
);
const { encryptCtbSettingsBlock, parseCtbFile } = await import("../server/lib/ctb");
const { stagePrintFile } = await import("../server/lib/print-files");

before(() => {
  store.getDb();
});

after(() => {
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* cleanup */
    }
  }
});

test("parseAmazonProductPrice prefers priceToPay amounts", () => {
  const html = `
    <html><body>
      <div id="corePrice_feature_div"></div>
      <script>var x = {"priceToPay":{"amount":35.99,"currency":"USD"}}</script>
      <span class="a-offscreen">$99.99</span>
    </body></html>
  `;
  assert.equal(parseAmazonProductPrice(html), 35.99);
});

test("estimatePlateResinCost keeps Chitubox cost when present", () => {
  const estimate = estimatePlateResinCost(
    { resinCost: 4.5, resinMassG: 34.5, resinVolumeMl: 31.25, resinDensityGPerMl: 1.1 },
    {
      source: "manual",
      bottlePriceUsd: 35.99,
      bottleMassG: 1000,
      bottleVolumeMl: 909,
      label: "manual",
      usdPerGram: 0.03599,
      usdPerMl: 0.0396,
    },
  );
  assert.equal(estimate.resinCost, 4.5);
  assert.equal(estimate.resinCostSource, "ctb");
});

test("estimatePlateResinCost uses profile mass rate when CTB cost is missing", () => {
  upsertActiveResinProfile({
    name: "ELEGOO ABS-Like 3.0 Space Grey",
    amazonAsin: DEFAULT_RESIN_ASIN,
    amazonUrl: `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`,
    bottleMassG: 1000,
    bottleVolumeMl: null,
    bottlePriceUsd: "35.99",
    notes: "",
  });

  const estimate = estimatePlateResinCost({
    resinCost: null,
    resinMassG: 100,
    resinVolumeMl: 90,
    resinDensityGPerMl: 1.1,
  });
  assert.equal(estimate.resinCostSource, "manual");
  assert.equal(estimate.resinCost, 3.6);
  assert.match(estimate.resinCostLabel || "", /ELEGOO/);
});

test("open inventory bottle rate is used when profile price is zero", () => {
  upsertActiveResinProfile({
    name: "ELEGOO ABS-Like 3.0 Space Grey",
    amazonAsin: DEFAULT_RESIN_ASIN,
    amazonUrl: `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`,
    bottleMassG: 1000,
    bottleVolumeMl: null,
    bottlePriceUsd: "0",
    notes: "",
  });
  const products = ensureDefaultResinInventory();
  const product = upsertResinProduct({
    name: products[0]!.name,
    brand: "ELEGOO",
    bottleMassG: 1000,
    unitCostUsd: 40,
    sealedCount: Math.max(1, products[0]!.sealedCount),
    notes: "",
  });
  openResinBottle({ productId: product.id, makeActive: true, notes: "" });

  const inventoryRate = resinRateFromActiveBottle();
  assert.ok(inventoryRate);
  assert.equal(inventoryRate?.source, "inventory");
  assert.equal(inventoryRate?.usdPerGram, 0.04);

  const resolved = resolveResinRate();
  assert.equal(resolved?.source, "inventory");

  const estimate = estimatePlateResinCost({
    resinCost: null,
    resinMassG: 100,
    resinVolumeMl: null,
    resinDensityGPerMl: null,
  });
  assert.equal(estimate.resinCostSource, "inventory");
  assert.equal(estimate.resinCost, 4);
});

test("supplies resin purchases can provide a fallback rate", () => {
  upsertActiveResinProfile({
    name: "ELEGOO ABS-Like 3.0 Space Grey",
    amazonAsin: DEFAULT_RESIN_ASIN,
    amazonUrl: `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`,
    bottleMassG: 1000,
    bottleVolumeMl: null,
    bottlePriceUsd: "0",
    notes: "",
  });
  createSupplyPurchase({
    source: "Amazon",
    orderReference: "111",
    itemName: "ELEGOO ABS-Like 3.0 resin Space Grey 1000g",
    category: "materials",
    quantity: 1,
    totalAmount: "39.99",
    purchasedAt: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  const rate = resinRateFromSupplies();
  assert.ok(rate);
  assert.equal(rate?.source, "supplies");
  assert.ok((rate?.usdPerGram || 0) > 0);

  // Pass supplies rate explicitly — an open inventory bottle from a prior test
  // would otherwise win resolveResinRate() ahead of supplies.
  const estimate = estimatePlateResinCost(
    {
      resinCost: null,
      resinMassG: 100,
      resinVolumeMl: null,
      resinDensityGPerMl: null,
    },
    rate,
  );
  assert.equal(estimate.resinCostSource, "supplies");
  assert.equal(estimate.resinCost, 4);
});

test("refreshResinPriceFromAmazon updates the active profile from HTML", async () => {
  upsertActiveResinProfile({
    name: "ELEGOO ABS-Like 3.0 Space Grey",
    amazonAsin: DEFAULT_RESIN_ASIN,
    amazonUrl: `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`,
    bottleMassG: 1000,
    bottleVolumeMl: null,
    bottlePriceUsd: "10.00",
    notes: "",
  });

  const fakeFetch: typeof fetch = async () =>
    new Response(`<html><script>{"priceToPay":{"amount":35.99}}</script></html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  const refreshed = await refreshResinPriceFromAmazon(fakeFetch);
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.price, 35.99);
  assert.equal(getActiveResinProfile().priceSource, "amazon");
  assert.equal(getActiveResinProfile().bottlePriceUsd, "35.99");
});

test("staging a CTB without slicer cost fills an estimated resin cost", () => {
  upsertActiveResinProfile({
    name: "ELEGOO ABS-Like 3.0 Space Grey",
    amazonAsin: DEFAULT_RESIN_ASIN,
    amazonUrl: `https://www.amazon.com/dp/${DEFAULT_RESIN_ASIN}`,
    bottleMassG: 1000,
    bottleVolumeMl: null,
    bottlePriceUsd: "40.00",
    notes: "",
  });

  const settingsPlain = Buffer.alloc(288, 0);
  settingsPlain.writeFloatLE(31.25, 104);
  settingsPlain.writeFloatLE(34.5, 108);
  // resin cost left at 0
  settingsPlain.writeUInt32LE(100, 76);
  settingsPlain.writeUInt32LE(10, 64);
  const encrypted = encryptCtbSettingsBlock(settingsPlain);
  const file = Buffer.alloc(0x30 + encrypted.length + 16, 0);
  file.writeUInt32LE(0x12fd0107, 0);
  file.writeUInt32LE(encrypted.length, 4);
  file.writeUInt32LE(0x30, 8);
  file.writeUInt32LE(5, 0x10);
  encrypted.copy(file, 0x30);

  const raw = parseCtbFile("plate.ctb", file);
  assert.equal(raw.resinCost, null);
  const staged = stagePrintFile("plate.ctb", file);
  assert.equal(staged.metrics.resinCostSource, "manual");
  assert.equal(staged.metrics.resinCost, 1.38);
  const enriched = enrichPrintFileMetricsWithResinCost(raw);
  assert.equal(enriched.resinCost, 1.38);
});
