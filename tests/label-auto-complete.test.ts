import test from "node:test";
import assert from "node:assert/strict";
import { pickCompletedPrintOrderStage } from "../server/lib/deal-ops";

test("pickCompletedPrintOrderStage prefers closedwon / Completed", () => {
  const pick = pickCompletedPrintOrderStage([
    { id: "appointmentscheduled", label: "Deposit received", metadata: { isClosed: "false" } },
    { id: "4097376993", label: "In production", metadata: { isClosed: "false" } },
    { id: "closedlost", label: "Closed lost", metadata: { isClosed: "true" } },
    { id: "closedwon", label: "Closed Won", metadata: { isClosed: "true" } },
  ]);
  assert.ok(pick);
  assert.equal(pick?.id, "closedwon");
  assert.equal(pick?.label, "Closed Won");
});

test("pickCompletedPrintOrderStage falls back to first closed stage", () => {
  const pick = pickCompletedPrintOrderStage([
    { id: "open", label: "Open", metadata: { isClosed: "false" } },
    { id: "done", label: "Shipped", metadata: { isClosed: "true" } },
  ]);
  assert.equal(pick?.id, "done");
});

test("pickCompletedPrintOrderStage returns null when nothing is closed", () => {
  assert.equal(
    pickCompletedPrintOrderStage([
      { id: "open", label: "Open", metadata: { isClosed: "false" } },
    ]),
    null,
  );
});
