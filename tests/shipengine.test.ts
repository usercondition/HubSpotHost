import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShipNotesFromShipEngine,
  contactToShipEngineAddress,
  ensureShipEnginePhones,
  getShipEngineApiKey,
  getShipEngineStatus,
  getShipFromAddress,
  shipEngineKeyIsTest,
  shipEnginePurchaseRequestSchema,
  shipEngineRatesRequestSchema,
  sortShipEngineRates,
  type ShipEngineRateOffer,
} from "../server/lib/shipengine";

test("shipengine env helpers read API key and ship-from", () => {
  const env = {
    SHIPENGINE_API_KEY: "TEST_abc",
    SHIP_FROM_NAME: "Studio Desk",
    SHIP_FROM_STREET1: "100 Resin Ave",
    SHIP_FROM_CITY: "San Diego",
    SHIP_FROM_STATE: "CA",
    SHIP_FROM_ZIP: "92101",
    SHIP_FROM_PHONE: "6195550100",
  } as NodeJS.ProcessEnv;
  assert.equal(getShipEngineApiKey(env), "TEST_abc");
  assert.equal(shipEngineKeyIsTest("TEST_abc"), true);
  assert.equal(shipEngineKeyIsTest("prod_abc"), false);
  const from = getShipFromAddress(env);
  assert.ok(from);
  assert.equal(from?.city, "San Diego");
  assert.equal(from?.phone, "6195550100");
  const status = getShipEngineStatus(env);
  assert.equal(status.configured, true);
  assert.equal(status.hasShipFromPhone, true);
  assert.equal(status.testMode, true);
});

test("ShipEngine is not configured without SHIP_FROM_PHONE", () => {
  const env = {
    SHIPENGINE_API_KEY: "TEST_abc",
    SHIP_FROM_NAME: "Studio Desk",
    SHIP_FROM_STREET1: "100 Resin Ave",
    SHIP_FROM_CITY: "San Diego",
    SHIP_FROM_STATE: "CA",
    SHIP_FROM_ZIP: "92101",
  } as NodeJS.ProcessEnv;
  const status = getShipEngineStatus(env);
  assert.equal(status.hasShipFrom, true);
  assert.equal(status.hasShipFromPhone, false);
  assert.equal(status.configured, false);
});

test("ensureShipEnginePhones uses shop phone only — client phone optional", () => {
  const from = {
    name: "Shop",
    street1: "1 Studio",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
    phone: "6195550100",
  };
  const toNoPhone = {
    name: "Buyer",
    street1: "9 Print Ln",
    city: "Sioux Falls",
    state: "SD",
    zip: "57107",
    country: "US",
  };
  const filled = ensureShipEnginePhones(from, toNoPhone);
  assert.ok(!("error" in filled));
  if ("error" in filled) return;
  assert.equal(filled.addressFrom.phone, "6195550100");
  assert.equal(filled.addressTo.phone, "6195550100");

  const missingShop = ensureShipEnginePhones({ ...from, phone: undefined }, toNoPhone);
  assert.ok("error" in missingShop);
  assert.match(missingShop.error, /SHIP_FROM_PHONE/);
});

test("CUSTOM_CRED shipengine token wins over SHIPENGINE_API_KEY", () => {
  const env = {
    CUSTOM_CRED_SHIPENGINE_API_KEY_TOKEN: "live_custom",
    SHIPENGINE_API_KEY: "TEST_fallback",
  } as NodeJS.ProcessEnv;
  assert.equal(getShipEngineApiKey(env), "live_custom");
});

test("contactToShipEngineAddress requires a full street address", () => {
  assert.equal(
    contactToShipEngineAddress({
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
  const ok = contactToShipEngineAddress({
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
  assert.equal(ok?.country, "US");
});

test("sortShipEngineRates puts UPS first then cheapest", () => {
  const rates: ShipEngineRateOffer[] = [
    {
      rateId: "1",
      amount: "8.00",
      currency: "USD",
      carrierId: "se-1",
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_ground_advantage",
      serviceType: "Ground Advantage",
      deliveryDays: 3,
      estimatedDeliveryDate: null,
      attributes: ["cheapest"],
    },
    {
      rateId: "2",
      amount: "12.50",
      currency: "USD",
      carrierId: "se-2",
      carrierCode: "ups",
      carrierFriendlyName: "UPS",
      serviceCode: "ups_ground",
      serviceType: "Ground",
      deliveryDays: 2,
      estimatedDeliveryDate: null,
      attributes: [],
    },
    {
      rateId: "3",
      amount: "10.00",
      currency: "USD",
      carrierId: "se-2",
      carrierCode: "ups",
      carrierFriendlyName: "UPS",
      serviceCode: "ups_ground_saver",
      serviceType: "Ground Saver",
      deliveryDays: 4,
      estimatedDeliveryDate: null,
      attributes: [],
    },
  ];
  const sorted = sortShipEngineRates(rates);
  assert.equal(sorted[0]?.rateId, "3");
  assert.equal(sorted[1]?.rateId, "2");
  assert.equal(sorted[2]?.rateId, "1");
});

test("buildShipNotesFromShipEngine includes service postage and label url", () => {
  const notes = buildShipNotesFromShipEngine({
    carrierCode: "ups",
    serviceType: "ups_ground",
    amount: "11.20",
    labelUrl: "https://api.shipengine.com/v1/labels/x.pdf",
    recipientName: "Jane",
  });
  assert.match(notes, /ups ups_ground/);
  assert.match(notes, /Postage \$11\.20/);
  assert.match(notes, /Label to Jane/);
});

test("shipengine request schemas validate deal + parcel", () => {
  const rates = shipEngineRatesRequestSchema.safeParse({
    dealId: "1234567890",
    parcel: { lengthIn: 8, widthIn: 6, heightIn: 4, weightOz: 16 },
  });
  assert.equal(rates.success, true);

  const purchase = shipEnginePurchaseRequestSchema.safeParse({
    dealId: "1234567890",
    rateId: "se-12345",
    amount: "9.99",
    carrierCode: "ups",
    serviceType: "Ground",
  });
  assert.equal(purchase.success, true);
  if (purchase.success) {
    assert.deepEqual(purchase.data.dealIds, ["1234567890"]);
  }
});
