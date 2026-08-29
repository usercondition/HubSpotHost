import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionNextStep,
  floorFocusHref,
  floorFocusMeta,
  hubspotContactHref,
  hubspotDealHref,
  hubspotDealsListHref,
  isFloorFocusKind,
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

test("HubSpot contact deep links use object type 0-1", () => {
  assert.equal(
    hubspotContactHref("51", "12345"),
    "https://app.hubspot.com/contacts/12345/record/0-1/51",
  );
  assert.equal(hubspotContactHref("51", null), "https://app.hubspot.com/");
});

test("attention next steps route plates and costs into Print files", () => {
  assert.deepEqual(attentionNextStep({ dealId: "1", issue: "No CTB plates attached" }), {
    href: printsDealHref("1"),
    label: "Attach plates",
    external: false,
  });
  assert.deepEqual(
    attentionNextStep({ dealId: "2", issue: "Cost details incomplete", portalId: "99" }),
    {
      href: printsDealHref("2"),
      label: "Apply cost defaults",
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

test("floor focus chip shortcuts map to focused lists and workspaces", () => {
  assert.equal(isFloorFocusKind("plates"), true);
  assert.equal(isFloorFocusKind("nope"), false);
  assert.equal(floorFocusHref("costs"), "/focus/costs");
  assert.equal(floorFocusMeta("plates").issueKey, "no_plates");
  assert.equal(floorFocusMeta("plates").workspaceHref, "/prints");
  assert.equal(floorFocusMeta("intake").workspaceHref, "/orders");
  assert.equal(floorFocusMeta("buyer").issueKey, null);
});
