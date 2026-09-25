import test from "node:test";
import assert from "node:assert/strict";
import { rowsWithDividers, targetLabel, type StackRowModel } from "../client/src/components/priority-stack-list";

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

test("a tentative date is spelled out and set or plan stays for the rest", () => {
  const today = "2026-09-25";
  assert.equal(
    targetLabel(row({ key: "tent", tier: "committed", targetDate: "2026-10-02", targetSource: "local", tentative: true }), today),
    "Oct 2 · tentative",
  );
  assert.equal(
    targetLabel(row({ key: "due", tier: "committed", targetDate: today, targetSource: "override", tentative: true }), today),
    "Due today · tentative",
  );
  assert.equal(
    targetLabel(row({ key: "late", tier: "committed", targetDate: "2026-09-20", targetSource: "derived", tentative: true }), today),
    "Overdue Sep 20 · tentative",
  );
  assert.equal(
    targetLabel(row({ key: "set", tier: "committed", targetDate: "2026-09-27", targetSource: "override", tentative: false }), today),
    "Sep 27 · set",
  );
  assert.equal(
    targetLabel(row({ key: "plan", tier: "committed", targetDate: "2026-09-28", targetSource: "derived", tentative: false }), today),
    "Sep 28 · plan",
  );
  assert.equal(
    targetLabel(row({ key: "unset", tier: "committed", targetDate: "2026-09-27", targetSource: "unset", tentative: false }), today),
    "Sep 27 · unset",
  );
  assert.equal(
    targetLabel(row({ key: "unset-tent", tier: "committed", targetDate: "2026-10-02", targetSource: "unset", tentative: true }), today),
    "Oct 2 · tentative",
  );
  assert.equal(targetLabel(row({ key: "tent", tier: "committed", tentative: true }), today).includes("~"), false);
});
