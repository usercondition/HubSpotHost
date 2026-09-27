import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore, getSqlite } from "../server/lib/order-links";
import { Readable } from "node:stream";
import { setDriveFetchForTest, uploadDriveFile } from "../server/lib/google-drive";
import { listPlateFiles } from "../server/lib/plate-files";
import { registerRoutes } from "../server/routes";
import { guessPlatePrinter, isPlateFileName, orderFolderName, DRIVE_FILE_SCOPE } from "../shared/plate-files";

const REFRESH = "REFRESHTOKENMARKER-do-not-log";

test("plate names, printer guesses, and Drive folder titles", () => {
  assert.equal(isPlateFileName("Castigator_MEGA_8K.CTB"), true);
  assert.equal(isPlateFileName("notes.txt"), false);
  assert.equal(guessPlatePrinter("Castigator_MEGA_8K.ctb"), "MEGA 8K");
  assert.equal(guessPlatePrinter("land-raider-12k.ctb"), "Mighty 12K");
  assert.equal(guessPlatePrinter("helmet-heygears.prz"), "HeyGears");
  assert.equal(guessPlatePrinter("bit-8k.ctb"), "Mighty 8K");
  assert.equal(guessPlatePrinter("plain.stl"), "");
  assert.equal(orderFolderName("Castigator", "Ada", "deal:123"), "Castigator \u2013 Ada (123)");
  assert.equal(orderFolderName("Sword", "Glenn", "offbook:4"), "Sword \u2013 Glenn (offbook:4)");
});

