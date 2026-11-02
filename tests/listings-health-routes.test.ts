import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { parseListingsHealth, registerListingsHealthRoutes } from "../server/lib/listings-health-routes";

test("listing health accepts suggestions without enabling auto-apply", () => {
  const feed = parseListingsHealth(JSON.stringify([{ id: "e-1", storefront: "ebay", title: "Knight", kind: "pricing", reason: "Below floor", proposedPrice: 45 }]));
  assert.equal(feed[0]?.id, "e-1");
  assert.equal(feed[0]?.proposedPrice, 45);
});

test("listing decisions are owner-gated and never marked applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "listings-"));
  const previous = { db: process.env.ORDER_LINKS_DB_FILE, file: process.env.LISTINGS_HEALTH_FILE };
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  delete process.env.LISTINGS_HEALTH_FILE;
  resetOrderLinkStore();
  const app = express();
  app.use(express.json());
  registerListingsHealthRoutes(app, (req, res) => {
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
    const pending = await (await fetch(`http://127.0.0.1:${port}/api/listings-health`, { headers })).json();
    assert.deepEqual(pending, { ok: true, pending: true, items: [] });
    const file = join(dir, "feed.json");
    writeFileSync(file, JSON.stringify([{ id: "e-1", storefront: "ebay", title: "Knight", kind: "pricing", reason: "Below floor", proposedPrice: 45 }]));
    process.env.LISTINGS_HEALTH_FILE = file;
    const feed = await (await fetch(`http://127.0.0.1:${port}/api/listings-health`, { headers })).json();
    assert.equal(feed.pending, false);
    assert.equal(feed.items[0].id, "e-1");
    const decision = await fetch(`http://127.0.0.1:${port}/api/listings-health/e-1/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "dismissed" }),
    });
    assert.deepEqual(await decision.json(), { ok: true, decision: "dismissed", applied: false });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetOrderLinkStore();
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.file === undefined) delete process.env.LISTINGS_HEALTH_FILE;
    else process.env.LISTINGS_HEALTH_FILE = previous.file;
    rmSync(dir, { recursive: true, force: true });
  }
});
