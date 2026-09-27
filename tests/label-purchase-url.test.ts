/**
 * A paid ShipEngine label must still return its URL when the follow-up
 * HubSpot contact read fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEAL = "44021";
const LABEL_URL = "https://api.shipengine.com/v1/downloads/paid-label.pdf";

test("a bought label URL survives a failed follow-up contact read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "label-url-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    key: process.env.SHIPENGINE_API_KEY,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
  };
  const owner = "label-url-owner";
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  process.env.HUBSPOT_API_BASE = "http://hubspot.test";
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.SHIPENGINE_API_KEY = "TEST_key";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update(owner, "utf8").digest("hex");
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_URL;
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN;

  const { registerRoutes } = await import("../server/routes");
  const { resetOrderLinkStore } = await import("../server/lib/order-links");
  const { expireDealContactCache, invalidateDealContactCache } = await import("../server/lib/deal-ops");
  const { resetAddressCheckOutage } = await import("../server/lib/address-checks");
  resetOrderLinkStore();
  resetAddressCheckOutage();
  invalidateDealContactCache();

  let bought = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return originalFetch(input, init);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/v1/addresses/validate")) {
      return json([
        {
          status: "verified",
          matched_address: {
            address_line1: "10909 Hannan Rd",
            address_line2: "",
            city_locality: "Romulus",
            state_province: "MI",
            postal_code: "48174",
            country_code: "US",
          },
          messages: [],
        },
      ]);
    }
    if (url.includes("/v1/labels/rates/")) {
      bought = true;
      expireDealContactCache(DEAL);
      return json({
        label_id: "se_label_paid",
        status: "completed",
        tracking_number: "1ZPAIDLABEL",
        tracking_url: "https://track.example/1ZPAIDLABEL",
        label_download: { pdf: LABEL_URL },
        shipment_cost: { amount: 8.4, currency: "usd" },
      });
    }
    if (url.includes("/associations/contacts") || url.includes("/crm/v3/objects/contacts/")) {
      if (bought) return json({ message: "contact read failed" }, 500);
      if (url.includes("/associations/contacts")) return json({ results: [{ toObjectId: "55" }] });
      return json({
        id: "55",
        properties: {
          firstname: "Wayne",
          lastname: "Hood",
          email: "wayne@example.com",
          phone: "734-555-0100",
          address: "10909 Hannan Rd",
          city: "Romulus",
          state: "MI",
          zip: "48174",
          country: "US",
        },
      });
    }
    if (url.includes("/pipelines/")) {
      return json({
        stages: [{ id: "closedwon", label: "Closed Won", displayOrder: 2, metadata: { isClosed: "true" } }],
      });
    }
    return json({ results: [] });
  }) as typeof fetch;

  const expressApp = express();
  expressApp.use(express.json());
  const app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
  const port = (app.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/shipping-labels/shipengine/purchase`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paid-order-access-code": owner,
      },
      body: JSON.stringify({
        dealIds: [DEAL],
        rateId: "se_rate_paid",
        liveWrite: false,
      }),
    });
    const body = (await response.json()) as { shipengine?: { labelUrl?: string }; warning?: string; ok?: boolean; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.shipengine?.labelUrl, LABEL_URL);
    assert.match(body.warning ?? "", /contact|HubSpot/i);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => app.close(() => resolve()));
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    if (previous.key === undefined) delete process.env.SHIPENGINE_API_KEY;
    else process.env.SHIPENGINE_API_KEY = previous.key;
    if (previous.hash === undefined) delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
    else process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous.hash;
  }
});
