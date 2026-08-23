import test from "node:test";
import assert from "node:assert/strict";
import { draftBuyerTrackingMessage } from "../shared/shipping-draft";

test("buyer tracking draft uses first name and UPS tracking", () => {
  const message = draftBuyerTrackingMessage({
    contactName: "Luke Price",
    dealName: "Cover for Suit - Luke Price",
    trackingNumber: "1ZXG9979YN44057388",
    carrier: "UPS",
  });
  assert.match(message, /^Hey Luke — your print order shipped!/m);
  assert.match(message, /Tracking \(UPS\): 1ZXG9979YN44057388/);
  assert.match(message, /Reply here if you need anything/);
});
