import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeShipAddress } from "../shared/ship-address";
import { contactToShipEngineAddress } from "../server/lib/shipengine";
import { applyAddressCleanup, gateLabelAddress } from "../server/lib/label-address";
import { invalidateDealContactCache, type DealAssociatedContact } from "../server/lib/deal-ops";
import { listOrderUpdates } from "../server/lib/order-updates";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { createOffbook } from "../server/lib/priority-stack";

const WAYNE_STREET = "10909 Hannan Rd, Romulus, Michigan, 48174";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Wayne's street drops the duplicated city, state, and ZIP", () => {
  const result = normalizeShipAddress({
    street1: WAYNE_STREET,
    city: "Romulus",
    state: "Michigan",
    zip: "48174",
    country: "United States",
  });
  assert.equal(result.normalized.street1, "10909 Hannan Rd");
  assert.equal(result.normalized.city, "Romulus");
  assert.equal(result.normalized.state, "MI");
  assert.equal(result.normalized.zip, "48174");
  assert.equal(result.normalized.country, "US");
  assert.equal(result.changed, true);
  assert.equal(result.original.street1, WAYNE_STREET);
  assert.equal(result.original.state, "Michigan");
  assert.equal(normalizeShipAddress(result.normalized).changed, false);

  const label = contactToShipEngineAddress({
    name: "Wayne Hood",
    email: "",
    phone: "",
    street1: WAYNE_STREET,
    street2: "",
    city: "Romulus",
    state: "Michigan",
    zip: "48174",
    country: "United States",
  });
  assert.equal(label?.street1, "10909 Hannan Rd");
  assert.equal(label?.street1.includes("Romulus"), false);
  assert.equal(label?.state, "MI");
});

test("a full state name becomes a 2-letter code", () => {
  const result = normalizeShipAddress({
    street1: "10909 Hannan Rd",
    city: "Romulus",
    state: "Michigan",
    zip: "48174",
    country: "US",
  });
  assert.equal(result.normalized.state, "MI");
  assert.equal(result.normalized.street1, "10909 Hannan Rd");
  assert.equal(result.changed, true);
});

test("lowercase city and state are tidied without rewriting a mixed-case street", () => {
  const result = normalizeShipAddress({
    street1: "10909 Hannan Rd",
    city: "romulus",
    state: "mi",
    zip: "48174",
    country: "US",
  });
  assert.equal(result.normalized.city, "Romulus");
  assert.equal(result.normalized.state, "MI");
  assert.equal(result.normalized.street1, "10909 Hannan Rd");
  assert.equal(result.changed, true);

  const lowerStreet = normalizeShipAddress({
    street1: "10909 hannan rd",
    city: "Romulus",
    state: "MI",
    zip: "48174",
    country: "US",
  });
  assert.equal(lowerStreet.normalized.street1, "10909 Hannan Rd");
});

test("a combined street fills blank city, state, and ZIP", () => {
  const result = normalizeShipAddress({
    street1: WAYNE_STREET,
    city: "",
    state: "",
    zip: "",
    country: "",
  });
  assert.equal(result.normalized.street1, "10909 Hannan Rd");
  assert.equal(result.normalized.city, "Romulus");
  assert.equal(result.normalized.state, "MI");
  assert.equal(result.normalized.zip, "48174");
  assert.equal(result.normalized.country, "US");
  assert.equal(result.original.city, "");
  assert.equal(result.changed, true);

  const compact = normalizeShipAddress({
    street1: "10909 Hannan Rd, Romulus, MI 48174",
    city: "",
    state: "",
    zip: "",
  });
  assert.equal(compact.normalized.street1, "10909 Hannan Rd");
  assert.equal(compact.normalized.city, "Romulus");
  assert.equal(compact.normalized.state, "MI");
  assert.equal(compact.normalized.zip, "48174");
});

