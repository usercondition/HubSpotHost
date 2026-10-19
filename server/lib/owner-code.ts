/**
 * One place that verifies the Print Ops owner code (header x-paid-order-access-code).
 *
 * Two ways to match, both timing-safe and both against hashes only (Railway never stores
 * the plaintext):
 *  1. Exact: sha256(code as sent) === PAID_ORDER_INTAKE_ACCESS_CODE_HASH. Unchanged from
 *     before, so scripts, the Messenger extension and agents keep working.
 *  2. Forgiving (optional): sha256(normalizeOwnerCode(code)) === PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH.
 *     Absorbs phone typing and iPhone Live Text mistakes (case, O/0, I/1/L, odd dashes,
 *     spaces, zero-width chars, smart quotes). When that env var is unset, only (1) applies.
 */
import crypto from "node:crypto";
import { normalizeOwnerCode } from "../../shared/owner-code";

type Env = NodeJS.ProcessEnv;

export type OwnerCodeStatus = "authorized" | "not-configured" | "missing" | "mismatch";

export { normalizeOwnerCode };

export function hashAccessCode(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests (hashing first so lengths always match). */
export function timingSafeHashMatch(actualHex: string, expectedHex: string): boolean {
  const a = crypto.createHash("sha256").update(actualHex.toLowerCase(), "utf8").digest();
  const b = crypto.createHash("sha256").update(expectedHex.toLowerCase(), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** Trim, drop "Bearer ", and drop one pair of matching surrounding quotes. */
export function cleanProvidedOwnerCode(value: string): string {
  const withoutBearer = String(value ?? "").trim().replace(/^Bearer\s+/i, "");
  const quoted =
    withoutBearer.length >= 2 &&
    ((withoutBearer.startsWith('"') && withoutBearer.endsWith('"')) ||
      (withoutBearer.startsWith("'") && withoutBearer.endsWith("'")));
  return quoted ? withoutBearer.slice(1, -1).trim() : withoutBearer;
}

export function ownerCodeHashes(env: Env = process.env): { exact: string; normalized: string } {
  return {
    exact: env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim().toLowerCase() || "",
    normalized: env.PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH?.trim().toLowerCase() || "",
  };
}

/** The single owner-code check. `provided` is the raw header/body value. */
export function verifyOwnerCode(provided: string, env: Env = process.env): OwnerCodeStatus {
  const { exact, normalized } = ownerCodeHashes(env);
  if (!exact) return "not-configured";
  const code = cleanProvidedOwnerCode(provided);
  if (!code) return "missing";
  // Evaluate both paths every time so timing doesn't reveal which one matched.
  const exactOk = timingSafeHashMatch(hashAccessCode(code), exact);
  const normCode = normalizeOwnerCode(code);
  const normOk = normalized ? normCode.length > 0 && timingSafeHashMatch(hashAccessCode(normCode), normalized) : false;
  return exactOk || normOk ? "authorized" : "mismatch";
}

export const OWNER_CODE_ERRORS: Record<Exclude<OwnerCodeStatus, "authorized">, string> = {
  "not-configured": "Paid Order Intake access code is not configured",
  missing: "No intake access code reached the live service",
  mismatch: "The intake access code does not match the active code",
};
