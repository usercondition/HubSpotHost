import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShipNotesFromShippo,
  contactToShippoAddress,
  getShipFromAddress,
  getShippoApiKey,
  getShippoStatus,
  shippoKeyIsTest,
  shippoPurchaseRequestSchema,
  shippoRatesRequestSchema,
  sortShippoRates,
  type ShippoRateOffer,
} from "../server/lib/shippo";

test("shippo env helpers read API key and ship-from", () => {
  const env = {
    SHIPPO_API_KEY: "shippo_test_abc",
    SHIP_FROM_NAME: "Studio Desk",
    SHIP_FROM_STREET1: "100 Resin Ave",
    SHIP_FROM_CITY: "San Diego",
    SHIP_FROM_STATE: "CA",
    SHIP_FROM_ZIP: "92101",
  } as NodeJS.ProcessEnv;
  assert.equal(getShippoApiKey(env), "shippo_test_abc");
  assert.equal(shippoKeyIsTest("shippo_test_abc"), true);
  assert.equal(shippoKeyIsTest("shippo_live_abc"), false);
  const from = getShipFromAddress(env);
  assert.ok(from);
  assert.equal(from?.city, "San Diego");
  const status = getShippoStatus(env);
  assert.equal(status.configured, true);
  assert.equal(status.testMode, true);
});

test("CUSTOM_CRED shippo token wins over SHIPPO_API_KEY", () => {
  const env = {
    CUSTOM_CRED_SHIPPO_API_KEY_TOKEN: "shippo_live_custom",
    SHIPPO_API_KEY: "shippo_test_fallback",
  } as NodeJS.ProcessEnv;
  assert.equal(getShippoApiKey(env), "shippo_live_custom");
});

test("contactToShippoAddress requires a full street address", () => {
  assert.equal(
    contactToShippoAddress({
      name: "Jane",
      email: "j@example.com",
      phone: "",
      street1: "",
      street2: "",
      city: "San Diego",
      state: "CA",
      zip: "92101",
      country: "US",
    }),
    null,
  );
  const ok = contactToShippoAddress({
    name: "Jane Buyer",
    email: "j@example.com",
    phone: "555-0100",
    street1: "9 Print Ln",
    street2: "Apt 2",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "United States",
  });
  assert.equal(ok?.street1, "9 Print Ln");
  assert.equal(ok?.street2, "Apt 2");
});

test("sortShippoRates puts UPS first then cheapest", () => {
  const rates: ShippoRateOffer[] = [
    {
      objectId: "1",
      amount: "8.00",
      currency: "USD",
      provider: "USPS",
      servicelevelName: "Ground Advantage",
      servicelevelToken: "usps_ground_advantage",
      estimatedDays: 3,
      durationTerms: "",
      attributes: ["CHEAPEST"],
    },
    {
      objectId: "2",
      amount: "12.50",
      currency: "USD",
      provider: "UPS",
      servicelevelName: "Ground",
      servicelevelToken: "ups_ground",
      estimatedDays: 2,
      durationTerms: "",
      attributes: [],
    },
    {
      objectId: "3",
      amount: "10.00",
      currency: "USD",
      provider: "UPS",
      servicelevelName: "SurePost",
      servicelevelToken: "ups_surepost",
      estimatedDays: 4,
      durationTerms: "",
      attributes: [],
    },
  ];
  const sorted = sortShippoRates(rates);
  assert.equal(sorted[0]?.objectId, "3");
  assert.equal(sorted[1]?.objectId, "2");
  assert.equal(sorted[2]?.objectId, "1");
});

test("buildShipNotesFromShippo includes service postage and label url", () => {
  const notes = buildShipNotesFromShippo({
    provider: "UPS",
    servicelevelName: "Ground",
    amount: "11.20",
    labelUrl: "https://deliver.goshippo.com/label.pdf",
    recipientName: "Jane",
  });
  assert.match(notes, /UPS Ground/);
  assert.match(notes, /Postage \$11\.20/);
  assert.match(notes, /Label to Jane/);
  assert.match(notes, /Label https:\/\/deliver\.goshippo\.com\/label\.pdf/);
});

test("shippo request schemas validate deal + parcel", () => {
  const rates = shippoRatesRequestSchema.safeParse({
    dealId: "1234567890",
    parcel: { lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });
  assert.equal(rates.success, true);

  const bad = shippoRatesRequestSchema.safeParse({
    dealId: "abc",
    parcel: { lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });
  assert.equal(bad.success, false);

  const purchase = shippoPurchaseRequestSchema.safeParse({
    dealId: "1234567890",
    rateObjectId: "rate_abcdef12",
    amount: "9.99",
    provider: "UPS",
    servicelevelName: "Ground",
  });
  assert.equal(purchase.success, true);
  if (purchase.success) {
    assert.deepEqual(purchase.data.dealIds, ["1234567890"]);
  }
});
