import test from "node:test";
import assert from "node:assert/strict";
import { printOrderStageLooksArchived } from "../shared/schema";

test("print order archive stages cover completed and shipped", () => {
  assert.equal(printOrderStageLooksArchived("Completed / Closed Won"), true);
  assert.equal(printOrderStageLooksArchived("Closed Won"), true);
  assert.equal(printOrderStageLooksArchived("Shipped"), true);
  assert.equal(printOrderStageLooksArchived("Ready to Ship"), false);
  assert.equal(printOrderStageLooksArchived("Post-Process / QC"), false);
  assert.equal(printOrderStageLooksArchived("In Production"), false);
  assert.equal(printOrderStageLooksArchived("Queued to Print"), false);
});
