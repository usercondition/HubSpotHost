import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressNeedsUnit,
  formatLabelAddress,
  parsePastedAddress,
  resolveCaptureSubmit,
  type CaptureCheck,
} from "../shared/address-capture";
import {
  addressCheckToken,
  applyCapturedAddress,
  checkCapturedAddress,
  prepareClientAddressSubmit,
} from "../server/lib/address-capture";
import { createOrderLink, getOrderLink, resetOrderLinkStore, submitClientOrder } from "../server/lib/order-links";
import { createOffbook } from "../server/lib/priority-stack";
import { listOrderUpdates } from "../server/lib/order-updates";
import {
  ensureAddressCheck,
  labelAddressOutageActive,
  publicAddressOutageActive,
  resetAddressCheckOutage,
  resetPublicAddressValidation,
  PublicAddressRateLimitError,
} from "../server/lib/address-checks";
import { readAddressAcknowledgment } from "../server/lib/address-capture";
import { consumeClientAttempt, resetClientAttemptLimits } from "../server/lib/client-rate-limit";
import { lookupClientOrder, expireOrderLink } from "../server/lib/order-links";
import { orderUpdateAppliedAt } from "../server/lib/order-updates";
import {
  PaidOrderAddressConflict,
  createPaidOrder,
  reusedContactAddressAppliedAt,
  updateContact,
} from "../server/lib/paid-orders";
import { publicAddressFieldsSchema } from "../shared/address-capture";
import { configureTrustProxy } from "../server/lib/trust-proxy";
import { HUBSPOT_WRITES_OFF_MESSAGE } from "../shared/address-capture";
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

