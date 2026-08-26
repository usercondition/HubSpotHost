import test from "node:test";
import assert from "node:assert/strict";
import {
  buyerTrackingEmailSubject,
  buyerTrackingMailtoHref,
  draftBuyerTrackingMessage,
} from "../shared/shipping-draft";

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

test("buyer tracking draft lists multiple shared-box orders", () => {
  const message = draftBuyerTrackingMessage({
    contactName: "Spencer Patterson",
    dealNames: [
      "BR Panels - Spencer Patterson",
      "Land Raider Banisher - Spencer Patterson",
    ],
    trackingNumber: "9300111043900010978789",
    service: "USPS Ground Advantage",
  });
  assert.match(message, /your print orders shipped together \(2 items\)/i);
  assert.match(message, /Includes: BR Panels - Spencer Patterson; Land Raider Banisher - Spencer Patterson/);
  assert.match(message, /Tracking \(USPS Ground Advantage\): 9300111043900010978789/);
});

test("email subject notes extra shared-box orders", () => {
  assert.match(
    buyerTrackingEmailSubject("BR Panels - Spencer Patterson", 2),
    /\+1 more/,
  );
});
