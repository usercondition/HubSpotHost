import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../server/lib/contacts";

test("mapContactRow builds a card from HubSpot properties", () => {
  const card = __test.mapContactRow({
    id: "51",
    properties: {
      firstname: "Ada",
      lastname: "Lovelace",
      email: "ada@example.com",
      phone: "+1 555 0100",
      company: "Analytical Engines",
      address: "12 Computing Ln",
      city: "London",
      state: "ENG",
      zip: "EC1A 1BB",
      country: "UK",
      createdate: "2020-01-01T00:00:00.000Z",
      lastmodifieddate: "2024-06-01T00:00:00.000Z",
    },
  });

  assert.deepEqual(card, {
    contactId: "51",
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 555 0100",
    company: "Analytical Engines",
    address: "12 Computing Ln",
    city: "London",
    state: "ENG",
    postalCode: "EC1A 1BB",
    country: "UK",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
  });
});

test("mapContactRow falls back to email local-part when name is empty", () => {
  const card = __test.mapContactRow({
    id: "9",
    properties: { email: "buyer@shop.test" },
  });
  assert.equal(card?.fullName, "buyer");
  assert.equal(card?.email, "buyer@shop.test");
});

test("mapContactRow returns null without an id", () => {
  assert.equal(__test.mapContactRow({ properties: { email: "x@y.z" } }), null);
});
