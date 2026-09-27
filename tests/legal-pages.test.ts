import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoutes } from "../server/routes";

test("privacy and terms are public and do not ask for an owner code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legal-pages-"));
  const previous = process.env.ORDER_LINKS_DB_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  const app = express();
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    for (const path of ["/privacy", "/terms"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const body = await response.text();
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") || "", /text\/html/);
      assert.match(body, /Miguel Mercado/);
      assert.match(body, /streetsofmerchant@gmail.com/);
      assert.equal(/\bundefined\b|\bNaN\b|\bTODO\b|lorem/i.test(body), false, body);
      if (path === "/privacy") {
        assert.match(body, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
        assert.match(body, /not sold, shared, or used for ads/);
        assert.match(body, /https:\/\/myaccount\.google\.com\/permissions/);
      } else {
        assert.match(body, /provided as-is/);
        assert.match(body, /shop owner/);
      }
    }
    const locked = await fetch(`http://127.0.0.1:${port}/api/google/drive`);
    assert.notEqual(locked.status, 200);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
