import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildRequestUri,
  computeV1Signature,
  computeV3Signature,
  findMatchingV3UriProfile,
  verifyCallbackToken,
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

test("callback tokens are checked by SHA-256 without storing the raw token", () => {
  const token = "test-callback-token";
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  assert.equal(verifyCallbackToken(token, hash), true);
  assert.equal(verifyCallbackToken("wrong-token", hash), false);
  assert.equal(verifyCallbackToken(undefined, hash), false);
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

test("v3 URI diagnostic identifies a matching legitimate proxy profile", () => {
  const ts = String(Date.now());
  const directUri = "https://calc.example.com/api/webhooks/hubspot";
  const expected = computeV3Signature(secret, "POST", directUri, rawBody, ts);
  assert.equal(
    findMatchingV3UriProfile({
      clientSecret: secret,
      method: "POST",
      timestamp: ts,
      signature: expected,
      candidates: [
        {
          label: "configured-public-base/raw-body",
          uri: "https://calc.example.com/port/5000/api/webhooks/hubspot",
          body: rawBody,
        },
        { label: "direct-public-path/raw-body", uri: directUri, body: rawBody },
      ],
    }),
    "direct-public-path/raw-body",
  );
  assert.equal(
    findMatchingV3UriProfile({
      clientSecret: secret,
      method: "POST",
      timestamp: ts,
      signature: expected,
      candidates: [
        {
          label: "other/canonical-json",
          uri: "https://other.example.com/api/webhooks/hubspot",
          body: rawBody,
        },
      ],
    }),
    null,
  );
});

test("verification is skipped entirely when no secret is configured", () => {
  const r = verifyWebhookRequest("", { method: "POST", uri, rawBody });
  assert.equal(r.enforced, false);
  assert.equal(r.valid, true);
  assert.match(r.reason, /not configured/);
});

test("a valid v3 signature is accepted when both v3 and v1 are present", () => {
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

test("a valid v1 private-app signature is accepted when v3 does not match", () => {
  const ts = String(Date.now());
  const r = verifyWebhookRequest(secret, {
    method: "POST",
    uri,
    rawBody,
    signatureV1: computeV1Signature(secret, rawBody),
    signatureV3: "not-the-v3-signature",
    timestamp: ts,
  });
  assert.equal(r.version, "v1");
  assert.equal(r.valid, true);
  assert.match(r.reason, /private-app compatibility/);
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
