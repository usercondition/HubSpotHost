import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerNerveProxyRoutes } from "../server/lib/nerve-proxy";

const OWNER = "owner-code-for-tests";
const SERVER_NERVE = "server-side-nerve-key-for-tests";
const env = {
  PAID_ORDER_INTAKE_ACCESS_CODE_HASH: crypto.createHash("sha256").update(OWNER).digest("hex"),
  NERVE_KEY: SERVER_NERVE,
  NERVE_API_BASE: "http://nerve.test/nerve/",
} as NodeJS.ProcessEnv;

async function withServer(
  upstream: (url: string, init: RequestInit) => Promise<Response>,
  fn: (base: string) => Promise<void>,
  e: NodeJS.ProcessEnv = env,
) {
  const app = express();
  registerNerveProxyRoutes(app, { env: e, fetch: upstream });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("owner code unlocks Nerve; server adds the Nerve key", async () => {
  const seen: Array<{ url: string; key: string | null }> = [];
  await withServer(
    async (url, init) => {
      seen.push({ url, key: new Headers(init.headers).get("x-nerve-key") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    async (base) => {
      const r = await fetch(`${base}/api/nerve/api/messages/thread?uid=a1&limit=80&evil=1`, { headers: { "x-paid-order-access-code": OWNER } });
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.ok(!body.includes(SERVER_NERVE));
      assert.equal(seen[0].url, "http://nerve.test/nerve/api/messages/thread?uid=a1&limit=80");
      assert.equal(seen[0].key, SERVER_NERVE);
    },
  );
});

test("missing or wrong owner code is 401 and never calls Nerve", async () => {
  let calls = 0;
  await withServer(async () => { calls++; return new Response("{}"); }, async (base) => {
    assert.equal((await fetch(`${base}/api/nerve/api/v3`)).status, 401);
    assert.equal((await fetch(`${base}/api/nerve/api/v3`, { headers: { "x-paid-order-access-code": "nope" } })).status, 401);
  });
  assert.equal(calls, 0);
});

test("upstream 401 is surfaced as 502 so it can't lock the Print Ops session", async () => {
  await withServer(async () => new Response("no", { status: 401 }), async (base) => {
    const r = await fetch(`${base}/api/nerve/api/v3`, { headers: { "x-paid-order-access-code": OWNER } });
    assert.equal(r.status, 502);
  });
});

test("non-allowlisted paths are 404; unset NERVE_KEY is 503", async () => {
  await withServer(async () => new Response("{}"), async (base) => {
    assert.equal((await fetch(`${base}/api/nerve/api/send`, { headers: { "x-paid-order-access-code": OWNER } })).status, 404);
  });
  await withServer(async () => new Response("{}"), async (base) => {
    assert.equal((await fetch(`${base}/api/nerve/api/v3`, { headers: { "x-paid-order-access-code": OWNER } })).status, 503);
  }, { ...env, NERVE_KEY: "" });
});
