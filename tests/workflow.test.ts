import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionNextStep,
  hubspotDealHref,
  hubspotDealsListHref,
  printsDealHref,
} from "../client/src/lib/workflow";

test("HubSpot deal deep links require a portal id", () => {
  assert.equal(
    hubspotDealHref("9001", "12345"),
    "https://app.hubspot.com/contacts/12345/record/0-3/9001",
  );
  assert.equal(hubspotDealHref("9001", null), "https://app.hubspot.com/");
  assert.equal(
    hubspotDealsListHref("12345"),
    "https://app.hubspot.com/contacts/12345/objects/0-3/views/all/list",
  );
});

test("attention next steps route plates in-app and costs to the queue", () => {
  assert.deepEqual(attentionNextStep({ dealId: "1", issue: "No CTB plates attached" }), {
    href: printsDealHref("1"),
    label: "Attach plates",
    external: false,
  });
  assert.deepEqual(
    attentionNextStep({ dealId: "2", issue: "Cost details incomplete", portalId: "99" }),
    {
      href: "/queue?dealId=2",
      label: "Enter costs in Queue",
      external: false,
    },
  );
  assert.deepEqual(
    attentionNextStep({ dealId: "3", issue: "No activity for 10 days", portalId: "99" }),
    {
      href: "/queue?dealId=3",
      label: "Open in Queue",
      external: false,
    },
  );
});
