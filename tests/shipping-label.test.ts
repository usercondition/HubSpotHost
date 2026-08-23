import test from "node:test";
import assert from "node:assert/strict";
import {
  extractShippingLabelFields,
  matchShippingLabelToDeals,
  buildShipNotesFromLabel,
} from "../server/lib/shipping-label";

const PIRATE_SHIP_LIKE = `
USPS GROUND ADVANTAGE
Postage $5.42

SHIP TO:
Jose Montes
123 Resin Way
San Diego, CA 92101

9400111899223344556677
`;

test("image-only Pirate Ship filename fills UPS tracking and client", () => {
  const fields = extractShippingLabelFields(
    "",
    "2026-08-22---Luke-Price---1ZXG9979YN44057388.pdf",
  );
  assert.equal(fields.trackingNumber, "1ZXG9979YN44057388");
  assert.equal(fields.carrier, "UPS");
  assert.equal(fields.recipientName, "Luke Price");
  assert.ok(fields.warnings.some((warning) => /file name/i.test(warning)));
});

test("shipping label extract pulls USPS tracking, service, postage, and recipient", () => {
  const fields = extractShippingLabelFields(PIRATE_SHIP_LIKE);
  assert.equal(fields.trackingNumber, "9400111899223344556677");
  assert.equal(fields.carrier, "USPS");
  assert.match(fields.service ?? "", /Ground Advantage/i);
  assert.equal(fields.postageUsd, "5.42");
  assert.equal(fields.recipientName, "Jose Montes");
  assert.equal(fields.recipientCity, "San Diego");
  assert.equal(fields.recipientState, "CA");
  assert.equal(fields.recipientPostalCode, "92101");
});

test("shipping label match prefers client name and completed deals", () => {
  const fields = extractShippingLabelFields(PIRATE_SHIP_LIKE);
  const matches = matchShippingLabelToDeals(fields, [
    {
      dealId: "100",
      dealName: "Armigers - Other Person",
      stage: "Printing",
      contactName: "Other Person",
      amount: 40,
      closed: false,
    },
    {
      dealId: "200",
      dealName: "Cover for Suit - Jose Montes",
      stage: "Completed",
      contactName: "Jose Montes",
      amount: 120,
      closed: true,
    },
  ]);
  assert.equal(matches[0]?.dealId, "200");
  assert.ok((matches[0]?.score ?? 0) > (matches[1]?.score ?? 0));
});

test("ship notes summarize service and postage", () => {
  const fields = extractShippingLabelFields(PIRATE_SHIP_LIKE);
  const notes = buildShipNotesFromLabel(fields);
  assert.match(notes, /Ground Advantage/i);
  assert.match(notes, /5\.42/);
  assert.match(notes, /Jose Montes/);
});
