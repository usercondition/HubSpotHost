/**
 * Prints and the Stack drawer Files upload share one result:
 * a print record, a Drive file, and a Library row. A second upload of the
 * same fingerprint links those instead of adding another plate or copy.
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
import { saveDriveConnection, setDriveFetchForTest } from "../server/lib/google-drive";
import { invalidatePrintOrderDealsCache } from "../server/lib/hubspot";
import { registerRoutes } from "../server/routes";

const dir = mkdtempSync(path.join(os.tmpdir(), "slice-pipeline-"));
const previous = {
  db: process.env.ORDER_LINKS_DB_FILE,
  hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
  client: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  dry: process.env.DRY_RUN,
  writes: process.env.ALLOW_HUBSPOT_WRITES,
  base: process.env.HUBSPOT_API_BASE,
  token: process.env.HUBSPOT_ACCESS_TOKEN,
};

process.env.ORDER_LINKS_DB_FILE = path.join(dir, "test.db");
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("pipeline-owner", "utf8").digest("hex");
process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
process.env.DRY_RUN = "true";
process.env.ALLOW_HUBSPOT_WRITES = "false";
process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
resetOrderLinkStore();

const OWNER = "pipeline-owner";
const dealProps = new Map<string, Record<string, string>>();
let uploads = 0;
let mock: http.Server;
let app: http.Server;
let base = "";

function plate(salt = 0): Buffer {
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
  if (salt) file.writeUInt8(salt, 0x170);
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

async function runPipeline(dealId: string, fileName: string, bytes: Buffer, printerId: number) {
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

  const sha = analysis.metrics.sha256 as string;
  const preparedResponse = await ownerFetch(`${base}/api/plate-files/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderKey: `deal:${dealId}`,
      sha256: sha,
      fileName,
      printRecordId: attached.record.id,
      printer: "MEGA 8K",
      kit: "Castigator",
      customer: "Ada",
    }),
  });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 200, prepared?.error || "prepare failed");
  if (prepared.action === "upload") {
    const uploaded = await ownerFetch(
      `${base}/api/plate-files/upload?${new URLSearchParams({
        orderKey: `deal:${dealId}`,
        fileName,
        printer: "MEGA 8K",
        kit: "Castigator",
        customer: "Ada",
        sha256: sha,
        printRecordId: String(attached.record.id),
      })}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
        body: bytes,
      },
    );
    const uploadBody = await uploaded.json();
    assert.equal(uploaded.status, 201, uploadBody?.error || "upload failed");
  }
  const listed = await ownerFetch(`${base}/api/plate-files?orderKey=${encodeURIComponent(`deal:${dealId}`)}`);
  const library = await listed.json();
  return { analysis, attached, prepared, library };
}

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url || "";
      res.setHeader("content-type", "application/json");
      if (url === "/crm/v3/objects/deals/search") {
        return res.end(
          JSON.stringify({
            results: ["801", "802", "803", "804", "805"].map((id) => ({
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
        return res.end(
          JSON.stringify({
            stages: [{ id: "in_work", label: "In work", displayOrder: 1, metadata: { isClosed: false } }],
          }),
        );
      }
      if (url === "/crm/v3/properties/deals" && req.method === "GET") {
        return res.end(JSON.stringify({ results: [] }));
      }
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
  saveDriveConnection({ email: "miguel@example.com", refreshToken: "refresh-token" });
  setDriveFetchForTest(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-ok" }), { status: 200 });
    }
    if (method === "GET" && url.includes("/drive/v3/files?")) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (method === "POST" && url.includes("/drive/v3/files") && !url.includes("uploadType")) {
      return new Response(JSON.stringify({ id: `folder-${uploads + 1}` }), { status: 200 });
    }
    if (method === "POST" && url.includes("uploadType=resumable")) {
      uploads += 1;
      return new Response(null, { status: 200, headers: { location: `https://upload.example/session-${uploads}` } });
    }
    if (url.startsWith("https://upload.example/session-")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers["content-range"] ?? "");
      const end = match ? Number(match[2]) : 0;
      const total = match ? Number(match[3]) : 0;
      if (match && end + 1 < total) return new Response(null, { status: 308 });
      const id = url.slice("https://upload.example/session-".length);
      return new Response(
        JSON.stringify({
          id: `drive-${id}`,
          name: "plate.ctb",
          webViewLink: `https://drive.google.com/file/d/drive-${id}/view`,
          size: String(total),
          modifiedTime: "2026-09-27T02:15:00.000Z",
          mimeType: "application/octet-stream",
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  });

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
  process.env.ORDER_LINKS_DB_FILE = previous.db;
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous.hash;
  process.env.GOOGLE_OAUTH_CLIENT_ID = previous.client;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret;
  process.env.DRY_RUN = previous.dry;
  process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
  process.env.HUBSPOT_API_BASE = previous.base;
  process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
  resetOrderLinkStore();
  invalidatePrintOrderDealsCache();
});

test("drawer Files upload analyzes, attaches, and registers the library file", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const beforeUploads = uploads;
  const result = await runPipeline("801", "drawer-body.ctb", plate(), printerId);
  assert.equal(result.attached.linked, undefined);
  assert.equal(result.attached.summary.plateCount, 1);
  assert.equal(result.attached.summary.totalResinCost, 4.75);
  assert.equal(result.prepared.action, "upload");
  assert.equal(uploads, beforeUploads + 1);
  assert.equal(result.library.files.length, 1);
  assert.deepEqual(result.library.files[0].printRecordIds, [result.attached.record.id]);
  assert.equal(result.library.files[0].stats.layerCount, 420);
  assert.equal(result.library.files[0].stats.resinVolumeMl, 31.25);
  assert.equal(dealProps.get("801")?.print_plate_count, "1");
  assert.equal(dealProps.get("801")?.print_estimated_resin_cost, "4.75");
});

test("Prints upload analyzes, attaches, and registers the library file", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const beforeUploads = uploads;
  const result = await runPipeline("802", "prints-body.ctb", plate(2), printerId);
  assert.equal(result.attached.summary.plateCount, 1);
  assert.equal(result.prepared.action, "upload");
  assert.equal(uploads, beforeUploads + 1);
  assert.equal(result.library.files.length, 1);
  assert.deepEqual(result.library.files[0].printRecordIds, [result.attached.record.id]);
  assert.equal(result.library.files[0].orderKeys[0], "deal:802");
  assert.equal(dealProps.get("802")?.print_estimated_resin_cost, "4.75");
});

test("a second upload from the other entry point links the record and the Drive file", async () => {
  const fleet = await ownerFetch(`${base}/api/printers`);
  const printers = await fleet.json();
  const printerId = printers.printers[0]?.printerId as number;
  const bytes = plate(3);
  const first = await runPipeline("803", "shared-body.ctb", bytes, printerId);
  const uploadsAfterFirst = uploads;
  const second = await runPipeline("803", "shared-body.ctb", bytes, printerId);
  assert.equal(second.attached.linked, true);
  assert.equal(second.attached.record.id, first.attached.record.id);
  assert.equal(second.attached.summary.plateCount, 1);
  assert.equal(second.attached.summary.totalResinCost, 4.75);
  assert.equal(second.prepared.action, "linked");
  assert.equal(uploads, uploadsAfterFirst);
  assert.equal(second.library.files.length, 1);
  assert.deepEqual(second.library.files[0].printRecordIds, [first.attached.record.id]);
  assert.equal(dealProps.get("803")?.print_plate_count, "1");
  assert.equal(dealProps.get("803")?.print_estimated_resin_cost, "4.75");
});
