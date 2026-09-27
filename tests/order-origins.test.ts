import test from "node:test";
import assert from "node:assert/strict";
import { buildOrderOrigins, indexZipRows } from "../shared/order-origins";
import { loadUsZipCentroids } from "../server/lib/zip-centroids";
import { buildShopDashboard } from "../shared/shop-dashboard";

const zips = indexZipRows([
  ["92101", "San Diego", "CA", 32.72, -117.16],
  ["92102", "San Diego", "CA", 32.7, -117.1],
  ["10001", "New York", "NY", 40.75, -73.99],
]);

const NOW = "2026-09-15T12:00:00.000Z";

test("origins use ZIP centroids, keep pickup local, and never invent a city", () => {
  const origins = buildOrderOrigins({
    start: new Date("2026-08-16T12:00:00.000Z").getTime(),
    end: new Date(NOW).getTime(),
    zips,
    orders: [
      {
        id: "zip",
        name: "Knight - Ada",
        amount: 80,
        createdAt: "2026-09-10T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "Somewhere", state: "NY", zip: "92101-4455", country: "United States" },
      },
      {
        id: "city",
        name: "Terrain - Bea",
        amount: 40,
        createdAt: "2026-09-11T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "San Diego", state: "California", zip: null, country: null },
      },
      {
        id: "state-only",
        name: "Base - Cal",
        amount: null,
        createdAt: "2026-09-12T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "Springfield", state: "TX", zip: null, country: "US" },
      },
      {
        id: "pickup",
        name: "Sword - Dee",
        amount: 25,
        createdAt: "2026-09-09T12:00:00.000Z",
        pickup: true,
        shipTo: { city: "New York", state: "NY", zip: "10001", country: "US" },
      },
      {
        id: "blank",
        name: "No address",
        amount: 10,
        createdAt: "2026-09-08T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "Paris", state: null, zip: null, country: null },
      },
      {
        id: "france",
        name: "Export - Eve",
        amount: 60,
        createdAt: "2026-09-07T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "Lyon", state: null, zip: "69001", country: "France" },
      },
      {
        id: "old",
        name: "Old",
        amount: 999,
        createdAt: "2026-01-01T12:00:00.000Z",
        pickup: false,
        shipTo: { city: "New York", state: "NY", zip: "10001", country: "US" },
      },
    ],
  });

  assert.equal(origins.unknown, 1);
  assert.equal(origins.pickup.orders, 1);
  assert.equal(origins.pickup.revenue, 25);
  assert.equal(origins.outsideUs, true);
  assert.equal(origins.countries[0]?.name, "France");
  assert.equal(origins.countries[0]?.plotName, "France");
  assert.equal(origins.states.find((row) => row.code === "NY"), undefined);
  const california = origins.states.find((row) => row.code === "CA");
  assert.equal(california?.orders, 2);
  assert.equal(california?.revenue, 120);
  const texas = origins.states.find((row) => row.code === "TX");
  assert.equal(texas?.orders, 1);
  assert.equal(texas?.priced, 0);
  const zipPlace = origins.places.find((place) => place.id === "zip:92101");
  assert.equal(zipPlace?.label, "San Diego, CA");
  assert.equal(zipPlace?.lat, 32.72);
  assert.ok(!("street" in (zipPlace ?? {})));
  const cityPlace = origins.places.find((place) => place.label === "San Diego, CA" && place.id.startsWith("city:"));
  assert.ok(cityPlace);
  assert.ok(Math.abs(cityPlace.lat - 32.71) < 0.02);
  assert.equal(origins.orders.find((order) => order.id === "pickup")?.placeId, "pickup");
  assert.equal(origins.orders.find((order) => order.id === "old"), undefined);
  assert.equal(JSON.stringify(origins).includes("69001"), false);
  assert.equal(JSON.stringify(origins).includes("street"), false);
});

test("dashboard map follows the same period and bundled ZIP file resolves San Diego", () => {
  const dashboard = buildShopDashboard({
    now: NOW,
    period: "30",
    orders: [
      {
        id: "one",
        name: "Knight - Ada",
        customer: "Ada",
        createdAt: "2026-09-10T12:00:00.000Z",
        closedAt: null,
        open: true,
        won: false,
        lost: false,
        stageLabel: "Printing",
        amount: 50,
        resinCost: 10,
        postage: 5,
        packaging: 0,
        shipBy: null,
        tentative: false,
        needsReply: false,
        shipping: "ship",
        hasTracking: false,
        shipTo: { city: "San Diego", state: "CA", zip: "92101", country: "US" },
      },
    ],
    plates: [],
    bits: [],
    failures: [],
    printers: [],
    supplyPurchases: [],
    awaitingClient: 0,
    zips,
  });
  assert.equal(dashboard.origins.places[0]?.label, "San Diego, CA");
  assert.equal(dashboard.origins.unknown, 0);
  const file = loadUsZipCentroids();
  const sanDiego = file.byZip.get("92101");
  assert.equal(sanDiego?.state, "CA");
  assert.equal(sanDiego?.city, "San Diego");
  assert.ok(sanDiego && sanDiego.lat > 32 && sanDiego.lat < 33);
  assert.ok(file.byZip.size > 1000);
});
