import test from "node:test";
import assert from "node:assert/strict";
import { loadDealShipTos } from "../server/lib/ship-to-index";

test("exhausted ship-to 429 retries return a busy incomplete map without waiting", async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.HUBSPOT_ACCESS_TOKEN;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  let requests = 0; const waits: number[] = [];
  globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify({ message: "slow down" }), { status: 429, headers: { "retry-after": "99" } }); };
  try {
    const result = await loadDealShipTos(["42"], { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(result.incomplete, true);
    assert.equal(result.busy, true);
    assert.equal(requests, 3);
    assert.ok(waits.every((ms) => ms <= 10_250));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken == null) delete process.env.HUBSPOT_ACCESS_TOKEN; else process.env.HUBSPOT_ACCESS_TOKEN = savedToken;
  }
});
