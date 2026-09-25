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

test("stack row numbers run straight down the list when stored ranks repeat", () => {
  const lines = rowsWithDividers(
    [
      row({ key: "a", tier: "committed", rank: 1 }),
      row({ key: "b", tier: "committed", rank: 2 }),
      row({ key: "c", tier: "committed", rank: 3 }),
      row({ key: "d", tier: "committed", rank: 4 }),
      row({ key: "e", tier: "committed", rank: 5 }),
      row({ key: "f", tier: "committed", rank: 4 }),
      row({ key: "g", tier: "stretch", rank: 5 }),
      row({ key: "h", tier: "later", rank: 6 }),
      row({ key: "i", tier: "later", rank: 7 }),
    ],
    { committed: 20, stretch: 10, later: 5, outTheDoor: 0, offBookUnpriced: 0 },
  );
  assert.deepEqual(
    lines.filter((line) => line.type === "row").map((line) => line.row.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("a bundled stack still numbers one row at a time", () => {
  const lines = rowsWithDividers(
    [1, 2, 3, 4, 5, 6, 7].map((rank) =>
      row({
        key: `row-${rank}`,
        tier: rank <= 4 ? "committed" : rank === 5 ? "stretch" : "later",
        rank,
        kind: rank === 3 ? "bundle" : "deal",
      }),
    ),
    { committed: 20, stretch: 10, later: 5, outTheDoor: 0, offBookUnpriced: 0 },
  );
  assert.deepEqual(
    lines.filter((line) => line.type === "row").map((line) => line.row.rank),
    [1, 2, 3, 4, 5, 6, 7],
  );
});
