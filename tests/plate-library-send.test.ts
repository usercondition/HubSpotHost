import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore, getSqlite } from "../server/lib/order-links";
import { saveDriveConnection, setDriveFetchForTest } from "../server/lib/google-drive";
import { registerRoutes } from "../server/routes";
import { sliceFingerprint } from "../server/lib/ctb";

function redPlate(): Buffer {
  const file = Buffer.alloc(0x180);
  file.writeUInt32LE(0x12fd0086, 0);
  file.writeUInt32LE(0x100, 0x3c);
  file.writeUInt32LE(2, 0x100);
  file.writeUInt32LE(2, 0x104);
  file.writeUInt32LE(0x120, 0x108);
  file.writeUInt32LE(4, 0x10c);
  file[0x120] = 0x20;
  file[0x121] = 0xf8;
  file[0x122] = 3;
  file[0x123] = 0x30;
  return file;
}

test("prints plates link into the library once, and downloads stream with Range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plate-send-"));
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
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
  process.env.DRY_RUN = "true";
  process.env.ALLOW_HUBSPOT_WRITES = "false";
  process.env.HUBSPOT_API_BASE = "http://127.0.0.1:9";
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  resetOrderLinkStore();
  saveDriveConnection({ email: "miguel@example.com", refreshToken: "refresh-token" });

  let uploads = 0;
  let mediaRange = "";
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
      return new Response(JSON.stringify({ id: "folder-1" }), { status: 200 });
    }
    if (method === "POST" && url.includes("uploadType=resumable")) {
      uploads += 1;
      return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
    }
    if (url.startsWith("https://upload.example/session")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers["content-range"] ?? "");
      const end = match ? Number(match[2]) : 0;
      const total = match ? Number(match[3]) : 0;
      if (match && end + 1 < total) return new Response(null, { status: 308 });
      return new Response(
        JSON.stringify({
          id: "drive-cerastus",
          name: "MEGA 8K Cerastus Body Only.ctb",
          webViewLink: "https://drive.google.com/file/d/drive-cerastus/view",
          size: String(total),
          modifiedTime: "2026-09-27T02:15:00.000Z",
          mimeType: "application/octet-stream",
        }),
        { status: 200 },
      );
    }
    if (url.includes("alt=media")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      mediaRange = headers.range || "";
      return new Response("abcd", {
        status: 206,
        headers: { "content-range": "bytes 0-3/400", "content-length": "4", "content-type": "application/octet-stream" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });

  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-paid-order-access-code": "stack-test", "content-type": "application/json" };
  const plate = redPlate();
  const sha = sliceFingerprint(plate.length, plate);
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO print_file_records (
         analysis_id, hubspot_deal_id, hubspot_deal_name, file_name, file_size_bytes, sha256, format_revision, hubspot_synced_at, attached_at
       ) VALUES ('analysis-38', '349919419125', 'Castigator - Ada', 'MEGA 8K Cerastus Body Only.ctb', ?, ?, 'CTB', ?, ?)`,
    )
    .run(plate.length, sha, now, now);

  try {
    const prepare = await fetch(`${base}/api/plate-files/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderKey: "deal:349919419125",
        sha256: sha,
        fileName: "MEGA 8K Cerastus Body Only.ctb",
        printRecordId: 1,
        printer: "MEGA 8K",
        kit: "Castigator",
        customer: "Ada",
      }),
    });
    assert.equal(prepare.status, 200);
    const prepareBody = await prepare.json();
    assert.equal(prepareBody.action, "upload");

    const uploaded = await fetch(
      `${base}/api/plate-files/upload?${new URLSearchParams({
        orderKey: "deal:349919419125",
        fileName: "MEGA 8K Cerastus Body Only.ctb",
        printer: "MEGA 8K",
        kit: "Castigator",
        customer: "Ada",
        sha256: sha,
        printRecordId: "1",
      })}`,
      {
        method: "POST",
        headers: { "x-paid-order-access-code": "stack-test", "content-type": "application/octet-stream", "content-length": String(plate.length) },
        body: plate,
      },
    );
    assert.equal(uploaded.status, 201);
    const uploadedBody = await uploaded.json();
    assert.equal(uploadedBody.file.sha256, sha);
    assert.deepEqual(uploadedBody.file.printRecordIds, [1]);
    assert.equal(uploadedBody.file.hasPreview, true);
    assert.equal(uploads, 1);

    const again = await fetch(`${base}/api/plate-files/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderKey: "deal:349919419125",
        sha256: sha,
        fileName: "MEGA 8K Cerastus Body Only.ctb",
        printRecordId: 1,
        kit: "Castigator",
        customer: "Ada",
      }),
    });
    const againBody = await again.json();
    assert.equal(againBody.action, "linked");
    assert.equal(uploads, 1);

    const preview = await fetch(`${base}/api/plate-previews/${sha}`, { headers: { "x-paid-order-access-code": "stack-test" } });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type") || "", /png/);
    const png = Buffer.from(await preview.arrayBuffer());
    assert.equal(png[0], 0x89);

    const lockedPreview = await fetch(`${base}/api/plate-previews/${sha}`);
    assert.equal(lockedPreview.status, 401);

    const ticket = await fetch(`${base}/api/plate-files/download`, {
      method: "POST",
      headers,
      body: JSON.stringify({ driveFileId: "drive-cerastus" }),
    });
    const ticketBody = await ticket.json();
    assert.equal(ticketBody.fallback, false);
    const ranged = await fetch(`${base}${ticketBody.url}`, { headers: { range: "bytes=0-3" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 0-3/400");
    assert.match(ranged.headers.get("content-disposition") || "", /Cerastus Body Only\.ctb/);
    assert.equal(await ranged.text(), "abcd");
    assert.equal(mediaRange, "bytes=0-3");

    const indexed = await fetch(`${base}/api/plate-files`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: [{ driveFileId: "old-indexed", name: "old.ctb", orderKeys: ["deal:349919419125"] }],
      }),
    });
    assert.equal(indexed.status, 200);
    const indexedDownload = await fetch(`${base}/api/plate-files/download`, {
      method: "POST",
      headers,
      body: JSON.stringify({ driveFileId: "old-indexed" }),
    });
    const indexedBody = await indexedDownload.json();
    assert.equal(indexedBody.fallback, true);
    assert.match(indexedBody.webViewLink, /old-indexed/);

    getSqlite().prepare(`DELETE FROM google_drive_connection`).run();
    getSqlite()
      .prepare(
        `INSERT INTO print_file_records (
           analysis_id, hubspot_deal_id, hubspot_deal_name, file_name, file_size_bytes, sha256, format_revision, hubspot_synced_at, attached_at
         ) VALUES ('analysis-39', '349919419125', 'Castigator - Ada', 'other.ctb', 10, ?, 'CTB', ?, ?)`,
      )
      .run("b".repeat(64), now, now);
    const offline = await fetch(`${base}/api/plate-files/prepare`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderKey: "deal:349919419125",
        sha256: "b".repeat(64),
        fileName: "other.ctb",
        printRecordId: 2,
        kit: "Castigator",
        customer: "Ada",
      }),
    });
    const offlineBody = await offline.json();
    assert.equal(offlineBody.action, "pending");
    const listed = await fetch(`${base}/api/plate-files?orderKey=deal:349919419125`, { headers: { "x-paid-order-access-code": "stack-test" } });
    const listedBody = await listed.json();
    assert.equal(listedBody.pending.length, 1);
    assert.match(listedBody.pending[0].error, /Not in Library yet/);
    assert.equal(uploads, 1);
  } finally {
    server.close();
    setDriveFetchForTest(null);
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.hash === undefined) delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
    else process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous.hash;
    if (previous.client === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = previous.client;
    if (previous.secret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previous.secret;
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  }
});