test("slice library uploads, search, index, and Google connect stay owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plate-files-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
    client: process.env.GOOGLE_OAUTH_CLIENT_ID,
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    origin: process.env.PUBLIC_BASE_URL,
  };
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  const calls: string[] = [];
  const mock = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "drive-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "drive-secret";
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "calendar-token-stays-put";
  process.env.PUBLIC_BASE_URL = "https://hubspothost-production.up.railway.app";
  resetOrderLinkStore();

  let mode: "ok" | "no-id" | "invalid" = "ok";
  let pendingName = "";
  setDriveFetchForTest(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("oauth2.googleapis.com/token")) {
      if (mode === "invalid") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      const params = new URLSearchParams(String(init?.body ?? ""));
      if (params.get("grant_type") === "authorization_code") {
        return new Response(JSON.stringify({ access_token: "access-ok", refresh_token: REFRESH }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: "access-ok" }), { status: 200 });
    }
    if (url.includes("/about")) {
      return new Response(JSON.stringify({ user: { emailAddress: "miguel.plates@gmail.com" } }), { status: 200 });
    }
    if (method === "GET" && url.includes("/drive/v3/files?")) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (method === "POST" && url.includes("/drive/v3/files") && !url.includes("uploadType")) {
      return new Response(JSON.stringify({ id: "folder-1" }), { status: 200 });
    }
    if (method === "POST" && url.includes("uploadType=resumable")) {
      pendingName = JSON.parse(String(init?.body ?? "{}")).name ?? "file.ctb";
      return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
    }
    if (url.startsWith("https://upload.example/session")) {
      if (mode === "no-id") return new Response(JSON.stringify({ name: pendingName }), { status: 200 });
      return new Response(
        JSON.stringify({
          id: `id-${pendingName}`,
          name: pendingName,
          webViewLink: `https://drive.google.com/file/d/id-${encodeURIComponent(pendingName)}/view`,
          size: "11",
          modifiedTime: "2026-09-26T20:00:00.000Z",
          mimeType: "application/octet-stream",
        }),
        { status: 200 },
      );
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
  const headers = { "x-paid-order-access-code": "stack-test" };

  async function upload(name: string, orderKey: string, bytes = "slice-bytes") {
    return fetch(
      `${base}/api/plate-files/upload?${new URLSearchParams({
        orderKey,
        fileName: name,
        printer: guessPlatePrinter(name),
        kit: name.includes("Land") ? "Land Raider" : "Castigator",
        customer: orderKey.startsWith("offbook:") ? "Glenn" : "Ada",
      }).toString()}`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(Buffer.byteLength(bytes)) },
        body: bytes,
      },
    );
  }

  try {
    const locked = await fetch(`${base}/api/google/drive`);
    assert.equal(locked.status, 401);
    const lockedStart = await fetch(`${base}/api/google/oauth/start`);
    assert.equal(lockedStart.status, 401);

    const start = await fetch(`${base}/api/google/oauth/start`, { headers });
    assert.equal(start.status, 200);
    const startBody = await start.json();
    const authUrl = new URL(startBody.url);
    assert.equal(authUrl.searchParams.get("scope"), DRIVE_FILE_SCOPE);
    assert.equal(authUrl.searchParams.get("access_type"), "offline");
    assert.equal(authUrl.searchParams.get("prompt"), "consent");
    assert.equal(authUrl.searchParams.get("include_granted_scopes"), "false");
    assert.equal(
      authUrl.searchParams.get("redirect_uri"),
      "https://hubspothost-production.up.railway.app/api/google/oauth/callback",
    );
    const state = authUrl.searchParams.get("state") || "";
    const callback = await fetch(`${base}/api/google/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/#/setup");
    const status = await fetch(`${base}/api/google/drive`, { headers });
    const statusBody = await status.json();
    assert.equal(statusBody.connected, true);
    assert.equal(statusBody.email, "miguel.plates@gmail.com");
    assert.equal(statusBody.reconnect, false);
    assert.equal(JSON.stringify(statusBody).includes(REFRESH), false);
    const stored = getSqlite().prepare(`SELECT refresh_token_enc FROM google_drive_connection WHERE id = 1`).get() as { refresh_token_enc: string };
    assert.equal(stored.refresh_token_enc.includes(REFRESH), false);
    assert.notEqual(stored.refresh_token_enc, REFRESH);

    calls.length = 0;
    mode = "ok";
    const ok = await upload("Castigator_MEGA_8K.ctb", "deal:81");
    assert.equal(ok.status, 201);
    const okBody = await ok.json();
    assert.equal(okBody.file.driveFileId, "id-Castigator_MEGA_8K.ctb");
    assert.equal(okBody.file.printer, "MEGA 8K");
    assert.equal(okBody.file.source, "upload");
    assert.deepEqual(okBody.file.orderKeys, ["deal:81"]);

    mode = "no-id";
    const failed = await upload("Land_Raider_12K.ctb", "deal:81");
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.equal(failedBody.ok, false);
    const afterFail = await fetch(`${base}/api/plate-files?orderKey=${encodeURIComponent("deal:81")}`, { headers });
    const afterFailBody = await afterFail.json();
    assert.equal(afterFailBody.files.length, 1);
    assert.equal(afterFailBody.failures.length, 1);
    assert.equal(afterFailBody.failures[0].name, "Land_Raider_12K.ctb");

    mode = "ok";
    const retried = await upload("Land_Raider_12K.ctb", "deal:81");
    assert.equal(retried.status, 201);
    const retriedBody = await retried.json();
    assert.ok(retriedBody.file.driveFileId);
    const afterRetry = listPlateFiles({ orderKey: "deal:81" });
    assert.equal(afterRetry.failures.length, 0);
    assert.equal(afterRetry.files.length, 2);

    await assert.rejects(
      () =>
        uploadDriveFile({
          access: "access-ok",
          folderId: "folder-1",
          name: "partial.ctb",
          size: 50,
          body: Readable.from([Buffer.from("short")]),
        }),
      /did not confirm/,
    );
    assert.equal(listPlateFiles({ q: "partial" }).files.length, 0);

    const offbook = await upload("Sword_8K.stl", "offbook:4");
    assert.equal(offbook.status, 201);
    assert.equal(calls.length, 0);

    const found = await fetch(`${base}/api/plate-files?q=${encodeURIComponent("Land Raider")}`, { headers });
    const foundBody = await found.json();
    assert.equal(foundBody.files.length, 1);
    assert.equal(foundBody.files[0].customer, "Ada");
    const byPrinter = await fetch(`${base}/api/plate-files?printer=${encodeURIComponent("Mighty 8K")}`, { headers });
    const byPrinterBody = await byPrinter.json();
    assert.equal(byPrinterBody.files.length, 1);
    assert.equal(byPrinterBody.files[0].name, "Sword_8K.stl");

    const indexed = await fetch(`${base}/api/plate-files`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        files: [
          {
            driveFileId: "existing-raider",
            name: "Land_Raider_old.ctb",
            webViewLink: "https://drive.google.com/file/d/existing-raider/view",
            sizeBytes: 50,
            modifiedAt: "2026-08-01T12:00:00.000Z",
            printer: "Mighty 12K",
            kit: "Land Raider",
            customer: "Daniel Ortega",
            kitTags: "Land Raider",
            orderKeys: ["deal:456"],
          },
        ],
      }),
    });
    assert.equal(indexed.status, 200);
    const indexedBody = await indexed.json();
    assert.equal(indexedBody.files[0].source, "indexed");
    assert.deepEqual(indexedBody.files[0].orderKeys, ["deal:456"]);

    const keepLinks = await fetch(`${base}/api/plate-files`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        files: [
          {
            driveFileId: "existing-raider",
            name: "Land_Raider_old.ctb",
            printer: "Mighty 12K",
            kit: "Land Raider",
            customer: "Daniel Ortega",
            notes: "retitled",
          },
        ],
      }),
    });
    const keepBody = await keepLinks.json();
    assert.deepEqual(keepBody.files[0].orderKeys, ["deal:456"]);
    assert.equal(keepBody.files[0].notes, "retitled");

    const linked = await fetch(`${base}/api/plate-files/link`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ driveFileId: "existing-raider", orderKey: "offbook:4" }),
    });
    assert.equal(linked.status, 200);
    const linkedBody = await linked.json();
    assert.deepEqual(linkedBody.file.orderKeys, ["deal:456", "offbook:4"]);

    const unlinked = await fetch(`${base}/api/plate-files/unlink`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ driveFileId: "existing-raider", orderKey: "deal:456" }),
    });
    const unlinkedBody = await unlinked.json();
    assert.deepEqual(unlinkedBody.file.orderKeys, ["offbook:4"]);

    const wiped = await fetch(`${base}/api/plate-files`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ driveFileId: "id-Castigator_MEGA_8K.ctb", name: "Castigator_MEGA_8K.ctb", orderKeys: [] }],
      }),
    });
    const wipedBody = await wiped.json();
    assert.equal(wipedBody.files[0].source, "upload");
    assert.deepEqual(wipedBody.files[0].orderKeys, []);

    mode = "invalid";
    const revoked = await upload("Helmet.ctb", "deal:81");
    assert.equal(revoked.status, 409);
    const revokedBody = await revoked.json();
    assert.equal(revokedBody.reconnect, true);
    const reconnect = await fetch(`${base}/api/google/drive`, { headers });
    const reconnectBody = await reconnect.json();
    assert.equal(reconnectBody.reconnect, true);
    assert.equal(reconnectBody.connected, false);
    assert.equal(listPlateFiles({ q: "Helmet" }).files.length, 0);

    const disconnected = await fetch(`${base}/api/google/drive/disconnect`, { method: "POST", headers });
    const disconnectedBody = await disconnected.json();
    assert.equal(disconnectedBody.connected, false);
    assert.equal(disconnectedBody.reconnect, false);

    const expired = await fetch(`${base}/api/google/oauth/callback?code=nope&state=missing`, { redirect: "manual" });
    assert.equal(expired.status, 400);
    const expiredText = await expired.text();
    assert.equal(expiredText.includes(REFRESH), false);
    assert.match(expiredText, /did not connect/);

    const blob = logs.join("\n");
    assert.equal(blob.includes(REFRESH), false);
    assert.equal(calls.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setDriveFetchForTest(null);
    server.close();
    mock.close();
    resetOrderLinkStore();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("ORDER_LINKS_DB_FILE", previous.db);
    restore("DRY_RUN", previous.dry);
    restore("ALLOW_HUBSPOT_WRITES", previous.writes);
    restore("HUBSPOT_API_BASE", previous.base);
    restore("HUBSPOT_ACCESS_TOKEN", previous.token);
    restore("PAID_ORDER_INTAKE_ACCESS_CODE_HASH", previous.hash);
    restore("GOOGLE_OAUTH_CLIENT_ID", previous.client);
    restore("GOOGLE_OAUTH_CLIENT_SECRET", previous.secret);
    restore("GOOGLE_OAUTH_REFRESH_TOKEN", previous.refresh);
    restore("PUBLIC_BASE_URL", previous.origin);
    rmSync(dir, { recursive: true, force: true });
  }
});
