import test from "node:test";
import assert from "node:assert/strict";
import { rowsWithDividers, type StackRowModel } from "../client/src/components/priority-stack-list";

function row(partial: Partial<StackRowModel> & Pick<StackRowModel, "key" | "tier">): StackRowModel {
  return {
    kind: "deal",
    rank: 1,
    manual: false,
    isNew: false,
    name: partial.key,
    contactName: null,
    stage: "Printing",
    bucket: "in_production",
    lane: "fly",
    blocker: "",
    blockerSource: "auto",
    nextStep: "",
    targetDate: "2026-09-27",
    targetSource: "derived",
    tentative: false,
    amount: 10,
    shippingRequired: true,
    dealId: "1",
    offbookId: null,
    bundleId: null,
    fulfillment: null,
    steps: [],
    members: [],
    ...partial,
  };
}

test("commit line follows the last this-week row and the last stretch row", () => {
  const lines = rowsWithDividers(
    [
      row({ key: "a", tier: "committed" }),
      row({ key: "b", tier: "stretch" }),
      row({ key: "c", tier: "committed" }),
      row({ key: "d", tier: "later" }),
    ],
    { committed: 20, stretch: 10, later: 5, outTheDoor: 0, offBookUnpriced: 0 },
  );
  assert.deepEqual(
    lines.map((line) => (line.type === "row" ? line.row.key : line.label)),
    ["a", "b", "Stretch", "c", "This week", "d"],
  );
});
