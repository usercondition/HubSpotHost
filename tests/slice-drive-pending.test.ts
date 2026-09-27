/**
 * Drive disconnected: Prints and the Stack drawer still attach the print
 * record and keep a pending Library row. A second attach links that record
 * and does not add the cost again.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { mkdtempSync } from "node:fs";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { setDriveFetchForTest } from "../server/lib/google-drive";
import { invalidatePrintOrderDealsCache } from "../server/lib/hubspot";
import { registerRoutes } from "../server/routes";

const dir = mkdtempSync(path.join(os.tmpdir(), "slice-drive-down-"));
process.env.ORDER_LINKS_DB_FILE = path.join(dir, "test.db");
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("drive-down-owner", "utf8").digest("hex");
process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
process.env.DRY_RUN = "true";
process.env.ALLOW_HUBSPOT_WRITES = "false";
process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
resetOrderLinkStore();

const OWNER = "drive-down-owner";
const dealProps = new Map<string, Record<string, string>>();
let driveCalls = 0;
let mock: http.Server;
let app: http.Server;
let base = "";

function plate(salt: number): Buffer {
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
  file.writeUInt8(salt, 0x170);
  return file;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function ownerFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-paid-order-access-code", OWNER);
  return fetch(url, { ...init, headers });
}

async function runPath(dealId: string, fileName: string, bytes: Buffer, printerId: number) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), fileName);
  const analyzed = await ownerFetch(`${base}/api/prints/analyze`, { method: "POST", body: form });
  const analysis = await analyzed.json();
  assert.equal(analyzed.status, 201, analysis?.error || "analyze failed");
  const attachedResponse = await ownerFetch(`${base}/api/prints/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ analysisId: analysis.analysisId, dealId, printerId }),
  });
  const attached = await attachedResponse.json();
  assert.ok(attachedResponse.status === 200 || attachedResponse.status === 201, attached?.error || "attach failed");
  const preparedResponse = await ownerFetch(`${base}/api/plate-files/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderKey: `deal:${dealId}`,
      sha256: analysis.metrics.sha256,
      fileName,
      printRecordId: attached.record.id,
      printer: "MEGA 8K",
      kit: "Castigator",
      customer: "Ada",
    }),
  });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 200, prepared?.error || "prepare failed");
  const listed = await ownerFetch(`${base}/api/plate-files?orderKey=${encodeURIComponent(`deal:${dealId}`)}`);
  const library = await listed.json();
  return { attached, prepared, library };
}

before(async () => {
  setDriveFetchForTest(async () => {
    driveCalls += 1;
    return new Response("drive should stay disconnected", { status: 500 });
  });
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url || "";
      res.setHeader("content-type", "application/json");
      if (url === "/crm/v3/objects/deals/search") {
        return res.end(
          JSON.stringify({
            results: ["901", "902"].map((id) => ({
              id,
              properties: {
                dealname: `Order ${id} - Ada`,
                pipeline: "default",
                dealstage: "in_work",
                ...(dealProps.get(id) ?? {}),
              },
            })),
          }),
        );
      }
      if (url === "/crm/v3/pipelines/deals/default") {
        return res.end(JSON.stringify({ stages: [{ id: "in_work", label: "In work", displayOrder: 1, metadata: { isClosed: false } }] }));
      }
      if (url === "/crm/v3/properties/deals" && req.method === "GET") return res.end(JSON.stringify({ results: [] }));
      const dealMatch = /^\/crm\/v3\/objects\/deals\/(\d+)/.exec(url);
      if (dealMatch && req.method === "GET") {
        return res.end(JSON.stringify({ id: dealMatch[1], properties: dealProps.get(dealMatch[1]!) ?? {} }));
      }
      if (dealMatch && req.method === "PATCH") {
        const id = dealMatch[1]!;
        const next = { ...(dealProps.get(id) ?? {}), ...JSON.parse(body).properties };
        dealProps.set(id, next);
        return res.end(JSON.stringify({ id, properties: next }));
      }
      if (url.includes("/associations/")) return res.end(JSON.stringify({ results: [] }));
      return res.end(JSON.stringify({ id: "ok" }));
    });
  });
  const mockPort = await listen(mock);
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  invalidatePrintOrderDealsCache();
  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  base = `http://127.0.0.1:${await listen(app)}`;
});

after(() => {
  mock?.close();
  app?.close();
  setDriveFetchForTest(null);
  resetOrderLinkStore();
  invalidatePrintOrderDealsCache();
});

test("drawer upload with Drive disconnected still attaches and saves a pending row", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const result = await runPath("901", "drawer-offline.ctb", plate(1), printerId);
  assert.equal(result.prepared.action, "pending");
  assert.equal(result.attached.summary.plateCount, 1);
  assert.equal(result.attached.summary.totalResinCost, 4.75);
  assert.equal(result.library.files.length, 0);
  assert.equal(result.library.pending.length, 1);
  assert.equal(result.library.pending[0].printRecordId, result.attached.record.id);
  assert.equal(result.library.pending[0].error, "Not in Library yet.");
  assert.equal(driveCalls, 0);
  assert.equal(dealProps.get("901")?.print_plate_count, "1");
  assert.equal(dealProps.get("901")?.print_estimated_resin_cost, "4.75");
});

test("Prints upload with Drive disconnected still attaches and saves a pending row", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const result = await runPath("902", "prints-offline.ctb", plate(2), printerId);
  assert.equal(result.prepared.action, "pending");
  assert.equal(result.library.files.length, 0);
  assert.equal(result.library.pending.length, 1);
  assert.equal(result.library.pending[0].error, "Not in Library yet.");
  assert.equal(result.attached.summary.totalResinCost, 4.75);
  assert.equal(driveCalls, 0);
});

test("re-attaching the same file while Drive is down does not add a second record or cost", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const bytes = plate(2);
  const again = await runPath("902", "prints-offline.ctb", bytes, printerId);
  assert.equal(again.attached.linked, true);
  assert.equal(again.attached.summary.plateCount, 1);
  assert.equal(again.attached.summary.totalResinCost, 4.75);
  assert.equal(again.library.pending.length, 1);
  assert.equal(again.library.files.length, 0);
  assert.equal(dealProps.get("902")?.print_plate_count, "1");
  assert.equal(dealProps.get("902")?.print_estimated_resin_cost, "4.75");
  assert.equal(driveCalls, 0);
});
