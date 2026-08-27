/**
 * Cost-defaults helper: propose material/labor/packaging from plates,
 * write only after explicit confirm.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dbFile = path.join(os.tmpdir(), `cost-defaults-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "cost-owner-code";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");
process.env.DRY_RUN = "true";
process.env.ALLOW_HUBSPOT_WRITES = "false";

const store = await import("../server/lib/order-links");
const {
  assembleCostDefaultsPreview,
  buildCostFieldProposal,
  getDefaultLaborRatePerHour,
  getDefaultPackagingAmount,
} = await import("../server/lib/cost-defaults");
const { registerRoutes } = await import("../server/routes");

interface MockCall {
  method: string;
  url: string;
  body: string;
}

let mock: http.Server;
let app: http.Server;
let appBase = "";
let mockCalls: MockCall[] = [];
let dealCosts: Record<string, string | null> = {
  dealname: "Cost Defaults Order",
  print_material_cost: null,
  print_labor_cost: null,
  print_packaging_cost: null,
  print_actual_shipping_cost: null,
  amount: "150",
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function fixtureCtb(): Buffer {
  const file = Buffer.alloc(0x180);
  file.writeUInt32LE(0x12fd0086, 0x00);
  file.writeUInt32LE(4, 0x04);
  file.writeFloatLE(218, 0x08);
  file.writeFloatLE(123, 0x0c);
  file.writeFloatLE(260, 0x10);
  file.writeFloatLE(42.5, 0x1c);
  file.writeFloatLE(0.05, 0x20);
  file.writeFloatLE(2.5, 0x24);
  file.writeFloatLE(35, 0x28);
  file.writeFloatLE(1, 0x2c);
  file.writeUInt32LE(8, 0x30);
  file.writeUInt32LE(1440, 0x34);
  file.writeUInt32LE(2560, 0x38);
  file.writeUInt32LE(420, 0x44);
  file.writeUInt32LE(14_400, 0x4c);
  file.writeUInt32LE(0x80, 0x54);
  file.writeUInt32LE(0x40, 0x58);
  file.writeUInt32LE(0xc0, 0x6c);
  file.writeFloatLE(8, 0x80);
  file.writeFloatLE(65, 0x84);
  file.writeFloatLE(5, 0x88);
  file.writeFloatLE(120, 0x8c);
  file.writeFloatLE(150, 0x90);
  file.writeFloatLE(31.25, 0x94);
  file.writeFloatLE(34.5, 0x98);
  file.writeFloatLE(4.75, 0x9c);
  file.writeFloatLE(2, 0xa0);
  file.writeFloatLE(0.5, 0xa4);
  file.writeUInt32LE(8, 0xa8);
  file.writeUInt32LE(0x100, 0xdc);
  file.writeUInt32LE(13, 0xe0);
  file.write("ELEGOO SATURN", 0x100, "ascii");
  return file;
}

async function jsonOwnerRequest(method: string, url: string, body?: unknown) {
  const response = await fetch(`${appBase}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function analyzeAndAttach() {
  const form = new FormData();
  form.append("file", new Blob([fixtureCtb()]), "cost-plate.ctb");
  const analyzed = await fetch(`${appBase}/api/prints/analyze`, {
    method: "POST",
    headers: { "x-paid-order-access-code": OWNER_CODE },
    body: form,
  });
  const analysis = (await analyzed.json()) as any;
  assert.equal(analyzed.status, 201);
  const attached = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: analysis.analysisId,
    dealId: "801",
    ...(analysis.printerMatch?.requiresPrinterChoice
      ? { printerId: analysis.printerMatch.printers[0]?.id }
      : {}),
  });
  assert.equal(attached.status, 201);
  return attached.body;
}

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const call = { method: req.method || "", url: req.url || "", body };
      mockCalls.push(call);
      res.setHeader("content-type", "application/json");

      if (call.url === "/crm/v3/objects/deals/search") {
        return res.end(
          JSON.stringify({
            results: [
              {
                id: "801",
                properties: {
                  dealname: "Cost Defaults Order",
                  pipeline: "default",
                  dealstage: "in_work",
                },
              },
            ],
          }),
        );
      }
      if (call.url === "/crm/v3/pipelines/deals/default") {
        return res.end(
          JSON.stringify({
            stages: [{ id: "in_work", label: "In work", displayOrder: 2, metadata: { isClosed: false } }],
          }),
        );
      }
      if (call.url.startsWith("/crm/v3/objects/deals/801") && call.method === "GET") {
        return res.end(JSON.stringify({ id: "801", properties: { ...dealCosts } }));
      }
      if (call.url === "/crm/v3/objects/deals/801" && call.method === "PATCH") {
        const parsed = JSON.parse(body) as { properties: Record<string, string> };
        dealCosts = { ...dealCosts, ...parsed.properties };
        return res.end(JSON.stringify({ id: "801", properties: dealCosts }));
      }
      if (call.url === "/crm/v3/properties/deals" && call.method === "GET") {
        return res.end(JSON.stringify({ results: [] }));
      }
      return res.end(JSON.stringify({ id: "ok" }));
    });
  });
  const mockPort = await listen(mock);
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_URL;
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN;

  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  const port = await listen(app);
  appBase = `http://127.0.0.1:${port}`;
});

after(() => {
  mock?.close();
  app?.close();
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* test cleanup */
    }
  }
});

