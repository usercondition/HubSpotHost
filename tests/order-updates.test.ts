import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { appendOrderUpdate, listOrderUpdates } from "../server/lib/order-updates";
import { registerRoutes } from "../server/routes";
import { formatPacificUpdateStamp } from "../shared/ship-by";

test("Pacific update stamps spell the shop clock", () => {
  assert.equal(formatPacificUpdateStamp("2026-09-27T00:31:00.000Z"), "Sep 26, 5:31 PM");
  assert.equal(formatPacificUpdateStamp("not-a-date"), "");
});

test("order updates append, stay newest-first, and survive reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "order-updates-"));
  const previous = process.env.ORDER_LINKS_DB_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  resetOrderLinkStore();
  try {
    const first = appendOrderUpdate({
      orderKey: "deal:81",
      text: "Supports looked thin on the left leg.",
      source: "voice",
      author: "Miguel",
      now: new Date("2026-09-26T20:00:00.000Z"),
    });
    const second = appendOrderUpdate({
      orderKey: "deal:81",
      text: "Reprinted the leg. Do not pack the first one.",
      source: "manual",
      author: "Miguel",
      now: new Date("2026-09-26T22:15:00.000Z"),
    });
    appendOrderUpdate({
      orderKey: "offbook:4",
      text: "Friend pickup is the sword only.",
      source: "voice",
      author: "Miguel",
      now: new Date("2026-09-26T22:20:00.000Z"),
    });
    const listed = listOrderUpdates("deal:81");
    assert.deepEqual(listed.map((entry) => entry.id), [second.id, first.id]);
    assert.equal(listed[0].text, "Reprinted the leg. Do not pack the first one.");
    assert.equal(listed[1].text, "Supports looked thin on the left leg.");
    assert.equal(listed[0].createdAt, "2026-09-26T22:15:00.000Z");
    assert.notEqual(listed[0].text, listed[1].text);
    resetOrderLinkStore();
    const reopened = listOrderUpdates("deal:81");
    assert.equal(reopened.length, 2);
    assert.equal(reopened[1].text, first.text);
    assert.equal(listOrderUpdates("offbook:4")[0].text, "Friend pickup is the sword only.");
    assert.equal(listOrderUpdates("deal:999").length, 0);
  } finally {
    resetOrderLinkStore();
    if (previous === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update log routes are owner-gated, append-only, and do not call HubSpot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "order-updates-http-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
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
  resetOrderLinkStore();
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-paid-order-access-code": "stack-test" };
  try {
    const locked = await fetch(`${base}/api/priority-stack/updates?key=deal:81`);
    assert.equal(locked.status, 401);

    const mismatch = await fetch(`${base}/api/priority-stack/updates?key=deal:81`, {
      headers: { "x-paid-order-access-code": "nope" },
    });
    assert.equal(mismatch.status, 401);

    const blank = await fetch(`${base}/api/priority-stack/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "deal:81", text: "   " }),
    });
    assert.equal(blank.status, 400);

    const bundle = await fetch(`${base}/api/priority-stack/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "bundle:9", text: "no", source: "manual", author: "Miguel" }),
    });
    assert.equal(bundle.status, 400);

    const voice = await fetch(`${base}/api/priority-stack/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: "deal:81",
        text: "Left leg supports failed. Reprint that piece.",
        source: "voice",
        author: "Miguel",
      }),
    });
    assert.equal(voice.status, 201);
    const voiceBody = await voice.json();
    assert.equal(voiceBody.ok, true);
    assert.equal(voiceBody.entry.source, "voice");
    assert.equal(voiceBody.entry.author, "Miguel");
    assert.match(voiceBody.entry.createdAt, /Z$/);

    const manual = await fetch(`${base}/api/priority-stack/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "deal:81", text: "Packed the reprint, not the first leg." }),
    });
    assert.equal(manual.status, 201);
    const manualBody = await manual.json();
    assert.equal(manualBody.entry.source, "manual");
    assert.equal(manualBody.entry.author, "Miguel");

    const offbook = await fetch(`${base}/api/priority-stack/updates`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key: "offbook:4", text: "Sword only.", source: "voice", author: "Miguel" }),
    });
    assert.equal(offbook.status, 201);

    const listed = await fetch(`${base}/api/priority-stack/updates?key=${encodeURIComponent("deal:81")}`, { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.deepEqual(
      listedBody.entries.map((entry: { text: string }) => entry.text),
      ["Packed the reprint, not the first leg.", "Left leg supports failed. Reprint that piece."],
    );
    assert.equal(listedBody.entries[1].text, voiceBody.entry.text);

    const removed = await fetch(`${base}/api/priority-stack/updates/${voiceBody.entry.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(removed.status, 404);
    const still = listOrderUpdates("deal:81");
    assert.equal(still.length, 2);
    assert.equal(calls.length, 0);
  } finally {
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
    rmSync(dir, { recursive: true, force: true });
  }
});
