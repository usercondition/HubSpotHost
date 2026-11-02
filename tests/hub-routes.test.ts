import test from "node:test";
import assert from "node:assert/strict";
import { buildHubSnapshot } from "../server/lib/hub-routes";

test("Hub compares only sourced storefront data and leaves unavailable feeds null", () => {
  const snapshot = buildHubSnapshot([
    { id: "1", properties: { amount: "40", print_order_source: "ebay", dealstage: "ready" } },
    { id: "2", properties: { amount: "60", print_order_source: "etsy", dealstage: "printing" } },
  ]);

  assert.deepEqual(snapshot.storefronts.ebay, {
    source: "ebay",
    orders: 1,
    sales: 40,
    averageOrderValue: 40,
    listingCount: null,
    attentionFlags: null,
  });
  assert.equal(snapshot.storefronts.offerup.sales, null);
  assert.equal(snapshot.storefronts.offerup.orders, 0);
  assert.equal(snapshot.storefronts.offerup.listingCount, null);
});
