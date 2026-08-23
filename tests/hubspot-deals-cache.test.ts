import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPrintOrderDeals,
  invalidatePrintOrderDealsCache,
} from "../server/lib/hubspot";

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
