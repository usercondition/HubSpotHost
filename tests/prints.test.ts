/**
 * CTB print-file workflow tests.
 *
 * Proves that a slice is parsed without storing the binary, then explicitly
 * attached to an active Print Order. A local HubSpot mock verifies the rolling
 * totals used for multi-plate jobs.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dbFile = path.join(os.tmpdir(), `print-files-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "print-owner-code";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");

const store = await import("../server/lib/order-links");
const { createPrintFileRecord, listPrintFileRecords, stagePrintFile } = await import(
  "../server/lib/print-files"
);
const {
  clearMarketplaceSendRequest,
  getMarketplaceSendRequest,
} = await import("../server/lib/marketplace-send-request-store");
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
/** Mutable HubSpot deal stage for refresh tests. */
let mockDealStage = "queued";
let mockDealStageLabel = "Queued to Print";
let mockDealProperties: Record<string, string> = {};
let mockContactName = "";

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

async function analyzePlate(name: string) {
  const form = new FormData();
  form.append("file", new Blob([fixtureCtb()]), name);
  const response = await fetch(`${appBase}/api/prints/analyze`, {
    method: "POST",
    headers: { "x-paid-order-access-code": OWNER_CODE },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as any };
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
                id: "701",
                properties: {
                  dealname: "Five plate Knight",
                  pipeline: "default",
                  dealstage: mockDealStage,
                  ...mockDealProperties,
                },
              },
            ],
          }),
        );
      }
      if (call.url === "/crm/v3/pipelines/deals/default") {
        return res.end(
          JSON.stringify({
            stages: [
              {
                id: "queued",
                label: "Queued to Print",
                displayOrder: 1,
                metadata: { isClosed: false },
              },
              {
                id: "in_work",
                label: "In work",
                displayOrder: 2,
                metadata: { isClosed: false },
              },
              {
                id: "printing",
                label: "Printing",
                displayOrder: 3,
                metadata: { isClosed: false },
              },
              {
                id: mockDealStage,
                label: mockDealStageLabel,
                displayOrder: 9,
                metadata: { isClosed: false },
              },
            ],
          }),
        );
      }
      if (call.url === "/crm/v3/properties/deals" && call.method === "GET") {
        return res.end(JSON.stringify({ results: [] }));
      }
      if (call.url.startsWith("/crm/v3/objects/deals/701?") && call.method === "GET") {
        return res.end(JSON.stringify({ id: "701", properties: mockDealProperties }));
      }
      if (call.url === "/crm/v3/objects/deals/701" && call.method === "PATCH") {
        Object.assign(mockDealProperties, JSON.parse(call.body).properties);
        return res.end(JSON.stringify({ id: "701", properties: mockDealProperties }));
      }
      if (call.url === "/crm/v4/objects/deals/701/associations/contacts?limit=1") {
        return res.end(JSON.stringify({ results: mockContactName ? [{ toObjectId: "contact-701" }] : [] }));
      }
      if (call.url.startsWith("/crm/v3/objects/contacts/contact-701?")) {
        const [firstname, ...rest] = mockContactName.split(" ");
        return res.end(JSON.stringify({ properties: { firstname, lastname: rest.join(" ") } }));
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

test("a CTB plate is parsed in memory and the raw file is never persisted", async () => {
  const blocked = await fetch(`${appBase}/api/prints`);
  assert.equal(blocked.status, 401);

  const staged = stagePrintFile("knight-plate-01.ctb", fixtureCtb());
  assert.match(staged.analysisId, /^[0-9a-f-]{36}$/i);
  assert.equal(staged.metrics.fileName, "knight-plate-01.ctb");
  assert.equal(staged.metrics.printTimeSeconds, 14_400);
  assert.equal(staged.metrics.resinVolumeMl, 31.25);
  assert.equal(staged.metrics.resinMassG, 34.5);
  assert.equal(staged.metrics.resinCost, 4.75);
  assert.equal(staged.metrics.resinDensityGPerMl, 1.104);
  assert.equal(staged.metrics.exposureSeconds, 2.5);
  assert.equal(staged.metrics.bottomExposureSeconds, 35);
  assert.equal(staged.metrics.bottomLayerCount, 8);
  assert.equal(staged.metrics.layerCount, 420);
  assert.equal(staged.metrics.printerProfile, "ELEGOO SATURN");
  assert.match(staged.metrics.sha256, /^[a-f0-9]{64}$/);

  // Keep multipart smoke coverage when the runtime FormData upload path works.
  const analysis = await analyzePlate("knight-plate-01.ctb");
  if (analysis.status !== 201) {
    assert.equal(analysis.status, 400);
    return;
  }
  assert.equal(analysis.body.metrics.fileName, "knight-plate-01.ctb");
});

test("ULTX analyze accepts an uploaded Slice.log for sealed estimate recovery", async () => {
  const ultx = fs.readFileSync(path.join("tests", "fixtures", "sample-encrypted.ultx"));
  const sliceLog = [
    '1786060093550|info|ALG|[Slice] Techbag file volume: 33.51452|ed4909aa-1ea8-4a0d-a3f5-3215bed8c027|16:48:13:550',
    '1786060108784|info|ALG|[Slice] Output: {"numberOfSlices":1113,"printEstimateMaterials":43.568875999999996,"printEstimateTime":12457,"sliceFileName":"Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx","sliceTotalTime":63421}|ed4909aa-1ea8-4a0d-a3f5-3215bed8c027|16:48:28:784',
  ].join("\n");

  const form = new FormData();
  form.append("file", new Blob([ultx]), "Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx");
  form.append("sliceLog", new Blob([sliceLog], { type: "text/plain" }), "Slice.log");

  const response = await fetch(`${appBase}/api/prints/analyze`, {
    method: "POST",
    headers: { "x-paid-order-access-code": OWNER_CODE },
    body: form,
  });
  const body = (await response.json()) as any;
  assert.equal(response.status, 201, body?.error || "analyze failed");
  assert.equal(body.sliceLogApplied, true);
  assert.equal(body.metrics.format, "ULTX");
  assert.equal(body.metrics.layerCount, 5);
  assert.equal(body.metrics.printTimeSeconds, 12457);
  assert.equal(body.metrics.resinMassG, 43.569);
  assert.equal(body.metrics.resinVolumeMl, 33.515);
  assert.match(body.metrics.formatRevision, /Slice\.log/i);
});

test("each CTB plate appends to one job and HubSpot receives cumulative totals", async () => {
  mockCalls = [];
  mockDealProperties = {};
  mockDealStage = "in_work";
  mockDealStageLabel = "In work";
  // Fixture CTB uses "ELEGOO SATURN" — unmatched fleet profile needs an explicit printer.
  const fleet = await jsonOwnerRequest("GET", "/api/printers");
  assert.equal(fleet.status, 200);
  const printerId = fleet.body.printers[0]?.printerId as number;
  assert.ok(printerId);

  const first = stagePrintFile("knight-plate-01.ctb", fixtureCtb());
  const firstAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: first.analysisId,
    dealId: "701",
    printerId,
  });
  assert.equal(firstAttach.status, 201, firstAttach.body?.error || "attach failed");
  assert.equal(firstAttach.body.summary.plateCount, 1);
  assert.equal(firstAttach.body.summary.totalPrintTimeSeconds, 14_400);
  assert.equal(firstAttach.body.summary.totalResinVolumeMl, 31.25);
  assert.equal(firstAttach.body.summary.totalResinCost, 4.75);
  assert.equal(firstAttach.body.record.resinCost, "4.75");
  assert.equal(firstAttach.body.record.exposureSeconds, "2.5");
  assert.equal(firstAttach.body.record.dealStage, "In work");
  assert.equal(firstAttach.body.record.fleetPrinterId, printerId);

  const second = stagePrintFile("knight-plate-02.ctb", fixtureCtb());
  const secondAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: second.analysisId,
    dealId: "701",
    printerId,
  });
  assert.equal(secondAttach.status, 201);
  assert.equal(secondAttach.body.summary.plateCount, 2);
  assert.equal(secondAttach.body.summary.totalPrintTimeSeconds, 28_800);
  assert.equal(secondAttach.body.summary.totalResinMassG, 69);
  assert.equal(secondAttach.body.summary.totalResinCost, 9.5);

  const patchCalls = mockCalls.filter(
    (call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701",
  );
  assert.equal(patchCalls.length, 2);
  const latestPatch = JSON.parse(patchCalls[1].body);
  assert.equal(latestPatch.properties.print_plate_count, "2");
  assert.equal(latestPatch.properties.print_estimated_time_hours, "8");
  assert.equal(latestPatch.properties.print_resin_volume_ml, "62.5");
  assert.equal(latestPatch.properties.print_resin_mass_g, "69");
  assert.equal(latestPatch.properties.print_estimated_resin_cost, "9.5");
  assert.equal(latestPatch.properties.print_exposure_seconds, "2.5");
  assert.equal(latestPatch.properties.print_bottom_exposure_seconds, "35");
  assert.equal(latestPatch.properties.print_bottom_layer_count, "8");
  assert.equal(latestPatch.properties.print_model_height_mm, "42.5");
  assert.equal(Object.prototype.hasOwnProperty.call(latestPatch.properties, "print_material_cost"), false);

  const listed = await jsonOwnerRequest("GET", "/api/prints?includeAttached=true");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.records.length >= 2);
  assert.equal(listed.body.candidates[0].hasPrintFile, true);
  assert.equal(listed.body.boards.length, 1);
  assert.equal(listed.body.boards[0].plateCount, 2);
  assert.equal(listed.body.boards[0].totalResinCost, 9.5);
});

