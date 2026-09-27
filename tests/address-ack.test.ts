/**
 * Client address acknowledgment labels, and the HubSpot property that is written only when empty.
 */
import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_ADDRESS_ACK_TEXT,
  formatAddressEntryLabel,
  formatClientConfirmedProperty,
} from "../shared/address-capture";
import { writeClientConfirmedAddressIfEmpty } from "../server/lib/address-capture";
import { resetOrderLinkStore } from "../server/lib/order-links";

test("the acknowledgment line names the client date or the shop", () => {
  assert.match(CLIENT_ADDRESS_ACK_TEXT, /I confirm my name and shipping address above are correct/);
  assert.equal(
    formatAddressEntryLabel({
      source: "client",
      acknowledgedAt: "2026-09-27T20:00:00.000Z",
    }),
    "Client confirmed name and address on Sep 27",
  );
  assert.equal(
    formatAddressEntryLabel({
      source: "shop",
      acknowledgedAt: "2026-09-27T20:00:00.000Z",
    }),
    "Entered by shop",
  );
  assert.equal(formatAddressEntryLabel(null), null);
  const property = formatClientConfirmedProperty({
    acknowledgedAt: "2026-09-27T20:00:00.000Z",
    snapshot: "Jane Smith\njane@example.com",
    textVersion: "v1",
    formSource: "client-order",
  });
  assert.match(property, /2026-09-27T20:00:00.000Z/);
  assert.match(property, /Jane Smith/);
  assert.match(property, /checkbox v1/);
  assert.match(property, /form client-order/);
});

describe("print_client_confirmed_address is not overwritten", { concurrency: 1 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "address-ack-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const previousDry = process.env.DRY_RUN;
  const previousWrites = process.env.ALLOW_HUBSPOT_WRITES;
  const previousFetch = globalThis.fetch;

  after(() => {
    globalThis.fetch = previousFetch;
    if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previousDb;
    if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    if (previousDry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDry;
    if (previousWrites === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previousWrites;
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  });

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  test("dry run does not call HubSpot", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "dry.db");
    resetOrderLinkStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    globalThis.fetch = (async () => {
      throw new Error("dry run must not call HubSpot");
    }) as typeof fetch;
    const result = await writeClientConfirmedAddressIfEmpty("55", "2026-09-27T20:00:00.000Z\nJane Smith");
    assert.equal(result, "skipped");
  });

  test("an existing value is kept and a blank value is written", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "write.db");
    resetOrderLinkStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    let existing = "already confirmed";
    const patches: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/crm/v3/properties/deals") && method === "GET") {
        return json({ results: [{ name: "print_client_confirmed_address", type: "string" }] });
      }
      if (url.includes("/crm/v3/properties/deals") && method === "POST") {
        return json({ ok: true });
      }
      if (url.includes("/crm/v3/objects/deals/") && method === "GET") {
        return json({ id: "55", properties: { print_client_confirmed_address: existing } });
      }
      if (method === "PATCH") {
        patches.push(String(init?.body ?? ""));
        return json({ id: "55" });
      }
      return json({});
    }) as typeof fetch;

    const kept = await writeClientConfirmedAddressIfEmpty("55", "new snapshot");
    assert.equal(kept, "kept");
    assert.equal(patches.length, 0);

    existing = "";
    const written = await writeClientConfirmedAddressIfEmpty("55", "2026-09-27T20:00:00.000Z\nJane Smith");
    assert.equal(written, "written");
    assert.equal(patches.length, 1);
    assert.match(patches[0] ?? "", /print_client_confirmed_address/);
    assert.match(patches[0] ?? "", /Jane Smith/);
    assert.equal((patches[0] ?? "").includes("already confirmed"), false);
  });
});
