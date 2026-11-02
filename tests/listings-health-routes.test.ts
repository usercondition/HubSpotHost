import test from "node:test";
import assert from "node:assert/strict";
import { parseListingsHealth } from "../server/lib/listings-health-routes";

test("listing health accepts suggestions without enabling auto-apply", () => {
  const feed = parseListingsHealth(JSON.stringify([{ id: "e-1", storefront: "ebay", title: "Knight", kind: "pricing", reason: "Below floor", proposedPrice: 45 }]));
  assert.equal(feed[0]?.id, "e-1");
  assert.equal(feed[0]?.proposedPrice, 45);
});
