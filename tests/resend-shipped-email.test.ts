import test from "node:test";
import assert from "node:assert/strict";
import {
  clearShippedEmailSent,
  recordShippedEmailSent,
  resetShippedEmailStore,
  wasShippedEmailSent,
} from "../server/lib/shipped-email-store";
import { resendConfigured, sendShippedEmailViaResend } from "../server/lib/resend-shipped-email";

test("shipped email store is idempotent per deal+tracking", () => {
  process.env.SHIPPED_EMAIL_DB_FILE = ":memory:";
  resetShippedEmailStore();
  clearShippedEmailSent();
  assert.equal(wasShippedEmailSent("101", "1ZAAA"), false);
  recordShippedEmailSent({
    dealId: "101",
    trackingNumber: "1ZAAA",
    email: "buyer@example.com",
    resendId: "re_test",
  });
  assert.equal(wasShippedEmailSent("101", "1ZAAA"), true);
  assert.equal(wasShippedEmailSent("101", "1zaaa"), true);
  assert.equal(wasShippedEmailSent("102", "1ZAAA"), false);
  resetShippedEmailStore();
});

test("Resend send skips when not configured", async () => {
  const prevKey = process.env.RESEND_API_KEY;
  const prevFrom = process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  assert.equal(resendConfigured(), false);
  const result = await sendShippedEmailViaResend({
    to: "buyer@example.com",
    trackingNumber: "1ZTEST",
    contactName: "Ada",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skipped, true);
  }
  if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
  else delete process.env.RESEND_API_KEY;
  if (prevFrom !== undefined) process.env.RESEND_FROM_EMAIL = prevFrom;
  else delete process.env.RESEND_FROM_EMAIL;
});

test("Resend send skips when contact has no email", async () => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "Print Ops <onboarding@resend.dev>";
  const result = await sendShippedEmailViaResend({
    to: "",
    trackingNumber: "1ZTEST",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skipped, true);
  }
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
});
