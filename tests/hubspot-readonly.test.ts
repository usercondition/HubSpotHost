import test from "node:test";
import assert from "node:assert/strict";
import { hubspotRequest } from "../server/lib/hubspot";
import { lastHubspotWriteSuccessAt } from "../server/lib/hubspot-write-log";

test("readOnly HubSpot batch POST does not stamp the write log", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  process.env.HUBSPOT_PRIVATE_APP_TOKEN = "test-token";
  const before = lastHubspotWriteSuccessAt();
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 }) as Response;
  try {
    await hubspotRequest("/crm/v3/objects/contacts/batch/read", { method: "POST", body: "{}", readOnly: true });
    assert.equal(lastHubspotWriteSuccessAt(), before);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken == null) delete process.env.HUBSPOT_PRIVATE_APP_TOKEN;
    else process.env.HUBSPOT_PRIVATE_APP_TOKEN = previousToken;
  }
});
