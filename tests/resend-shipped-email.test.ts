import test from "node:test";
import assert from "node:assert/strict";
import {
  clearShippedEmailSent,
  recordShippedEmailSent,
  resetShippedEmailStore,
  wasShippedEmailSent,
} from "../server/lib/shipped-email-store";
import { emailSendMode, resendConfigured, sendShippedEmailViaResend } from "../server/lib/resend-shipped-email";
import { buyerEmailToastHint } from "../shared/shipping-email-template";

test("buyer shipment email mode defaults off and only live enables sending", () => {
  assert.equal(emailSendMode({}), "off");
  assert.equal(emailSendMode({ EMAIL_SEND_MODE: "off" }), "off");
  assert.equal(emailSendMode({ EMAIL_SEND_MODE: "draft" }), "draft");
  assert.equal(emailSendMode({ EMAIL_SEND_MODE: "live" }), "live");
  assert.equal(emailSendMode({ EMAIL_SEND_MODE: "unexpected" }), "off");
});

test("draft mode skips Resend even when credentials are configured", async () => {
  const previous = {
    mode: process.env.EMAIL_SEND_MODE,
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
    fetch: globalThis.fetch,
  };
  process.env.EMAIL_SEND_MODE = "draft";
  process.env.RESEND_API_KEY = "re_test";
  process.env.RESEND_FROM_EMAIL = "Print Ops <shipping@example.com>";
  globalThis.fetch = (async () => {
    throw new Error("Resend must not be called in draft mode");
  }) as typeof fetch;

  const result = await sendShippedEmailViaResend({
    to: "buyer@example.com",
    trackingNumber: "1ZTEST",
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "Buyer shipment emails are off (EMAIL_SEND_MODE=draft)",
  });

  process.env.EMAIL_SEND_MODE = previous.mode;
  process.env.RESEND_API_KEY = previous.key;
  process.env.RESEND_FROM_EMAIL = previous.from;
  globalThis.fetch = previous.fetch;
});

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

test("buy toast names a failed or queued shipped email without sending", () => {
  assert.equal(buyerEmailToastHint(null), "");
  assert.equal(
    buyerEmailToastHint({ sent: true, to: "buyer@example.com" }),
    " · emailed buyer@example.com",
  );
  assert.match(buyerEmailToastHint({ error: "domain not verified" }), /email failed: domain not verified/);
  assert.equal(
    buyerEmailToastHint({ skipped: true, reason: "Resend not configured" }),
    " · email skipped (Resend not configured)",
  );
  assert.equal(buyerEmailToastHint({ reason: "Shipped email queued" }), " · Shipped email queued");
});
