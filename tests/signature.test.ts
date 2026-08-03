import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildRequestUri,
  computeV1Signature,
  computeV3Signature,
  verifyV1,
  verifyV3,
  verifyWebhookRequest,
} from "../server/lib/signature";

const secret = "client-secret-example";
const rawBody = JSON.stringify([
  { objectId: 101, propertyName: "amount", objectTypeId: "0-3" },
]);
const uri = "https://calc.example.com/api/webhooks/hubspot";

test("v1 signature is SHA-256 of secret + raw body", () => {
  const expected = crypto
    .createHash("sha256")
    .update(secret + rawBody, "utf8")
    .digest("hex");
  assert.equal(computeV1Signature(secret, rawBody), expected);
  assert.equal(verifyV1({ clientSecret: secret, rawBody, signature: expected }).valid, true);
});

test("v1 rejects a tampered body or missing header", () => {
  const sig = computeV1Signature(secret, rawBody);
  assert.equal(
    verifyV1({ clientSecret: secret, rawBody: rawBody + " ", signature: sig }).valid,
    false,
  );
  assert.equal(verifyV1({ clientSecret: secret, rawBody, signature: undefined }).valid, false);
});

test("v3 signature is base64 HMAC over method + uri + body + timestamp", () => {
  const ts = String(Date.now());
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`POST${uri}${rawBody}${ts}`, "utf8")
    .digest("base64");
  assert.equal(computeV3Signature(secret, "post", uri, rawBody, ts), expected);
  assert.equal(
    verifyV3({
      clientSecret: secret,
      method: "POST",
      uri,
      rawBody,
      timestamp: ts,
      signature: expected,
    }).valid,
    true,
  );
});

test("v3 rejects timestamps older than five minutes", () => {
  const now = Date.now();
  const stale = String(now - 6 * 60 * 1000);
  const sig = computeV3Signature(secret, "POST", uri, rawBody, stale);
  const result = verifyV3({
    clientSecret: secret,
    method: "POST",
    uri,
    rawBody,
    timestamp: stale,
    signature: sig,
    now,
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /5 minutes/);
});

test("v3 accepts a timestamp just inside the window and rejects bad signatures", () => {
  const now = Date.now();
  const fresh = String(now - 4 * 60 * 1000);
  const sig = computeV3Signature(secret, "POST", uri, rawBody, fresh);
  assert.equal(
    verifyV3({ clientSecret: secret, method: "POST", uri, rawBody, timestamp: fresh, signature: sig, now }).valid,
    true,
  );
  assert.equal(
    verifyV3({
      clientSecret: secret,
      method: "POST",
      uri,
      rawBody,
      timestamp: fresh,
      signature: "bogus",
      now,
    }).valid,
    false,
  );
  assert.equal(
    verifyV3({ clientSecret: secret, method: "POST", uri, rawBody, timestamp: undefined, signature: sig }).valid,
    false,
  );
});

test("verification is skipped entirely when no secret is configured", () => {
  const r = verifyWebhookRequest("", { method: "POST", uri, rawBody });
  assert.equal(r.enforced, false);
  assert.equal(r.valid, true);
  assert.match(r.reason, /not configured/);
});

test("v3 header takes precedence over v1 when both are present", () => {
  const ts = String(Date.now());
  const v3 = computeV3Signature(secret, "POST", uri, rawBody, ts);
  const r = verifyWebhookRequest(secret, {
    method: "POST",
    uri,
    rawBody,
    signatureV1: "wrong",
    signatureV3: v3,
    timestamp: ts,
  });
  assert.equal(r.version, "v3");
  assert.equal(r.valid, true);
});

test("v1 header is used when only v1 is present", () => {
  const r = verifyWebhookRequest(secret, {
    method: "POST",
    uri,
    rawBody,
    signatureV1: computeV1Signature(secret, rawBody),
  });
  assert.equal(r.version, "v1");
  assert.equal(r.valid, true);
});

test("a configured secret with no signature header is rejected", () => {
  const r = verifyWebhookRequest(secret, { method: "POST", uri, rawBody });
  assert.equal(r.enforced, true);
  assert.equal(r.valid, false);
});

test("request uri is decoded and built from forwarded headers", () => {
  assert.equal(
    buildRequestUri({
      forwardedProto: "https",
      protocol: "http",
      host: "calc.example.com",
      originalUrl: "/api/webhooks/hubspot?dryRun=true",
    }),
    "https://calc.example.com/api/webhooks/hubspot?dryRun=true",
  );
  assert.equal(
    buildRequestUri({
      protocol: "http",
      host: "ignored",
      originalUrl: "/api/webhooks/hubspot",
      overrideBase: "https://public.example.com/",
    }),
    "https://public.example.com/api/webhooks/hubspot",
  );
  assert.equal(
    buildRequestUri({
      protocol: "https",
      host: "calc.example.com",
      originalUrl: "/api/webhooks/hubspot?q=a%20b",
    }),
    "https://calc.example.com/api/webhooks/hubspot?q=a b",
  );
});