describe("address capture save", { concurrency: 1 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "address-capture-"));
  const previousDb = process.env.ORDER_LINKS_DB_FILE;
  const previousShip = process.env.SHIPENGINE_API_KEY;
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const previousDry = process.env.DRY_RUN;
  const previousWrites = process.env.ALLOW_HUBSPOT_WRITES;
  const previousFetch = globalThis.fetch;

  test.after(() => {
    globalThis.fetch = previousFetch;
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
    resetPublicAddressValidation();
    resetClientAttemptLimits();
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
    const asked = await applyCapturedAddress({
      confirm: true,
      offbookId: row.id,
      fields: parsePastedAddress("10909 Hannan Rd, Romulus, Michigan, 48174"),
    });
    assert.equal(asked.ok, false);
    if (!asked.ok) assert.equal(asked.body.code, "switch_to_ship");
    assert.equal(listOrderUpdates(`offbook:${row.id}`).length, 0);
    const applied = await applyCapturedAddress({
      confirm: true,
      offbookId: row.id,
      switchToShip: true,
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

  test("a live replace logs the raw HubSpot address before the write and marks it applied after", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "live.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const dealId = "349919419125";
    let patched = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/associations/")) return jsonResponse({ results: [{ toObjectId: "501" }] });
      if (method === "GET" && url.includes("/contacts/501")) {
        return jsonResponse({
          id: "501",
          properties: {
            address: "10 Old Street",
            city: "Romulus",
            state: "Michigan",
            zip: "48174",
            country: "United States",
            firstname: "Wayne",
            lastname: "Hood",
          },
        });
      }
      if (method === "PATCH") {
        const prior = listOrderUpdates(`deal:${dealId}`).find((entry) => entry.text.includes("Previous HubSpot address"));
        assert.ok(prior);
        assert.equal(orderUpdateAppliedAt(prior.id), null);
        assert.match(prior.text, /Michigan/);
        assert.match(prior.text, /10 Old Street/);
        patched = true;
        return jsonResponse({ id: "501" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;

    const fields = {
      street1: "10909 Hannan Rd",
      street2: "",
      city: "Romulus",
      state: "MI",
      zip: "48174",
      country: "US",
    };
    const blocked = await applyCapturedAddress({ confirm: true, dealId, fields });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.body.code, "replace_hubspot");
      const current = blocked.body.current as { state?: string; address?: string };
      assert.equal(current.state, "Michigan");
      assert.equal(current.address, "10 Old Street");
    }
    assert.equal(patched, false);
    assert.equal(
      listOrderUpdates(`deal:${dealId}`).some((entry) => entry.text.includes("Previous HubSpot address")),
      false,
    );

    const applied = await applyCapturedAddress({ confirm: true, dealId, fields, replaceHubspot: true });
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.body.wrote, true);
    assert.equal(patched, true);
    const prior = listOrderUpdates(`deal:${dealId}`).find((entry) => entry.text.includes("Previous HubSpot address"));
    assert.ok(prior);
    assert.ok(orderUpdateAppliedAt(prior.id));
  });

  test("dry run returns wrote false and does not log a HubSpot change", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "dry-apply.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "true";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    const dealId = "349919419126";
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      methods.push(method);
      if (method === "PATCH") throw new Error("dry run must not patch");
      if (url.includes("/associations/")) return jsonResponse({ results: [{ toObjectId: "502" }] });
      if (url.includes("/contacts/502")) {
        return jsonResponse({
          id: "502",
          properties: { address: "10 Old Street", city: "Romulus", state: "Michigan", zip: "48174", country: "US" },
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;

    const applied = await applyCapturedAddress({
      confirm: true,
      dealId,
      replaceHubspot: true,
      fields: {
        street1: "10909 Hannan Rd",
        city: "Romulus",
        state: "MI",
        zip: "48174",
        country: "US",
      },
    });
    assert.equal(applied.ok, true);
    if (applied.ok) {
      assert.equal(applied.body.wrote, false);
      assert.equal(applied.body.writesOff, true);
      assert.equal(applied.body.message, HUBSPOT_WRITES_OFF_MESSAGE);
    }
    assert.equal(methods.includes("PATCH"), false);
    assert.equal(listOrderUpdates(`deal:${dealId}`).length, 0);
  });

  test("a missing unit on paste asks, and no-unit then saves", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "unit.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    resetPublicAddressValidation();
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    process.env.DRY_RUN = "false";
    process.env.ALLOW_HUBSPOT_WRITES = "true";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/addresses/validate")) {
        return jsonResponse([
          { status: "unverified", messages: ["This building needs an apartment or unit number."] },
        ]);
      }
      if (url.includes("/associations/")) return jsonResponse({ results: [{ toObjectId: "503" }] });
      if (method === "GET" && url.includes("/contacts/503")) {
        return jsonResponse({ id: "503", properties: { address: "", city: "", state: "", zip: "", country: "" } });
      }
      if (method === "PATCH") return jsonResponse({ id: "503" });
      throw new Error(`unexpected ${method} ${url}`);
    }) as typeof fetch;
    const fields = {
      street1: "10909 Hannan Rd",
      street2: "",
      city: "Romulus",
      state: "MI",
      zip: "48174",
      country: "US",
    };
    const asked = await applyCapturedAddress({ confirm: true, dealId: "349919419127", fields });
    assert.equal(asked.ok, false);
    if (!asked.ok) assert.equal(asked.body.code, "needs_unit");
    const saved = await applyCapturedAddress({ confirm: true, dealId: "349919419127", fields, noUnit: true });
    assert.equal(saved.ok, true);
    if (saved.ok) assert.equal(saved.body.wrote, true);
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
  });

  test("a public ShipEngine outage does not block label validation and submit keeps the confirmed address", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "outage.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    resetPublicAddressValidation();
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    const fields = {
      street1: "123 Resin Way",
      street2: "Apt 4B",
      city: "San Diego",
      state: "CA",
      zip: "92101",
      country: "US",
    };
    globalThis.fetch = (async () => {
      throw new Error("ShipEngine down");
    }) as typeof fetch;
    const checked = await checkCapturedAddress(fields, { audience: "public", rateKey: "outage-buyer" });
    assert.equal(checked.status, "unchecked");
    assert.equal(publicAddressOutageActive(), true);
    assert.equal(labelAddressOutageActive(), false);

    const token = addressCheckToken(fields);
    const prepared = await prepareClientAddressSubmit({
      fields,
      addressAcknowledged: true,
      addressCheckToken: token,
      decision: "confirm",
      rateKey: "outage-submit",
    });
    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      assert.equal(prepared.fields.street1, "123 Resin Way");
      assert.equal(prepared.fields.street2, "Apt 4B");
      assert.equal(prepared.checkedAt, "");
      const created = createOrderLink({
        internalLabel: "MIG-2002",
        itemDescription: "Acastus Knight",
        agreedAmount: "40",
        paymentMethod: "Zelle",
        paymentReference: "Z2",
        buyerNameHint: "Jane",
        buyerUsernameHint: "jane.prints",
        ownerNotes: "",
        expiryDays: 7,
      });
      const stored = submitClientOrder(
        created.token,
        { ...submission, shippingStreet: prepared.fields.street1, shippingStreet2: prepared.fields.street2, shippingCity: prepared.fields.city, shippingState: prepared.fields.state, shippingPostalCode: prepared.fields.zip, shippingCountry: prepared.fields.country },
        { status: prepared.storedStatus, checkedAt: prepared.checkedAt, choice: prepared.choice, messages: prepared.messages },
      );
      assert.deepEqual(stored, { ok: true });
      const link = getOrderLink(created.link.id);
      assert.equal(link?.shippingStreet, "123 Resin Way");
      assert.equal(link?.addressCheckedAt, "");
    }

    let labelCalls = 0;
    globalThis.fetch = (async () => {
      labelCalls += 1;
      return jsonResponse([
        {
          status: "verified",
          matched_address: {
            address_line1: "123 Resin Way",
            address_line2: "Apt 4B",
            city_locality: "San Diego",
            state_province: "CA",
            postal_code: "92101",
            country_code: "US",
          },
          messages: [],
        },
      ]);
    }) as typeof fetch;
    const label = await ensureAddressCheck({
      force: true,
      contact: {
        id: null,
        name: "Buyer",
        email: "",
        phone: "",
        addressLines: [],
        ...fields,
      },
    });
    assert.equal(label.status, "verified");
    assert.ok(labelCalls >= 1);
    resetAddressCheckOutage();
    resetPublicAddressValidation();
    delete process.env.SHIPENGINE_API_KEY;
  });

  test("public suggestions require an open link and the client rate limit is per IP", () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "public.db");
    resetOrderLinkStore();
    resetClientAttemptLimits();
    const created = createOrderLink({
      internalLabel: "MIG-2003",
      itemDescription: "Acastus Knight",
      agreedAmount: "40",
      paymentMethod: "Zelle",
      paymentReference: "Z3",
      buyerNameHint: "",
      buyerUsernameHint: "",
      ownerNotes: "",
      expiryDays: 7,
    });
    assert.equal(lookupClientOrder(created.token).ok, true);
    assert.equal(lookupClientOrder("").ok, false);
    expireOrderLink(created.link.id);
    const closed = lookupClientOrder(created.token);
    assert.equal(closed.ok, false);
    const tooLong = publicAddressFieldsSchema.safeParse({
      shippingStreet: "x".repeat(201),
      shippingStreet2: "",
      shippingCity: "San Diego",
      shippingState: "CA",
      shippingPostalCode: "92101",
      shippingCountry: "US",
    });
    assert.equal(tooLong.success, false);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      assert.equal(consumeClientAttempt("203.0.113.8"), false);
    }
    assert.equal(consumeClientAttempt("203.0.113.8"), true);
    assert.equal(consumeClientAttempt("203.0.113.9"), false);
    const trusted: unknown[] = [];
    configureTrustProxy({ set: (_name, value) => trusted.push(value) }, { RAILWAY_ENVIRONMENT_NAME: "production" });
    assert.deepEqual(trusted, [1]);
    configureTrustProxy({ set: () => { throw new Error("local must not trust proxy"); } }, {});
  });

  test("submit rejects a confirmed address that no longer matches the check", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "mismatch.db");
    resetOrderLinkStore();
    resetAddressCheckOutage();
    resetPublicAddressValidation();
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    const typed = {
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
            address_line2: "",
            city_locality: "Romulus",
            state_province: "MI",
            postal_code: "48174",
            country_code: "US",
          },
          messages: [],
        },
      ])) as typeof fetch;
    const prepared = await prepareClientAddressSubmit({
      fields: typed,
      decision: "accept",
      addressAcknowledged: true,
      addressCheckToken: addressCheckToken(typed),
      rateKey: "mismatch-buyer",
    });
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.equal(prepared.body.code, "address_choice");
    resetAddressCheckOutage();
    resetPublicAddressValidation();
    delete process.env.SHIPENGINE_API_KEY;
  });

  test("a reused contact address is filled only when blank, otherwise confirmed or kept on the order", async () => {
    process.env.ORDER_LINKS_DB_FILE = join(dir, "reuse.db");
    resetOrderLinkStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    const draft = {
      paymentConfirmed: true,
      fullName: "Wayne Hood",
      marketplaceUsername: "wayne",
      email: "wayne@example.com",
      phone: "734-555-0100",
      address: "10909 Hannan Rd",
      city: "Romulus",
      state: "MI",
      postalCode: "48174",
      country: "US",
      productName: "Knight",
      amount: "40",
      conversationSummary: "paid",
    };
    const patches: Array<Record<string, string>> = [];
    const dealDescriptions: string[] = [];
    let current = { address: "", city: "", state: "", zip: "", country: "" };
    let logId = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { properties?: Record<string, string> })
        : {};
      if (url.includes("/crm/v3/properties/deals")) return jsonResponse({ results: [], ok: true });
      if (url.includes("/contacts/search")) {
        return jsonResponse({ results: [{ id: "88", properties: { firstname: "Wayne", lastname: "Hood", email: draft.email } }] });
      }
      if (method === "GET" && url.includes("/contacts/")) {
        return jsonResponse({ id: "88", properties: current });
      }
      if (method === "PATCH" && url.includes("/contacts/")) {
        if (body.properties?.address && current.address.trim()) {
          const rows = (await import("../server/lib/order-links")).getSqlite()
            .prepare(`SELECT id, applied_at, old_text FROM contact_address_replacements`)
            .all() as Array<{ id: number; applied_at: string | null; old_text: string }>;
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.applied_at, null);
          assert.match(rows[0]?.old_text ?? "", /9 First St/);
          logId = rows[0]?.id ?? 0;
        }
        patches.push(body.properties ?? {});
        return jsonResponse({ id: "88" });
      }
      if (method === "POST" && url.includes("/objects/deals")) {
        dealDescriptions.push(body.properties?.description ?? "");
        return jsonResponse({ id: "501" });
      }
      if (method === "PUT") return jsonResponse({ ok: true });
      throw new Error(`${method} ${url}`);
    }) as typeof fetch;

    const filled = await updateContact("88", draft, { confirmAddressReplace: true });
    assert.equal(filled, "filled");
    assert.equal(patches.at(-1)?.address, "10909 Hannan Rd");
    assert.equal(logId, 0);

    current = { address: "9 First St", city: "Romulus", state: "Michigan", zip: "48174", country: "United States" };
    await assert.rejects(
      () => updateContact("88", draft, { confirmAddressReplace: true }),
      (error: unknown) => {
        assert.ok(error instanceof PaidOrderAddressConflict);
        assert.equal(error.code, "replace_hubspot");
        assert.match(error.current.address, /9 First St/);
        assert.equal(error.next.street1, "10909 Hannan Rd");
        return true;
      },
    );
    assert.equal(patches.length, 1);

    const replaced = await updateContact("88", draft, { replaceHubspot: true, confirmAddressReplace: true });
    assert.equal(replaced, "replaced");
    assert.equal(patches.at(-1)?.address, "10909 Hannan Rd");
    assert.ok(logId);
    assert.ok(reusedContactAddressAppliedAt(logId));

    patches.length = 0;
    const created = await createPaidOrder(draft, { keepOnOrder: true });
    assert.equal(created.contactId, "88");
    assert.equal(patches.at(-1)?.address, undefined);
    const description = dealDescriptions.at(-1) ?? "";
    assert.match(description, /Ship-to kept on this order/);
    assert.match(description, /10909 Hannan Rd/);
    assert.doesNotMatch(description, /9 First St/);
  });

  test("public address checks are rate limited and cached without tripping the label breaker", async () => {
    resetPublicAddressValidation();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("should use the cache or skip when there is no key");
    }) as typeof fetch;
    const base = { street2: "", city: "San Diego", state: "CA", zip: "92101", country: "US" };
    for (let index = 0; index < 12; index += 1) {
      const checked = await checkCapturedAddress(
        { ...base, street1: `${index + 1} Main St` },
        { audience: "public", rateKey: "cache-buyer" },
      );
      assert.equal(checked.status, "unchecked");
    }
    await assert.rejects(
      () =>
        checkCapturedAddress(
          { ...base, street1: "99 Main St" },
          { audience: "public", rateKey: "cache-buyer" },
        ),
      PublicAddressRateLimitError,
    );
    assert.equal(labelAddressOutageActive(), false);
    assert.equal(calls, 0);
    resetPublicAddressValidation();
    process.env.SHIPENGINE_API_KEY = "TEST_key";
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse([
        {
          status: "verified",
          matched_address: {
            address_line1: "1 Cache St",
            address_line2: "",
            city_locality: "San Diego",
            state_province: "CA",
            postal_code: "92101",
            country_code: "US",
          },
          messages: [],
        },
      ]);
    }) as typeof fetch;
    const first = await checkCapturedAddress(
      { street1: "1 Cache St", street2: "", city: "San Diego", state: "CA", zip: "92101", country: "US" },
      { audience: "public", rateKey: "cache-two" },
    );
    const second = await checkCapturedAddress(
      { street1: "1 Cache St", street2: "", city: "San Diego", state: "CA", zip: "92101", country: "US" },
      { audience: "public", rateKey: "cache-two" },
    );
    assert.equal(first.status, "verified");
    assert.equal(second.status, "verified");
    assert.equal(calls, 1);
    assert.equal(labelAddressOutageActive(), false);
    resetPublicAddressValidation();
    resetAddressCheckOutage();
    delete process.env.SHIPENGINE_API_KEY;
  });
});
