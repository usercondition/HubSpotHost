import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressNeedsUnit,
  addressProviderFromEnv,
  formatLabelAddress,
  parsePastedAddress,
  resolveCaptureSubmit,
  type CaptureCheck,
} from "../shared/address-capture";
import { applyCapturedAddress } from "../server/lib/address-capture";
import { suggestGooglePlaces, suggestionFromPlaceDetails } from "../server/lib/address-provider";
import { createOrderLink, getOrderLink, resetOrderLinkStore, submitClientOrder } from "../server/lib/order-links";
import { createOffbook } from "../server/lib/priority-stack";
import { listOrderUpdates } from "../server/lib/order-updates";
import { resetAddressCheckOutage } from "../server/lib/address-checks";
import { readAddressAcknowledgment } from "../server/lib/address-ack";
import type { ClientOrderSubmission } from "../shared/schema";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const submission = {
  clientFullName: "Jane Smith",
  clientUsername: "jane.prints",
  clientEmail: "jane@example.com",
  clientPhone: "619-555-0199",
  shippingRequired: true,
  shippingStreet: "123 Resin Way",
  shippingStreet2: "Apt 4B",
  shippingCity: "San Diego",
  shippingState: "CA",
  shippingPostalCode: "92101",
  shippingCountry: "United States",
  confirmedItem: "Acastus Knight",
  quantity: 1,
  clientNotes: "",
  clientPaymentConfirmed: true,
} satisfies ClientOrderSubmission;

test("a pasted Marketplace address splits into street, city, state, and ZIP", () => {
  const fields = parsePastedAddress("10909 Hannan Rd, Romulus, Michigan, 48174");
  assert.equal(fields.street1, "10909 Hannan Rd");
  assert.equal(fields.city, "Romulus");
  assert.equal(fields.state, "MI");
  assert.equal(fields.zip, "48174");
  assert.equal(fields.country, "US");
});

test("a multiline paste drops the name and keeps the unit", () => {
  const fields = parsePastedAddress(
    ["Wayne Hood", "10909 Hannan Rd", "Apt 2", "Romulus, MI 48174", "United States"].join("\n"),
  );
  assert.equal(fields.street1, "10909 Hannan Rd");
  assert.equal(fields.street2, "Apt 2");
  assert.equal(fields.city, "Romulus");
  assert.equal(fields.state, "MI");
  assert.equal(fields.zip, "48174");
  assert.equal(fields.country, "US");
  assert.match(formatLabelAddress(fields), /10909 Hannan Rd/);
  assert.match(formatLabelAddress(fields), /Apt 2/);
});

test("a multi-unit building with no unit asks for Apt/Unit, and a filled unit does not", () => {
  assert.equal(
    addressNeedsUnit({
      street2: "",
      messages: ["This is a multi-unit building. An apartment or suite is required."],
    }),
    true,
  );
  assert.equal(addressNeedsUnit({ street2: "", messages: [], matchedStreet2: "Apt 4" }), true);
  assert.equal(addressNeedsUnit({ street2: "Apt 4", messages: ["suite required"], matchedStreet2: "Apt 4" }), false);
  assert.equal(addressNeedsUnit({ street2: "", messages: ["Address verified"] }), false);
});

test("a corrected address is not saved until the client picks one", () => {
  const check: CaptureCheck = {
    status: "corrected",
    needsUnit: false,
    typed: {
      street1: "10909 Hannan Rd",
      street2: "",
      city: "Romulus",
      state: "MI",
      zip: "48174",
      country: "US",
    },
    suggestion: {
      street1: "10909 Hannan Road",
      street2: "",
      city: "Romulus",
      state: "MI",
      zip: "48174-1234",
      country: "US",
    },
    messages: [],
  };
  const blocked = resolveCaptureSubmit({ check });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "address_choice");
  const accepted = resolveCaptureSubmit({ check, decision: "accept" });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.fields.street1, "10909 Hannan Road");
    assert.equal(accepted.storedStatus, "verified");
    assert.equal(accepted.choice, "suggested");
  }
  const kept = resolveCaptureSubmit({ check, decision: "override" });
  assert.equal(kept.ok, true);
  if (kept.ok) {
    assert.equal(kept.fields.street1, "10909 Hannan Rd");
    assert.equal(kept.storedStatus, "unverified");
  }
});

