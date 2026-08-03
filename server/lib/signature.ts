/**
 * HubSpot webhook signature verification.
 *
 * v1 (X-HubSpot-Signature):   SHA-256 hex of `clientSecret + rawBody`.
 * v3 (X-HubSpot-Signature-V3): Base64 HMAC-SHA-256 with the client secret over
 *     `method + decoded request URI + rawBody + timestamp`. The timestamp must be
 *     no older than 5 minutes.
 *
 * Verification is only enforced when a secret is configured.
 */
import crypto from "node:crypto";

export const V3_MAX_AGE_MS = 5 * 60 * 1000;

export function computeV1Signature(clientSecret: string, rawBody: string): string {
  return crypto
    .createHash("sha256")
    .update(clientSecret + rawBody, "utf8")
    .digest("hex");
}

export function computeV3Signature(
  clientSecret: string,
  method: string,
  uri: string,
  rawBody: string,
  timestamp: string | number,
): string {
  const base = `${method.toUpperCase()}${uri}${rawBody}${timestamp}`;
  return crypto.createHmac("sha256", clientSecret).update(base, "utf8").digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface VerificationResult {
  valid: boolean;
  version: "v1" | "v3" | null;
  reason: string;
}

export function verifyV1(params: {
  clientSecret: string;
  rawBody: string;
  signature: string | undefined;
}): VerificationResult {
  const { clientSecret, rawBody, signature } = params;
  if (!signature) {
    return { valid: false, version: "v1", reason: "missing X-HubSpot-Signature" };
  }
  const expected = computeV1Signature(clientSecret, rawBody);
  return safeEqual(expected, signature.trim())
    ? { valid: true, version: "v1", reason: "v1 signature valid" }
    : { valid: false, version: "v1", reason: "v1 signature mismatch" };
}

export function verifyV3(params: {
  clientSecret: string;
  method: string;
  uri: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
  maxAgeMs?: number;
}): VerificationResult {
  const {
    clientSecret,
    method,
    uri,
    rawBody,
    timestamp,
    signature,
    now = Date.now(),
    maxAgeMs = V3_MAX_AGE_MS,
  } = params;

  if (!signature) {
    return { valid: false, version: "v3", reason: "missing X-HubSpot-Signature-V3" };
  }
  if (!timestamp) {
    return { valid: false, version: "v3", reason: "missing X-HubSpot-Request-Timestamp" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, version: "v3", reason: "invalid timestamp" };
  }
  if (now - ts > maxAgeMs) {
    return { valid: false, version: "v3", reason: "timestamp older than 5 minutes" };
  }

  const expected = computeV3Signature(clientSecret, method, uri, rawBody, timestamp);
  return safeEqual(expected, signature.trim())
    ? { valid: true, version: "v3", reason: "v3 signature valid" }
    : { valid: false, version: "v3", reason: "v3 signature mismatch" };
}

export interface RequestFacts {
  method: string;
  /** Fully-qualified, URL-decoded request URI including query string. */
  uri: string;
  rawBody: string;
  signatureV1?: string;
  signatureV3?: string;
  timestamp?: string;
  version?: string;
}

/**
 * Enforce signing only when a secret exists. Prefers v3 when its header is
 * present, otherwise falls back to v1.
 */
export function verifyWebhookRequest(
  clientSecret: string,
  facts: RequestFacts,
  now: number = Date.now(),
): VerificationResult & { enforced: boolean } {
  if (!clientSecret) {
    return {
      enforced: false,
      valid: true,
      version: null,
      reason: "signature verification not configured",
    };
  }
  if (facts.signatureV3) {
    return {
      enforced: true,
      ...verifyV3({
        clientSecret,
        method: facts.method,
        uri: facts.uri,
        rawBody: facts.rawBody,
        timestamp: facts.timestamp,
        signature: facts.signatureV3,
        now,
      }),
    };
  }
  if (facts.signatureV1) {
    return {
      enforced: true,
      ...verifyV1({
        clientSecret,
        rawBody: facts.rawBody,
        signature: facts.signatureV1,
      }),
    };
  }
  return {
    enforced: true,
    valid: false,
    version: null,
    reason: "no HubSpot signature header present",
  };
}

/** Build the decoded absolute URI HubSpot signs for v3. */
export function buildRequestUri(params: {
  forwardedProto?: string;
  protocol: string;
  host?: string;
  originalUrl: string;
  overrideBase?: string;
}): string {
  const base = (params.overrideBase || "").trim().replace(/\/+$/, "");
  if (base) return decodeURIComponent(base + params.originalUrl);
  const proto = (params.forwardedProto || params.protocol || "https").split(",")[0].trim();
  const host = params.host || "localhost";
  return decodeURIComponent(`${proto}://${host}${params.originalUrl}`);
}
