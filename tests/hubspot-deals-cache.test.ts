import test from "node:test";
import assert from "node:assert/strict";
import {
  boolPropertyNeedsOptionRepair,
  agePrintOrderDealsCacheForTest,
  fetchPrintOrderDeals,
  invalidatePrintOrderDealsCache,
} from "../server/lib/hubspot";

test("boolPropertyNeedsOptionRepair detects missing true/false options", () => {
  assert.equal(boolPropertyNeedsOptionRepair({ type: "bool", options: [] }), true);
  assert.equal(
    boolPropertyNeedsOptionRepair({
      type: "bool",
      options: [{ value: "true" }],
    }),
    true,
  );
  assert.equal(
    boolPropertyNeedsOptionRepair({
      type: "bool",
      options: [{ value: "true" }, { value: "false" }],
    }),
    false,
  );
  assert.equal(boolPropertyNeedsOptionRepair({ type: "string", options: [] }), false);
});

test("print order deals cache returns same reference within TTL and refreshes after invalidate", async (t) => {
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;

  globalThis.fetch = (async () => {
    searchCalls += 1;
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "1001",
            properties: {
              dealname: "Test Deal",
              pipeline: "default",
              dealstage: "appointmentscheduled",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    invalidatePrintOrderDealsCache();
    if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
  });

  invalidatePrintOrderDealsCache();
  const first = await fetchPrintOrderDeals();
  const second = await fetchPrintOrderDeals();
  assert.equal(searchCalls, 1, "second call should hit in-memory cache");
  assert.equal(first, second);
  assert.equal(first[0]?.id, "1001");

  invalidatePrintOrderDealsCache();
  const third = await fetchPrintOrderDeals();
  assert.equal(searchCalls, 2, "invalidate should force a new HubSpot search");
  assert.equal(third[0]?.id, "1001");
  assert.notEqual(third, first);
});

test("print order deals: stale-while-revalidate after the TTL, blocking read once too old", async (t) => {
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  let searchCalls = 0;
  globalThis.fetch = (async () => {
    searchCalls += 1;
    return new Response(
      JSON.stringify({ results: [{ id: String(1000 + searchCalls), properties: { dealname: "D", pipeline: "default", dealstage: "x" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    invalidatePrintOrderDealsCache();
    if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
  });

  invalidatePrintOrderDealsCache();
  const first = await fetchPrintOrderDeals();
  assert.equal(first[0]?.id, "1001");

  // Past the 20 s TTL: the cached list comes back at once, one background search refreshes it.
  agePrintOrderDealsCacheForTest(30_000);
  const stale = await fetchPrintOrderDeals();
  assert.equal(stale[0]?.id, "1001");
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(searchCalls, 2);
  assert.equal((await fetchPrintOrderDeals())[0]?.id, "1002");

  // Older than the stale window: wait for a fresh search.
  agePrintOrderDealsCacheForTest(11 * 60_000);
  assert.equal((await fetchPrintOrderDeals())[0]?.id, "1003");
  assert.equal(searchCalls, 3);
});
