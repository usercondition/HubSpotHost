/**
 * End-to-end route tests against a local mock HubSpot API.
 * No test in this file can reach hubapi.com: the API base is pointed at a
 * throwaway localhost server for the duration of the run.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { registerRoutes } from "../server/routes";
import { computeV1Signature, computeV3Signature } from "../server/lib/signature";
import { resetAudit } from "../server/lib/audit";

interface MockCall {
  method: string;
  url: string;
  body: string;
}

let mock: http.Server;
let mockCalls: MockCall[] = [];
let mockBase = "";
let app: http.Server;
let appBase = "";

const DEAL_PROPS: Record<string, string> = {
  amount: "150",
  print_material_cost: "18",
  print_labor_cost: "45",
  print_packaging_cost: "4",
  print_actual_shipping_cost: "9",
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      mockCalls.push({ method: req.method || "", url: req.url || "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "901", properties: DEAL_PROPS }));
    });
  });
  const mockPort = await listen(mock);
  mockBase = `http://127.0.0.1:${mockPort}`;

  process.env.HUBSPOT_API_BASE = mockBase;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_URL;
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN;
  delete process.env.HUBSPOT_WEBHOOK_SECRET;
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";

  const expressApp = express();
  expressApp.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  const appPort = await listen(app);
  appBase = `http://127.0.0.1:${appPort}`;
  process.env.PUBLIC_BASE_URL = appBase;
});

after(() => {
  mock.close();
  app.close();
});

function reset() {
  mockCalls = [];
  resetAudit();
}

test("dry-run recalculation computes but never PATCHes", async () => {
  reset();
  const res = await fetch(`${appBase}/api/recalculate/901`, { method: "POST" });
  const body = await res.json();
  assert.equal(body.status, "dry-run");
  assert.equal(body.grossProfit, 74);
  assert.equal(body.marginPercentage, 49.33);
  assert.equal(mockCalls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(mockCalls.filter((c) => c.method === "GET").length, 1);
});

test("a live-write request is still blocked while DRY_RUN is true", async () => {
  reset();
  const res = await fetch(`${appBase}/api/recalculate/901?dryRun=false`, { method: "POST" });
  const body = await res.json();
  assert.equal(body.status, "dry-run");
  assert.match(body.gate, /DRY_RUN/);
  assert.equal(mockCalls.filter((c) => c.method === "PATCH").length, 0);
});

test("all gates open writes both output properties", async () => {
  reset();
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const res = await fetch(`${appBase}/api/recalculate/901?dryRun=false`, { method: "POST" });
    const body = await res.json();
    assert.equal(body.status, "written");
    const patch = mockCalls.find((c) => c.method === "PATCH");
    assert.ok(patch);
    assert.deepEqual(JSON.parse(patch!.body), {
      properties: { print_gross_profit: "74.00", print_margin_percentage: "49.33" },
    });
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("webhook batch de-duplicates deals and skips output events", async () => {
  reset();
  const payload = [
    { objectId: 901, objectTypeId: "0-3", propertyName: "amount" },
    { objectId: 901, objectTypeId: "0-3", property: "print_labor_cost" },
    { objectId: 901, objectTypeId: "0-3", propertyname: "print_gross_profit" },
    { objectId: 902, objectTypeId: "0-1", propertyName: "amount" },
  ];
  const res = await fetch(`${appBase}/api/webhooks/hubspot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(body.deals, 1);
  assert.equal(body.matched, 2);
  assert.equal(body.ignoredOutputEvents, 1);
  assert.equal(body.ignoredOther, 1);
  assert.equal(body.dryRun, 1);
  assert.equal(mockCalls.filter((c) => c.method === "GET").length, 1);
});

test("verified webhook writes automatically once its server gates are opened", async () => {
  reset();
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const payload = [
      { objectId: 901, objectTypeId: "0-3", propertyName: "print_material_cost" },
    ];
    const res = await fetch(`${appBase}/api/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    assert.equal(body.written, 1);
    assert.equal(mockCalls.filter((c) => c.method === "PATCH").length, 1);
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("webhook rejects a bad v1 signature and accepts a good one", async () => {
  reset();
  process.env.HUBSPOT_WEBHOOK_SECRET = "shh";
  try {
    const raw = JSON.stringify([{ objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]);
    const bad = await fetch(`${appBase}/api/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hubspot-signature": "nope" },
      body: raw,
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${appBase}/api/webhooks/hubspot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hubspot-signature": computeV1Signature("shh", raw),
      },
      body: raw,
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).deals, 1);
  } finally {
    delete process.env.HUBSPOT_WEBHOOK_SECRET;
  }
});

test("health exposes only non-sensitive details about the latest rejected webhook", async () => {
  reset();
  process.env.HUBSPOT_WEBHOOK_SECRET = "diagnostic-secret";
  try {
    const rejected = await fetch(`${appBase}/api/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]),
    });
    assert.equal(rejected.status, 401);

    const health = await fetch(`${appBase}/api/health`);
    const body = await health.json();
    assert.equal(body.webhook.latestDelivery.result, "rejected");
    assert.equal(
      body.webhook.latestDelivery.reason,
      "no HubSpot signature header present; callback token missing or invalid",
    );
    assert.equal(JSON.stringify(body).includes("diagnostic-secret"), false);
  } finally {
    delete process.env.HUBSPOT_WEBHOOK_SECRET;
  }
});

test("callback token authorizes a private-app delivery when signatures do not match", async () => {
  reset();
  const callbackToken = "test-callback-token";
  process.env.HUBSPOT_WEBHOOK_SECRET = "shh";
  process.env.HUBSPOT_CALLBACK_TOKEN_SHA256 = crypto
    .createHash("sha256")
    .update(callbackToken, "utf8")
    .digest("hex");
  try {
    const res = await fetch(`${appBase}/api/webhooks/hubspot?key=${callbackToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).signature, "secure callback token valid");
  } finally {
    delete process.env.HUBSPOT_WEBHOOK_SECRET;
    delete process.env.HUBSPOT_CALLBACK_TOKEN_SHA256;
  }
});

test("webhook accepts a valid v3 signature", async () => {
  reset();
  process.env.HUBSPOT_WEBHOOK_SECRET = "shh";
  try {
    const raw = JSON.stringify([{ objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]);
    const ts = String(Date.now());
    const uri = `${appBase}/api/webhooks/hubspot`;
    const res = await fetch(uri, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hubspot-request-timestamp": ts,
        "x-hubspot-signature-v3": computeV3Signature("shh", "POST", uri, raw, ts),
      },
      body: raw,
    });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.HUBSPOT_WEBHOOK_SECRET;
  }
});

test("audit log retains at most 100 entries and hides raw payloads", async () => {
  reset();
  for (let i = 0; i < 103; i++) {
    await fetch(`${appBase}/api/recalculate/${900 + i}`, { method: "POST" });
  }
  const res = await fetch(`${appBase}/api/calculations`);
  const body = await res.json();
  assert.equal(body.count, 100);
  assert.equal(body.entries.length, 100);
  assert.equal(body.entries[0].outputs.print_gross_profit, 74);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("test-token"), false);
  assert.equal(serialized.includes("propertyName"), false);
});

test("health reports dry-run readiness and unconfigured signing", async () => {
  const res = await fetch(`${appBase}/api/health`);
  const body = await res.json();
  assert.equal(body.mode, "dry-run");
  assert.equal(body.safety.liveWriteReady, false);
  assert.equal(body.webhook.verification, "not-configured");
  assert.equal(body.credentials.tokenConfigured, true);
  assert.equal(JSON.stringify(body).includes("test-token"), false);
});

test("public production mode fails closed and protects control endpoints", async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.HUBSPOT_WEBHOOK_SECRET;
  try {
    const webhook = await fetch(`${appBase}/api/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ objectId: 901, objectTypeId: "0-3", propertyName: "amount" }]),
    });
    assert.equal(webhook.status, 503);

    const manual = await fetch(`${appBase}/api/recalculate/901`, { method: "POST" });
    assert.equal(manual.status, 403);

    const audit = await fetch(`${appBase}/api/calculations`);
    assert.equal(audit.status, 403);

    const health = await fetch(`${appBase}/api/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.admin.publicControlsEnabled, false);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});