test("an unverified address can be confirmed and stays flagged", () => {
  const check: CaptureCheck = {
    status: "unverified",
    needsUnit: false,
    typed: {
      street1: "123 Resin Way",
      street2: "",
      city: "San Diego",
      state: "CA",
      zip: "92101",
      country: "US",
    },
    suggestion: null,
    messages: ["Not found"],
  };
  const resolved = resolveCaptureSubmit({ check, decision: "confirm" });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.storedStatus, "unverified");
});

test("autocomplete is off unless GOOGLE_PLACES_API_KEY is set, and Places stays in the US", async () => {
  const previous = process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.GOOGLE_PLACES_API_KEY;
  assert.deepEqual(addressProviderFromEnv(process.env), { id: "off", enabled: false, country: null });
  let calls = 0;
  const empty = await suggestGooglePlaces("10909 Hannan Rd", "", async () => {
    calls += 1;
    throw new Error("Places must not be called without a key");
  });
  assert.equal(empty.length, 0);
  assert.equal(calls, 0);

  process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
  assert.equal(addressProviderFromEnv(process.env).id, "google-places");
  assert.equal(addressProviderFromEnv(process.env).country, "US");
  const seen: string[] = [];
  const suggestions = await suggestGooglePlaces("10909 Hannan", "test-places-key", async (input) => {
    const url = String(input);
    seen.push(url);
    assert.equal(url.includes("test-places-key") ? "key-present" : "missing", "key-present");
    if (url.includes("/autocomplete/")) {
      assert.match(url, /components=country%3Aus|components=country:us/);
      return jsonResponse({ predictions: [{ place_id: "place-1", description: "10909 Hannan Rd, Romulus, MI" }] });
    }
    return jsonResponse({
      result: {
        formatted_address: "10909 Hannan Rd, Romulus, MI 48174, USA",
        address_components: [
          { long_name: "10909", short_name: "10909", types: ["street_number"] },
          { long_name: "Hannan Road", short_name: "Hannan Rd", types: ["route"] },
          { long_name: "Romulus", short_name: "Romulus", types: ["locality"] },
          { long_name: "Michigan", short_name: "MI", types: ["administrative_area_level_1"] },
          { long_name: "48174", short_name: "48174", types: ["postal_code"] },
          { long_name: "United States", short_name: "US", types: ["country"] },
        ],
      },
    });
  });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.street, "10909 Hannan Road");
  assert.equal(suggestions[0]?.state, "MI");
  assert.equal(suggestions[0]?.country, "US");
  assert.equal(
    suggestionFromPlaceDetails({
      placeId: "ca",
      components: [
        { long_name: "1", short_name: "1", types: ["street_number"] },
        { long_name: "Main", short_name: "Main", types: ["route"] },
        { long_name: "Canada", short_name: "CA", types: ["country"] },
      ],
    }),
    null,
  );
  if (previous === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = previous;
});