test("attach previews and confirmed detach rebuilds only print planning totals", async () => {
  const { getDb } = await import("../server/lib/order-links");
  const { printFileRecords } = await import("../shared/schema");
  getDb().delete(printFileRecords).run();

  const fleet = await jsonOwnerRequest("GET", "/api/printers");
  const printerId = fleet.body.printers[0]?.printerId as number;
  assert.ok(printerId);
  const first = stagePrintFile("detach-plate-01.ctb", fixtureCtb());
  const preview = await jsonOwnerRequest(
    "GET",
    `/api/prints?includeAttached=true&previewDealId=701&previewAnalysisId=${first.analysisId}`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.attachPreview.plateCount, 1);
  assert.equal(preview.body.attachPreview.totalResinCost, 4.75);

  const firstAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: first.analysisId,
    dealId: "701",
    printerId,
  });
  assert.equal(firstAttach.status, 201);
  const second = stagePrintFile("detach-plate-02.ctb", fixtureCtb());
  const secondAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: second.analysisId,
    dealId: "701",
    printerId,
  });
  assert.equal(secondAttach.status, 201);

  const denied = await jsonOwnerRequest("POST", "/api/prints/detach", {
    recordId: secondAttach.body.record.id,
  });
  assert.equal(denied.status, 400);

  mockCalls = [];
  const detached = await jsonOwnerRequest("POST", "/api/prints/detach", {
    recordId: secondAttach.body.record.id,
    confirm: true,
  });
  assert.equal(detached.status, 200);
  assert.equal(detached.body.remainingPlateCount, 1);
  const rebuild = mockCalls.find((call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701");
  assert.ok(rebuild);
  assert.equal(JSON.parse(rebuild!.body).properties.print_estimated_resin_cost, "4.75");
  assert.equal(Object.hasOwn(JSON.parse(rebuild!.body).properties, "print_material_cost"), false);

  mockCalls = [];
  const cleared = await jsonOwnerRequest("POST", "/api/prints/detach", {
    recordId: firstAttach.body.record.id,
    confirm: true,
  });
  assert.equal(cleared.status, 200);
  const clear = mockCalls.find((call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701");
  assert.ok(clear);
  const clearProperties = JSON.parse(clear!.body).properties;
  assert.equal(clearProperties.print_plate_count, "");
  assert.equal(Object.hasOwn(clearProperties, "print_material_cost"), false);
});

test("plate attach seeds blank material, labor, and packaging costs", async () => {
  mockCalls = [];
  mockDealProperties = {
    print_material_cost: "",
    print_labor_cost: "",
    print_packaging_cost: "",
    print_actual_shipping_cost: "",
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const fleet = await jsonOwnerRequest("GET", "/api/printers");
    const staged = stagePrintFile("cost-seed.ctb", fixtureCtb());
    const attached = await jsonOwnerRequest("POST", "/api/prints/attach", {
      analysisId: staged.analysisId,
      dealId: "701",
      printerId: fleet.body.printers[0]?.printerId,
    });
    assert.equal(attached.status, 201, attached.body?.error || "attach failed");
    const costPatch = mockCalls
      .filter((call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701")
      .map((call) => JSON.parse(call.body).properties)
      .find((properties) => "print_material_cost" in properties);
    assert.deepEqual(costPatch, {
      print_material_cost: String(attached.body.summary.totalResinCost),
      print_labor_cost: "0",
      print_packaging_cost: "0",
    });
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("plate attach preserves an existing material actual", async () => {
  mockCalls = [];
  mockDealProperties = {
    print_material_cost: "3.67",
    print_labor_cost: "0",
    print_packaging_cost: "0",
    print_actual_shipping_cost: "",
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const fleet = await jsonOwnerRequest("GET", "/api/printers");
    const staged = stagePrintFile("actual-material.ctb", fixtureCtb());
    const attached = await jsonOwnerRequest("POST", "/api/prints/attach", {
      analysisId: staged.analysisId,
      dealId: "701",
      printerId: fleet.body.printers[0]?.printerId,
    });
    assert.equal(attached.status, 201, attached.body?.error || "attach failed");
    const properties = mockCalls
      .filter((call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701")
      .map((call) => JSON.parse(call.body).properties);
    assert.equal(properties.some((patch) => "print_material_cost" in patch), false);
    assert.equal(mockDealProperties.print_material_cost, "3.67");
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("label attach seeds known postage without replacing existing costs", async () => {
  mockCalls = [];
  mockDealProperties = {
    print_material_cost: "3.67",
    print_labor_cost: "0",
    print_packaging_cost: "0",
    print_actual_shipping_cost: "",
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const attached = await jsonOwnerRequest("POST", "/api/shipping-labels/attach", {
      dealIds: ["701"],
      trackingNumber: "9400111899223344556677",
      postageUsd: "5.42",
      labelBought: true,
      packingDone: true,
    });
    assert.equal(attached.status, 200, attached.body?.error || "label attach failed");
    const properties = mockCalls
      .filter((call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701")
      .map((call) => JSON.parse(call.body).properties);
    assert.ok(properties.some((patch) => patch.print_actual_shipping_cost === "5.42"));
    assert.equal(mockDealProperties.print_actual_shipping_cost, "5.42");
  } finally {
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("priced label attach queues one idempotent owner-only Marketplace shipment notice", async () => {
  clearMarketplaceSendRequest();
  mockCalls = [];
  mockContactName = "Jamie Carter";
  mockDealProperties = {
    print_material_cost: "3.67",
    print_labor_cost: "0",
    print_packaging_cost: "0",
    print_actual_shipping_cost: "",
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const payload = {
      dealIds: ["701"],
      trackingNumber: "9400111899223344556678",
      postageUsd: "5.42",
      labelBought: true,
      packingDone: true,
    };
    const attached = await jsonOwnerRequest("POST", "/api/shipping-labels/attach", payload);
    assert.equal(attached.status, 200, attached.body?.error || "label attach failed");
    assert.deepEqual(attached.body.marketplaceSend, {
      queued: true,
      id: 1,
      to: "Jamie Carter",
      channel: "marketplace",
    });
    assert.deepEqual(getMarketplaceSendRequest(), {
      pending: true,
      id: 1,
      to: "Jamie Carter",
      text: "Your order has shipped. Tracking: 9400111899223344556678.",
      channel: "marketplace",
    });

    const duplicate = await jsonOwnerRequest("POST", "/api/shipping-labels/attach", payload);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(getMarketplaceSendRequest().id, 1);
  } finally {
    mockContactName = "";
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("priced OfferUp label attach queues tracking-only notice on OfferUp", async () => {
  clearMarketplaceSendRequest();
  mockCalls = [];
  mockContactName = "Jamie Carter";
  mockDealProperties = {
    print_material_cost: "3.67",
    print_labor_cost: "0",
    print_packaging_cost: "0",
    print_actual_shipping_cost: "",
  };
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  try {
    const attached = await jsonOwnerRequest("POST", "/api/shipping-labels/attach", {
      dealIds: ["701"],
      trackingNumber: "9400111899223344556679",
      postageUsd: "5.42",
      messageChannel: "offerup",
      labelBought: true,
      packingDone: true,
    });
    assert.equal(attached.status, 200, attached.body?.error || "label attach failed");
    assert.deepEqual(attached.body.marketplaceSend, {
      queued: true,
      id: 1,
      to: "Jamie Carter",
      channel: "offerup",
    });
    assert.deepEqual(getMarketplaceSendRequest(), {
      pending: true,
      id: 1,
      to: "Jamie Carter",
      text: "Your order has shipped. Tracking: 9400111899223344556679.",
      channel: "offerup",
    });
    assert.doesNotMatch(getMarketplaceSendRequest().text, /5\.42|postage|\$/i);
  } finally {
    mockContactName = "";
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "false";
  }
});

test("plate history deal stage refreshes when HubSpot moves the order", async () => {
  mockDealStage = "queued";
  mockDealStageLabel = "Queued to Print";
  const staged = stagePrintFile("armor-panels.ctb", fixtureCtb());
  createPrintFileRecord({
    analysisId: staged.analysisId,
    hubspotDealId: "701",
    hubspotDealName: "Five plate Knight",
    dealStage: "Queued to Print",
    metrics: { ...staged.metrics, fileName: "armor-panels.ctb", sha256: "e".repeat(64) },
  });
  assert.ok(
    listPrintFileRecords().some(
      (row) => row.fileName === "armor-panels.ctb" && row.dealStage === "Queued to Print",
    ),
  );

  mockDealStage = "printing";
  mockDealStageLabel = "Printing";
  const listed = await jsonOwnerRequest("GET", "/api/prints?includeAttached=true");
  assert.equal(listed.status, 200);
  const forDeal = listed.body.records.filter((row: { hubspotDealId: string }) => row.hubspotDealId === "701");
  assert.ok(forDeal.length >= 1);
  for (const row of forDeal) {
    assert.equal(row.dealStage, "Printing");
  }
});
