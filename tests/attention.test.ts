import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(os.tmpdir(), `attention-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const {
  activeAttentionOverrideKeys,
  clearAttentionOverride,
  dismissAttentionAlert,
  attentionIssueKeyFromIssue,
} = await import("../server/lib/attention");

after(() => {
  resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

test("attention issue keys map plate and cost reminders", () => {
  assert.equal(attentionIssueKeyFromIssue("No CTB plates attached"), "no_plates");
  assert.equal(attentionIssueKeyFromIssue("Cost details incomplete"), "costs_incomplete");
  assert.equal(attentionIssueKeyFromIssue("Margin below 40%"), "low_margin");
});

test("dismissed alerts persist until cleared", () => {
  const created = dismissAttentionAlert({
    dealId: "12345",
    issueKey: "no_plates",
    note: "Legacy order",
  });
  assert.equal(created.hubspotDealId, "12345");
  assert.ok(activeAttentionOverrideKeys().has("12345:no_plates"));

  assert.equal(clearAttentionOverride("12345", "no_plates"), true);
  assert.equal(activeAttentionOverrideKeys().has("12345:no_plates"), false);
});
