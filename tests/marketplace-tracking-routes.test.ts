import test from "node:test";
import assert from "node:assert/strict";
import { marketplacePushMode } from "../server/lib/marketplace-tracking-routes";

test("marketplace tracking adapters default to dry-run", () => {
  assert.equal(marketplacePushMode("ebay", {}), "dry-run");
  assert.equal(marketplacePushMode("etsy", {}), "dry-run");
  assert.equal(marketplacePushMode("ebay", { MARKETPLACE_EBAY_TRACKING_PUSH_MODE: "live" }), "live");
  assert.equal(marketplacePushMode("etsy", { MARKETPLACE_ETSY_TRACKING_PUSH_MODE: "unexpected" }), "dry-run");
});
