import test from "node:test";
import assert from "node:assert/strict";
import {
  extractShippingLabelFields,
  extractShippingLabelFromPdf,
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
  assert.equal(fields.clientName, "Luke Price");
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

test("file-name client beats ship-to address when matching HubSpot deals", async () => {
  const fields = extractShippingLabelFields(
    `
USPS GROUND ADVANTAGE
MIGUEL E MERCADO
4547 KENSINGTON DR
SAN DIEGO CA 92116-3835
SPENCER PATTERSON
112 THELMA ST
TRUMANN AR 72472-2056
9300111043900010978789
`,
    "2026-08-26---Spencer-Patterson---9300111043900010978789.pdf",
  );

  assert.equal(fields.trackingNumber, "9300111043900010978789");
  assert.equal(fields.clientName, "Spencer Patterson");
  assert.equal(fields.recipientName, "MIGUEL E MERCADO");
  assert.ok(fields.warnings.some((warning) => /Spencer Patterson/i.test(warning)));

  const matches = matchShippingLabelToDeals(fields, [
    {
      dealId: "1",
      dealName: "Cover for Suit - Ryan Shipp",
      stage: "Ready to Ship",
      contactName: "Ryan Shipp",
      amount: 0,
      closed: false,
    },
    {
      dealId: "2",
      dealName: "BR Panels - Spencer Patterson",
      stage: "Completed / Closed Won",
      contactName: "Spencer Patterson",
      amount: 0,
      closed: true,
    },
    {
      dealId: "3",
      dealName: "Land Raider Banisher - Spencer Patterson",
      stage: "Completed / Closed Won",
      contactName: "Spencer Patterson",
      amount: 79.99,
      closed: true,
    },
    {
      dealId: "4",
      dealName: "GK Combat Patrol - Luke price",
      stage: "Completed / Closed Won",
      contactName: "Luke price",
      amount: 50,
      closed: true,
    },
  ]);

  assert.ok(matches.length >= 1);
  assert.ok(matches.every((match) => /spencer/i.test(match.dealName)));
  assert.equal(matches[0]?.dealId, "2");
  assert.ok(!matches.some((match) => match.dealId === "1"), "Ready-to-Ship Ryan must not win");
});

test("real Spencer Patterson Pirate Ship PDF prefers file-name client matches", async () => {
  const extracted = await extractShippingLabelFromPdf(
    "/home/ubuntu/.cursor/projects/workspace/uploads/2026-08-26---Spencer-Patterson---9300111043900010978789_dfc6.pdf",
    "2026-08-26---Spencer-Patterson---9300111043900010978789.pdf",
  );
  assert.equal(extracted.fields.trackingNumber, "9300111043900010978789");
  assert.equal(extracted.fields.clientName, "Spencer Patterson");
  assert.match(extracted.fields.recipientName ?? "", /MIGUEL/i);

  const matches = matchShippingLabelToDeals(extracted.fields, [
    {
      dealId: "ryan",
      dealName: "Cover for Suit - Ryan Shipp",
      stage: "Ready to Ship",
      contactName: "Ryan Shipp",
      amount: 0,
      closed: false,
    },
    {
      dealId: "spencer-a",
      dealName: "BR Panels - Spencer Patterson",
      stage: "Completed / Closed Won",
      contactName: "Spencer Patterson",
      amount: 0,
      closed: true,
    },
    {
      dealId: "spencer-b",
      dealName: "Land Raider Banisher - Spencer Patterson",
      stage: "Completed / Closed Won",
      contactName: "Spencer Patterson",
      amount: 79.99,
      closed: true,
    },
  ]);
  assert.equal(matches[0]?.dealId, "spencer-a");
  assert.ok(!matches.some((match) => match.dealId === "ryan"));
});

test("ship notes summarize service and postage", () => {
  const fields = extractShippingLabelFields(PIRATE_SHIP_LIKE);
  const notes = buildShipNotesFromLabel(fields);
  assert.match(notes, /Ground Advantage/i);
  assert.match(notes, /5\.42/);
  assert.match(notes, /Jose Montes/);
});