test("default labor and free USPS packaging costs are zero", () => {
  delete process.env.COST_DEFAULT_LABOR_RATE_USD_PER_HOUR;
  delete process.env.COST_DEFAULT_PACKAGING_USD;
  assert.equal(getDefaultLaborRatePerHour(), 0);
  assert.equal(getDefaultPackagingAmount(), 0);
});

test("existing cost fields are skipped unless overwrite is enabled", () => {
  const skipped = buildCostFieldProposal({
    field: "material",
    property: "print_material_cost",
    label: "Material cost",
    proposed: 9.5,
    current: 12,
    source: "plates",
    include: true,
    overwrite: false,
  });
  assert.equal(skipped.willWrite, false);
  assert.match(skipped.skipReason || "", /Already set/);

  const overwritten = buildCostFieldProposal({
    ...skipped,
    include: true,
    overwrite: true,
    proposed: 9.5,
    current: 12,
    source: "plates",
    field: "material",
    property: "print_material_cost",
    label: "Material cost",
  });
  assert.equal(overwritten.willWrite, true);
  assert.equal(overwritten.proposed, 9.5);
});

test("labor is skipped by default because the quote includes it", () => {
  const preview = assembleCostDefaultsPreview({
    dealId: "801",
    dealName: "Cost Defaults Order",
    plateCount: 2,
    totalPrintTimeSeconds: 28_800,
    totalResinCost: 9.5,
    currentMaterial: null,
    currentLabor: null,
    currentPackaging: null,
    currentShipping: null,
    laborRatePerHour: 25,
    packagingAmount: 5,
    includeShipping: false,
  });
  assert.equal(preview.totalPrintHours, 8);
  const labor = preview.fields.find((field) => field.field === "labor");
  assert.equal(labor?.proposed, 200);
  assert.equal(labor?.willWrite, false);
  assert.match(labor?.skipReason || "", /Not selected|quote/i);
  assert.match(labor?.source || "", /included in the quoted order amount/i);

  const withLabor = assembleCostDefaultsPreview({
    dealId: "801",
    dealName: "Cost Defaults Order",
    plateCount: 2,
    totalPrintTimeSeconds: 28_800,
    totalResinCost: 9.5,
    currentMaterial: null,
    currentLabor: null,
    currentPackaging: null,
    currentShipping: null,
    laborRatePerHour: 25,
    packagingAmount: 5,
    includeLabor: true,
  });
  assert.equal(withLabor.fields.find((field) => field.field === "labor")?.willWrite, true);
});

test("preview and confirm-apply write cost fields then recalculate", async () => {
  mockCalls = [];
  dealCosts = {
    dealname: "Cost Defaults Order",
    print_material_cost: null,
    print_labor_cost: null,
    print_packaging_cost: null,
    print_actual_shipping_cost: null,
    amount: "150",
  };

  await analyzeAndAttach();

  const blocked = await fetch(`${appBase}/api/prints/cost-defaults/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dealId: "801" }),
  });
  assert.equal(blocked.status, 401);

  const noConfirm = await jsonOwnerRequest("POST", "/api/prints/cost-defaults/apply", {
    dealId: "801",
    includeShipping: true,
    shippingAmount: 8.4,
  });
  assert.equal(noConfirm.status, 400);

  const preview = await jsonOwnerRequest("POST", "/api/prints/cost-defaults/preview", {
    dealId: "801",
    includeShipping: true,
    shippingAmount: 8.4,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.plateCount, 1);
  const material = preview.body.preview.fields.find((field: any) => field.field === "material");
  const labor = preview.body.preview.fields.find((field: any) => field.field === "labor");
  const packaging = preview.body.preview.fields.find((field: any) => field.field === "packaging");
  const shipping = preview.body.preview.fields.find((field: any) => field.field === "shipping");
  assert.equal(material.proposed, 4.75);
  assert.equal(labor.willWrite, false);
  assert.equal(packaging.proposed, 0);
  assert.equal(shipping.proposed, 8.4);
  assert.equal(material.willWrite, true);

  const dryBlocked = await jsonOwnerRequest("POST", "/api/prints/cost-defaults/apply", {
    dealId: "801",
    confirm: true,
    includeShipping: true,
    shippingAmount: 8.4,
  });
  assert.equal(dryBlocked.status, 503);

  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    mockCalls = [];
    const applied = await jsonOwnerRequest("POST", "/api/prints/cost-defaults/apply", {
      dealId: "801",
      confirm: true,
      includeShipping: true,
      shippingAmount: 8.4,
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.written.length, 3);
    assert.equal(dealCosts.print_material_cost, "4.75");
    assert.equal(dealCosts.print_labor_cost, null);
    assert.equal(dealCosts.print_packaging_cost, "0");
    assert.equal(dealCosts.print_actual_shipping_cost, "8.4");
    assert.equal(applied.body.recalculated, true);

    const patches = mockCalls.filter(
      (call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/801",
    );
    assert.ok(patches.length >= 2);
    const costPatch = patches.find((call) =>
      Object.prototype.hasOwnProperty.call(JSON.parse(call.body).properties, "print_material_cost"),
    );
    assert.ok(costPatch);
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});
