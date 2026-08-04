import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhotonFeatures } from "../server/lib/address-suggest";

test("photon features normalize into fillable address parts", () => {
  const suggestions = normalizePhotonFeatures([
    {
      properties: {
        housenumber: "350",
        street: "5th Avenue",
        city: "New York",
        state: "New York",
        postcode: "10118",
        country: "United States",
      },
    },
    {
      properties: {
        name: "CN Tower",
        city: "Toronto",
        state: "Ontario",
        postcode: "M5V 3L9",
        country: "Canada",
      },
    },
  ]);

  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0]?.street, "350 5th Avenue");
  assert.equal(suggestions[0]?.city, "New York");
  assert.equal(suggestions[0]?.postalCode, "10118");
  assert.match(suggestions[0]?.label ?? "", /350 5th Avenue/);
  assert.equal(suggestions[1]?.street, "CN Tower");
  assert.equal(suggestions[1]?.city, "Toronto");
});

test("photon normalization skips empty and duplicate labels", () => {
  const suggestions = normalizePhotonFeatures([
    { properties: {} },
    {
      properties: {
        street: "Main St",
        city: "Austin",
        state: "Texas",
        postcode: "78701",
        country: "United States",
      },
    },
    {
      properties: {
        street: "Main St",
        city: "Austin",
        state: "Texas",
        postcode: "78701",
        country: "United States",
      },
    },
  ]);
  assert.equal(suggestions.length, 1);
});
