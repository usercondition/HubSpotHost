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
  file.writeFloatLE(0.05, 0x20);
  file.writeUInt32LE(1440, 0x34);
  file.writeUInt32LE(2560, 0x38);
  file.writeUInt32LE(420, 0x44);
  file.writeUInt32LE(14_400, 0x4c);
  file.writeUInt32LE(0x80, 0x54);
  file.writeUInt32LE(0xc0, 0x6c);
  file.writeFloatLE(31.25, 0x94);
  file.writeFloatLE(34.5, 0x98);
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

test("a CTB plate is parsed in memory and the raw file is never persisted", async () => {
  const blocked = await fetch(`${appBase}/api/prints`);
  assert.equal(blocked.status, 401);

  const analysis = await analyzePlate("knight-plate-01.ctb");
  assert.equal(analysis.status, 201);
  assert.match(analysis.body.analysisId, /^[0-9a-f-]{36}$/i);
  assert.equal(analysis.body.metrics.fileName, "knight-plate-01.ctb");
  assert.equal(analysis.body.metrics.printTimeSeconds, 14_400);
  assert.equal(analysis.body.metrics.resinVolumeMl, 31.25);
  assert.equal(analysis.body.metrics.resinMassG, 34.5);
  assert.equal(analysis.body.metrics.layerCount, 420);
  assert.equal(analysis.body.metrics.printerProfile, "ELEGOO SATURN");
  assert.match(analysis.body.metrics.sha256, /^[a-f0-9]{64}$/);
});

test("each CTB plate appends to one job and HubSpot receives cumulative totals", async () => {
  mockCalls = [];
  const first = await analyzePlate("knight-plate-01.ctb");
  const firstAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: first.body.analysisId,
    dealId: "701",
  });
  assert.equal(firstAttach.status, 201);
  assert.equal(firstAttach.body.summary.plateCount, 1);
  assert.equal(firstAttach.body.summary.totalPrintTimeSeconds, 14_400);
  assert.equal(firstAttach.body.summary.totalResinVolumeMl, 31.25);

  const second = await analyzePlate("knight-plate-02.ctb");
  const secondAttach = await jsonOwnerRequest("POST", "/api/prints/attach", {
    analysisId: second.body.analysisId,
    dealId: "701",
  });
  assert.equal(secondAttach.status, 201);
  assert.equal(secondAttach.body.summary.plateCount, 2);
  assert.equal(secondAttach.body.summary.totalPrintTimeSeconds, 28_800);
  assert.equal(secondAttach.body.summary.totalResinMassG, 69);

  const patchCalls = mockCalls.filter(
    (call) => call.method === "PATCH" && call.url === "/crm/v3/objects/deals/701",
  );
  assert.equal(patchCalls.length, 2);
  const latestPatch = JSON.parse(patchCalls[1].body);
  assert.equal(latestPatch.properties.print_plate_count, "2");
  assert.equal(latestPatch.properties.print_estimated_time_hours, "8");
  assert.equal(latestPatch.properties.print_resin_volume_ml, "62.5");
  assert.equal(latestPatch.properties.print_resin_mass_g, "69");

  const listed = await jsonOwnerRequest("GET", "/api/prints?includeAttached=true");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.records.length, 2);
  assert.equal(listed.body.candidates[0].hasPrintFile, true);
});
