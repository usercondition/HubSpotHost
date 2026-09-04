import test from "node:test";
import assert from "node:assert/strict";
import {
  filterShopShippingRates,
  isEnvelopeLikeRate,
  isShopUsualBoxRate,
} from "../shared/shipping-rate-prefs";

test("usual box prefs keep UPS Ground and USPS Ground Advantage / Priority", () => {
  const rates = [
    {
      carrierCode: "ups",
      carrierFriendlyName: "UPS",
      serviceCode: "ups_ground",
      serviceType: "UPS Ground",
    },
    {
      carrierCode: "ups",
      carrierFriendlyName: "UPS",
      serviceCode: "ups_ground_saver",
      serviceType: "UPS Ground Saver",
    },
    {
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_ground_advantage",
      serviceType: "USPS Ground Advantage",
    },
    {
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_priority_mail",
      serviceType: "Priority Mail",
    },
    {
      carrierCode: "ups",
      carrierFriendlyName: "UPS",
      serviceCode: "ups_next_day_air",
      serviceType: "Next Day Air",
    },
    {
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_first_class_mail",
      serviceType: "First Class Mail",
    },
    {
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_priority_mail_express",
      serviceType: "Priority Mail Express",
    },
    {
      carrierCode: "stamps_com",
      carrierFriendlyName: "USPS",
      serviceCode: "usps_first_class_mail",
      serviceType: "Large Envelope",
    },
  ];

  assert.equal(isShopUsualBoxRate(rates[0]!), true);
  assert.equal(isShopUsualBoxRate(rates[4]!), false);
  assert.equal(isEnvelopeLikeRate(rates[7]!), true);

  const usual = filterShopShippingRates(rates, "usual");
  assert.deepEqual(
    usual.map((r) => r.serviceCode),
    ["ups_ground", "ups_ground_saver", "usps_ground_advantage", "usps_priority_mail"],
  );

  const all = filterShopShippingRates(rates, "all");
  assert.ok(all.every((r) => !isEnvelopeLikeRate(r)));
  assert.ok(all.some((r) => r.serviceCode === "ups_next_day_air"));
  assert.ok(!all.some((r) => /envelope/i.test(r.serviceType)));
});
