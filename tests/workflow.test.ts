import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionNextStep,
  floorFocusHref,
  floorWorkHref,
  parkedQueueHref,
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

test("ship-ready and blocked floor rows open the Stack, printer rows open Queue", () => {
  assert.equal(floorWorkHref("4", "ship_ready"), "/stack?dealId=4");
  assert.equal(floorWorkHref("3", "blocked"), "/stack?dealId=3");
  assert.equal(floorWorkHref("1", "next_print"), "/queue?dealId=1");
  assert.equal(floorWorkHref("2", "in_production"), "/queue?dealId=2");
});

test("Queue deep links for removed lanes open the Stack", () => {
  const lanes = {
    nextPrint: ["1"],
    inProduction: ["2"],
    shipReady: ["4"],
    blocked: ["3"],
  };
  assert.equal(parkedQueueHref("4", lanes), "/stack?dealId=4");
  assert.equal(parkedQueueHref("3", lanes), "/stack?dealId=3");
  assert.equal(parkedQueueHref("1", lanes), null);
  assert.equal(parkedQueueHref("2", lanes), null);
  assert.equal(parkedQueueHref("missing", lanes), null);
});

test("attention next steps route plates to Prints and costs to Queue ops", () => {
  assert.deepEqual(attentionNextStep({ dealId: "1", issue: "No CTB plates attached" }), {
    href: printsDealHref("1"),
    label: "Attach plates",
    external: false,
  });
  assert.deepEqual(
    attentionNextStep({ dealId: "2", issue: "Cost details incomplete", portalId: "99" }),
    {
      href: "/queue?dealId=2",
      label: "Enter costs",
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

test("floor focus chip shortcuts map to workspaces not intermediate focus pages", () => {
  assert.equal(isFloorFocusKind("plates"), true);
  assert.equal(isFloorFocusKind("nope"), false);
  assert.equal(floorFocusHref("costs"), "/queue");
  assert.equal(floorFocusHref("plates"), "/prints");
  assert.equal(floorFocusHref("intake"), "/orders");
  assert.equal(floorFocusMeta("plates").issueKey, "no_plates");
  assert.equal(floorFocusMeta("plates").workspaceHref, "/prints");
  assert.equal(floorFocusMeta("intake").workspaceHref, "/orders");
  assert.equal(floorFocusMeta("buyer").issueKey, null);
});