describe("address cleanup confirm gate", { concurrency: 1 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "addr-cleanup-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const previousDry = process.env.DRY_RUN;
  const previousWrites = process.env.ALLOW_HUBSPOT_WRITES;
  const previousShip = process.env.SHIPENGINE_API_KEY;
  const originalFetch = globalThis.fetch;

  test.after(() => {
    globalThis.fetch = originalFetch;
    if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previousDb;
    if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    if (previousDry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDry;
    if (previousWrites === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previousWrites;
    if (previousShip === undefined) delete process.env.SHIPENGINE_API_KEY;
    else process.env.SHIPENGINE_API_KEY = previousShip;
    invalidateDealContactCache("349919419125");
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no HubSpot write happens without confirm", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "cleanup.db");
    resetOrderLinkStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      throw new Error("HubSpot should not be called");
    }) as typeof fetch;

    const missing = await applyAddressCleanup({ dealId: "349919419125" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.body.error, "Confirm the address cleanup first.");
    const declined = await applyAddressCleanup({ dealId: "349919419125", confirm: false });
    assert.equal(declined.ok, false);
    assert.equal(calls.length, 0);
  });

  test("confirm logs old and new values and patches only when writes are on", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "cleanup-write.db");
    resetOrderLinkStore();
    invalidateDealContactCache("349919419125");
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") {
        throw new Error("dry run must not PATCH");
      }
      if (url.includes("/associations/contacts")) {
        return jsonResponse({ results: [{ toObjectId: "9001" }] });
      }
      return jsonResponse({
        id: "9001",
        properties: {
          firstname: "Wayne",
          lastname: "Hood",
          address: WAYNE_STREET,
          city: "Romulus",
          state: "Michigan",
          zip: "48174",
          country: "United States",
        },
      });
    }) as typeof fetch;

    const dry = await applyAddressCleanup({ dealId: "349919419125", confirm: true });
    assert.equal(dry.ok, true);
    if (dry.ok) assert.equal(dry.body.wrote, false);
    assert.equal(methods.includes("PATCH"), false);
    const logged = listOrderUpdates("deal:349919419125").map((row) => row.text).join("\n");
    assert.match(logged, /10909 Hannan Rd, Romulus, Michigan, 48174/);
    assert.match(logged, /10909 Hannan Rd"/);
    assert.match(logged, /Michigan/);
    assert.match(logged, /"MI"/);

    invalidateDealContactCache("349919419125");
    process.env.DRY_RUN = "false";
    let patched = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        patched = String(init?.body ?? "");
        return jsonResponse({ id: "9001" });
      }
      if (url.includes("/associations/contacts")) {
        return jsonResponse({ results: [{ toObjectId: "9001" }] });
      }
      return jsonResponse({
        id: "9001",
        properties: {
          firstname: "Wayne",
          lastname: "Hood",
          address: WAYNE_STREET,
          city: "Romulus",
          state: "Michigan",
          zip: "48174",
          country: "United States",
        },
      });
    }) as typeof fetch;

    const live = await applyAddressCleanup({ dealId: "349919419125", confirm: true });
    assert.equal(live.ok, true);
    if (live.ok) assert.equal(live.body.wrote, true);
    const body = JSON.parse(patched) as { properties: Record<string, string> };
    assert.equal(body.properties.address, "10909 Hannan Rd");
    assert.equal(body.properties.city, "Romulus");
    assert.equal(body.properties.state, "MI");
    assert.equal(body.properties.zip, "48174");
    assert.equal(body.properties.country, "US");
  });

  test("an unverified correction blocks the buy until it is accepted", async () => {
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    const contact: DealAssociatedContact = {
      id: "9001",
      name: "Wayne Hood",
      email: "",
      phone: "",
      addressLines: [],
      street1: "10909 Hannan Rd",
      street2: "",
      city: "Romulus",
      state: "MI",
      zip: "48174",
      country: "US",
    };
    globalThis.fetch = (async () =>
      jsonResponse([
        {
          status: "verified",
          matched_address: {
            address_line1: "10909 Hannan Road",
            city_locality: "Romulus",
            state_province: "MI",
            postal_code: "48174",
            country_code: "US",
          },
          messages: [{ message: "Street suffix changed" }],
        },
      ])) as typeof fetch;

    const blocked = await gateLabelAddress(contact);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, "address_confirmation");
    }
    const accepted = await gateLabelAddress(contact, "accept");
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.equal(accepted.address.street1, "10909 Hannan Road");
    const overridden = await gateLabelAddress(contact, "override");
    assert.equal(overridden.ok, true);
    if (overridden.ok) assert.equal(overridden.address.street1, "10909 Hannan Rd");
  });
});

test("off-book ship save splits a combined street and does not call HubSpot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "addr-offbook-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const originalFetch = globalThis.fetch;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "offbook.db");
  resetOrderLinkStore();
  globalThis.fetch = (async () => {
    throw new Error("off-book must not call HubSpot");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previousDb;
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  });
  const row = createOffbook({
    title: "Wayne reprint",
    contactName: "Wayne Hood",
    mode: "ship",
    shipStreet: WAYNE_STREET,
  });
  assert.equal(row.shipStreet, "10909 Hannan Rd");
  assert.equal(row.shipCity, "Romulus");
  assert.equal(row.shipState, "MI");
  assert.equal(row.shipZip, "48174");
});
