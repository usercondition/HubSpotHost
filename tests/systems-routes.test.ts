import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { normalizeHeartbeat, registerSystemsRoutes } from "../server/lib/systems-routes";

test("systems heartbeat normalizes supported statuses", () => {
  assert.deepEqual(normalizeHeartbeat({ service: "Syncthing", status: "green", metrics: { peers: 1 }, timestamp: "2026-11-02T00:00:00Z" }), { service: "Syncthing", status: "green", metrics: { peers: 1 }, timestamp: "2026-11-02T00:00:00Z" });
});

test("systems routes stay pending without a feed and record actions without executing them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "systems-"));
  const previous = { db: process.env.ORDER_LINKS_DB_FILE, heartbeats: process.env.SYSTEM_HEARTBEATS_DIR };
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  delete process.env.SYSTEM_HEARTBEATS_DIR;
  resetOrderLinkStore();
  const app = express();
  app.use(express.json());
  registerSystemsRoutes(app, (req, res) => {
    if (req.get("x-paid-order-access-code") !== "owner") {
      res.status(401).json({ ok: false });
      return true;
    }
    return false;
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const port = (server.address() as { port: number }).port;
  const headers = { "content-type": "application/json", "x-paid-order-access-code": "owner" };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/systems`)).status, 401);
    const pending = await fetch(`http://127.0.0.1:${port}/api/systems`, { headers });
    assert.deepEqual(await pending.json(), { ok: true, pending: true, heartbeats: [] });
    process.env.SYSTEM_HEARTBEATS_DIR = dir;
    const empty = await (await fetch(`http://127.0.0.1:${port}/api/systems`, { headers })).json();
    assert.equal(empty.pending, true);
    assert.deepEqual(empty.heartbeats, []);

    writeFileSync(join(dir, "broken.json"), "{");
    writeFileSync(join(dir, "syncthing.json"), JSON.stringify({ service: "Syncthing", status: "yellow", metrics: { peers: 1 }, timestamp: "2026-11-02T00:00:00Z" }));
    process.env.SYSTEM_HEARTBEATS_DIR = dir;
    const live = await (await fetch(`http://127.0.0.1:${port}/api/systems`, { headers })).json();
    assert.equal(live.pending, false);
    assert.equal(live.heartbeats.length, 1);
    assert.equal(live.heartbeats[0].status, "yellow");

    const action = await fetch(`http://127.0.0.1:${port}/api/systems/Syncthing/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "wake" }),
    });
    assert.deepEqual(await action.json(), { ok: true, executed: false, message: "Request recorded; no system command was run." });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetOrderLinkStore();
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.heartbeats === undefined) delete process.env.SYSTEM_HEARTBEATS_DIR;
    else process.env.SYSTEM_HEARTBEATS_DIR = previous.heartbeats;
    rmSync(dir, { recursive: true, force: true });
  }
});
