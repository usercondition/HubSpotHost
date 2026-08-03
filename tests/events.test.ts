import test from "node:test";
import assert from "node:assert/strict";
import { readDealId, readPropertyName, summarizeEvents } from "../server/lib/events";

test("accepts an array payload and matches input property changes", () => {
  const s = summarizeEvents([
    {
      objectId: 111,
      propertyName: "amount",
      subscriptionType: "deal.propertyChange",
      objectTypeId: "0-3",
    },
  ]);
  assert.deepEqual(s.dealIds, ["111"]);
  assert.equal(s.matched, 1);
  assert.equal(s.received, 1);
});

test("supports propertyName, property and propertyname spellings", () => {
  const s = summarizeEvents([
    { objectId: 1, objectTypeId: "0-3", propertyName: "print_material_cost" },
    { objectId: 2, objectTypeId: "0-3", property: "print_labor_cost" },
    { objectId: 3, objectTypeId: "0-3", propertyname: "print_packaging_cost" },
  ]);
  assert.deepEqual(s.dealIds, ["1", "2", "3"]);
  assert.equal(s.matched, 3);
});

test("de-duplicates repeated deal ids within one batch", () => {
  const s = summarizeEvents([
    { objectId: 55, objectTypeId: "0-3", propertyName: "amount" },
    { objectId: "55", objectTypeId: "0-3", propertyName: "print_labor_cost" },
    { objectId: 55, objectTypeId: "0-3", propertyName: "print_actual_shipping_cost" },
  ]);
  assert.deepEqual(s.dealIds, ["55"]);
  assert.equal(s.matched, 3);
});

test("ignores output property events so writes cannot loop", () => {
  const s = summarizeEvents([
    { objectId: 9, objectTypeId: "0-3", propertyName: "print_gross_profit" },
    { objectId: 9, objectTypeId: "0-3", propertyName: "print_margin_percentage" },
  ]);
  assert.deepEqual(s.dealIds, []);
  assert.equal(s.ignoredOutputEvents, 2);
});

test("ignores non-deal objects and unrelated properties", () => {
  const s = summarizeEvents([
    { objectId: 7, objectTypeId: "0-1", propertyName: "amount" },
    { objectId: 8, objectTypeId: "0-3", propertyName: "dealstage" },
    { objectId: 8, objectTypeId: "0-3" },
    "nonsense",
  ]);
  assert.deepEqual(s.dealIds, []);
  assert.equal(s.ignoredOther, 4);
});

test("recognizes deals via objectType, subscriptionType or dealId", () => {
  const s = summarizeEvents([
    { objectId: 21, objectType: "DEAL", propertyName: "amount" },
    { objectId: 22, subscriptionType: "deal.propertyChange", property: "print_labor_cost" },
    { dealId: 23, propertyname: "print_packaging_cost" },
  ]);
  assert.deepEqual(s.dealIds, ["21", "22", "23"]);
});

test("unwraps an object payload with an events array", () => {
  const s = summarizeEvents({
    events: [{ objectId: 31, objectTypeId: "0-3", propertyName: "amount" }],
  });
  assert.deepEqual(s.dealIds, ["31"]);
});

test("empty and malformed payloads are safe", () => {
  assert.deepEqual(summarizeEvents([]).dealIds, []);
  assert.deepEqual(summarizeEvents(null).dealIds, []);
  assert.deepEqual(summarizeEvents("x").dealIds, []);
});

test("property names are matched case-insensitively", () => {
  const s = summarizeEvents([{ objectId: 4, objectTypeId: "0-3", propertyName: "AMOUNT" }]);
  assert.deepEqual(s.dealIds, ["4"]);
  assert.equal(readPropertyName({ propertyName: " Amount " }), "amount");
  assert.equal(readDealId({ objectId: 12 }), "12");
  assert.equal(readDealId({}), null);
});
