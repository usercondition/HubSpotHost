import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { registerNerveSessionKeyRoute } from "../server/lib/nerve-session-key";

const OWNER = "owner-code-for-tests";
const NK = "server-side-nerve-key-for-tests";
const env = {
  PAID_ORDER_INTAKE_ACCESS_CODE_HASH: crypto.createHash("sha256").update(OWNER).digest("hex"),
  NERVE_KEY: NK,
} as NodeJS.ProcessEnv;

async function withServer(e: NodeJS.ProcessEnv, fn: (base: string) => Promise<void>) {
  const app = express();
  registerNerveSessionKeyRoute(app, { env: e });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nerve/session-key`);
  } finally {
    server.close();
  }
}

test("valid Print Ops key gets the Nerve key, no-store", async () => {
  await withServer(env, async (url) => {
    const r = await fetch(url, { headers: { "x-paid-order-access-code": OWNER } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(((await r.json()) as { key: string }).key, NK);
  });
});

test("missing or wrong Print Ops key is 401, no key in body, no-store", async () => {
  await withServer(env, async (url) => {
    for (const h of [{}, { "x-paid-order-access-code": "nope" }] as Array<Record<string, string>>) {
      const r = await fetch(url, { headers: h });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.ok(!(await r.text()).includes(NK));
    }
  });
});

test("NERVE_KEY unset is 503", async () => {
  await withServer({ ...env, NERVE_KEY: "" }, async (url) => {
    const r = await fetch(url, { headers: { "x-paid-order-access-code": OWNER } });
    assert.equal(r.status, 503);
  });
});

test("client keeps the Nerve key out of storage and away from the owner-lock path", () => {
  const src = readFileSync(new URL("../client/src/lib/nerve.ts", import.meta.url), "utf8");
  assert.ok(!/(localStorage|sessionStorage)\.setItem/.test(src));
  assert.ok(!/apiRequest\(|notifyOwnerAuthFailure\(|onOwnerAuthFailure\(|from "@\/lib\/queryClient"/.test(src));
  assert.ok(!src.includes("server/lib/nerve-proxy"));
});

test("session-key accepts a lookalike-mangled code when NORM_HASH is set", async () => {
  const { normalizeOwnerCode } = await import("../server/lib/owner-code");
  const e = {
    ...env,
    PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH: crypto.createHash("sha256").update(normalizeOwnerCode(OWNER)).digest("hex"),
  } as NodeJS.ProcessEnv;
  await withServer(e, async (url) => {
    const ok = await fetch(url, { headers: { "x-paid-order-access-code": OWNER.toUpperCase().replace(/O/g, "0") } });
    assert.equal(ok.status, 200);
    const bad = await fetch(url, { headers: { "x-paid-order-access-code": "OWNER-CODE-FOR-TESTZ" } });
    assert.equal(bad.status, 401);
  });
  await withServer(env, async (url) => {
    const r = await fetch(url, { headers: { "x-paid-order-access-code": OWNER.toUpperCase() } });
    assert.equal(r.status, 401, "without NORM_HASH only the exact code works");
  });
});