describe("address capture save", { concurrency: 1 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "address-capture-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const previousShip = process.env.SHIPENGINE_API_KEY;
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const previousDry = process.env.DRY_RUN;
  const previousWrites = process.env.ALLOW_HUBSPOT_WRITES;

  test.after(() => {
    if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previousDb;
    if (previousShip === undefined) delete process.env.SHIPENGINE_API_KEY;
    else process.env.SHIPENGINE_API_KEY = previousShip;
    if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    if (previousDry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDry;
    if (previousWrites === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previousWrites;
    resetAddressCheckOutage();
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("nothing is saved until the pasted address is confirmed", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "paste.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      calls.push("fetch");
      throw new Error("save must not call HubSpot before confirm");
    }) as typeof fetch;

    const declined = await applyCapturedAddress({
      confirm: false,
      dealId: "349919419125",
      fields: {
        street1: "10909 Hannan Rd",
        city: "Romulus",
        state: "MI",
        zip: "48174",
        country: "US",
      },
    });
    assert.equal(declined.ok, false);
    if (!declined.ok) assert.equal(declined.body.error, "Confirm the address before saving it.");
    assert.equal(calls.length, 0);
  });

  test("a confirmed paste on an off-book order stores split fields and does not write HubSpot", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "offbook.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
    const calls: string[] = [];
    globalThis.fetch = (async () => {
      calls.push("fetch");
      throw new Error("off-book must not call HubSpot");
    }) as typeof fetch;
    const row = createOffbook({ title: "Messenger order", mode: "pickup" });
    const applied = await applyCapturedAddress({
      confirm: true,
      offbookId: row.id,
      fields: parsePastedAddress("10909 Hannan Rd, Romulus, Michigan, 48174"),
    });
    assert.equal(applied.ok, true);
    if (applied.ok) {
      const fields = applied.body.fields as { street1: string; state: string; city: string };
      assert.equal(fields.street1, "10909 Hannan Rd");
      assert.equal(fields.city, "Romulus");
      assert.equal(fields.state, "MI");
      assert.equal(applied.body.wrote, false);
    }
    assert.equal(calls.length, 0);
    const logged = listOrderUpdates(`offbook:${row.id}`).map((entry) => entry.text).join("\n");
    assert.match(logged, /10909 Hannan Rd/);
    assert.match(logged, /Entered by shop/);
    const ack = readAddressAcknowledgment(`offbook:${row.id}`);
    assert.equal(ack?.source, "shop");
    assert.equal(ack?.formSource, "paste");
  });

  test("a client submission stores the validation status with the split address", () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "intake.db");
    resetOrderLinkStore();
    const created = createOrderLink({
      internalLabel: "MIG-2001",
      itemDescription: "Acastus Knight",
      agreedAmount: "40",
      paymentMethod: "Zelle",
      paymentReference: "Z1",
      buyerNameHint: "Jane",
      buyerUsernameHint: "jane.prints",
      ownerNotes: "",
      expiryDays: 7,
    });
    const result = submitClientOrder(created.token, submission, {
      status: "unverified",
      checkedAt: "2026-09-27T18:00:00.000Z",
      choice: "typed",
      messages: ["Not found"],
    });
    assert.deepEqual(result, { ok: true });
    const link = getOrderLink(created.link.id);
    assert.equal(link?.shippingStreet, "123 Resin Way");
    assert.equal(link?.shippingStreet2, "Apt 4B");
    assert.equal(link?.shippingCity, "San Diego");
    assert.equal(link?.shippingState, "CA");
    assert.equal(link?.shippingPostalCode, "92101");
    assert.equal(link?.shippingCountry, "US");
    assert.equal(link?.addressCheckStatus, "unverified");
    assert.equal(link?.addressCheckChoice, "typed");
    assert.match(link?.addressCheckMessages ?? "", /Not found/);
  });

  test("ShipEngine correction blocks the save and does not patch HubSpot", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "block.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const methods: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "PATCH") throw new Error("HubSpot must not be patched");
      return jsonResponse([
        {
          status: "verified",
          matched_address: {
            address_line1: "10909 Hannan Road",
            address_line2: "",
            city_locality: "Romulus",
            state_province: "MI",
            postal_code: "48174",
            country_code: "US",
          },
          messages: [],
        },
      ]);
    }) as typeof fetch;

    const blocked = await applyCapturedAddress({
      confirm: true,
      dealId: "349919419125",
      fields: {
        street1: "10909 Hannan Rd",
        street2: "",
        city: "Romulus",
        state: "MI",
        zip: "48174",
        country: "US",
      },
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.body.code, "address_choice");
    assert.equal(methods.includes("PATCH"), false);
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
  });
});
