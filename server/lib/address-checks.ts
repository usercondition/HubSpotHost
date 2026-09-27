/**
 * Stored ShipEngine address checks, one row per deal.
 * A matching address hash is reused. ShipEngine is called only when the
 * address changes, the check is stale before a label quote, or the user asks.
 * An outage is unchecked and is not saved as a failed address.
 */
import crypto from "node:crypto";
import {
  normalizeShipAddress,
  type NormalizedShipAddress,
  type ShipAddressFields,
} from "../../shared/ship-address";
import { type DealAssociatedContact } from "./deal-ops";
import { getSqlite } from "./order-links";
import {
  contactToShipEngineAddress,
  getShipEngineApiKey,
  validateShipEngineAddress,
  type ShipEngineAddress,
  type ShipEngineAddressCheck,
  type ShipEngineMatchedAddress,
} from "./shipengine";

/** Stored outcomes. "unchecked" is only a live response for an outage or a missing check. */
export type StoredAddressCheckStatus = "verified" | "corrected" | "unverified" | "error";
export type AddressCheckStatus = StoredAddressCheckStatus | "unchecked";

export type StoredAddressCheck = {
  dealId: string;
  addressHash: string;
  status: StoredAddressCheckStatus;
  checkedAt: string;
  matched: ShipEngineMatchedAddress | null;
  messages: string[];
};

/** Quotes and purchases recheck once this age is passed. Page loads do not. */
export const ADDRESS_CHECK_STALE_MS = 24 * 60 * 60 * 1000;
const OUTAGE_BACKOFF_MS = 120_000;

let outageUntil = 0;

function ensureTable(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS address_validations (
      deal_id TEXT PRIMARY KEY,
      address_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      matched_json TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT ''
    );
  `);
}

/** Test helper: the next validation may call ShipEngine again after a simulated outage. */
export function resetAddressCheckOutage(): void {
  outageUntil = 0;
}

export function labelAddressOutageActive(now = Date.now()): boolean {
  return now < outageUntil;
}

export function hashNormalizedAddress(fields: ShipAddressFields): string {
  const payload = [fields.street1, fields.street2, fields.city, fields.state, fields.zip, fields.country]
    .map((part) => part.trim().toLowerCase())
    .join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function classifyStoredStatus(check: ShipEngineAddressCheck): StoredAddressCheckStatus {
  if (check.status === "error") return "error";
  if (check.differs && check.matched) return "corrected";
  if ((check.status === "verified" || check.status === "warning") && !check.differs) return "verified";
  return "unverified";
}

export function isAddressCheckStale(checkedAt: string, now = Date.now()): boolean {
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > ADDRESS_CHECK_STALE_MS;
}

export function readAddressCheck(dealId: string): StoredAddressCheck | null {
  try {
    ensureTable();
    const row = getSqlite()
      .prepare(
        `SELECT deal_id, address_hash, status, checked_at, matched_json, messages_json
         FROM address_validations WHERE deal_id = ?`,
      )
      .get(dealId) as
      | {
          deal_id: string;
          address_hash: string;
          status: string;
          checked_at: string;
          matched_json: string;
          messages_json: string;
        }
      | undefined;
    if (!row) return null;
    if (row.status !== "verified" && row.status !== "corrected" && row.status !== "unverified" && row.status !== "error") {
      return null;
    }
    let matched: ShipEngineMatchedAddress | null = null;
    let messages: string[] = [];
    try {
      matched = row.matched_json ? (JSON.parse(row.matched_json) as ShipEngineMatchedAddress) : null;
    } catch {
      matched = null;
    }
    try {
      const parsed = row.messages_json ? JSON.parse(row.messages_json) : [];
      messages = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      messages = [];
    }
    return {
      dealId: row.deal_id,
      addressHash: row.address_hash,
      status: row.status,
      checkedAt: row.checked_at,
      matched,
      messages,
    };
  } catch {
    return null;
  }
}

export function saveAddressCheck(check: StoredAddressCheck): void {
  ensureTable();
  getSqlite()
    .prepare(
      `INSERT INTO address_validations (deal_id, address_hash, status, checked_at, matched_json, messages_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(deal_id) DO UPDATE SET
         address_hash = excluded.address_hash,
         status = excluded.status,
         checked_at = excluded.checked_at,
         matched_json = excluded.matched_json,
         messages_json = excluded.messages_json`,
    )
    .run(
      check.dealId,
      check.addressHash,
      check.status,
      check.checkedAt,
      check.matched ? JSON.stringify(check.matched) : "",
      JSON.stringify(check.messages),
    );
  if (check.status === "verified") rememberVerifiedAddress(check.dealId);
}

/** Local checklist only. A verified ShipEngine check never writes HubSpot. */
function rememberVerifiedAddress(dealId: string): void {
  if (!/^[0-9]{1,20}$/.test(dealId)) return;
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO fulfillment_checklists (
         hubspot_deal_id, address_verified, costs_entered, label_bought, tracking_pasted, packing_done,
         tracking_number, notes, shipengine_label_id, shipengine_carrier, shipengine_service, updated_at, created_at
       ) VALUES (?, 1, 0, 0, 0, 0, '', '', '', '', '', ?, ?)
       ON CONFLICT(hubspot_deal_id) DO UPDATE SET
         address_verified = 1,
         updated_at = excluded.updated_at`,
    )
    .run(dealId, now, now);
}

export type EnsuredAddressCheck = {
  status: AddressCheckStatus;
  checkedAt: string | null;
  addressHash: string;
  matched: ShipEngineMatchedAddress | null;
  messages: string[];
  normalized: NormalizedShipAddress;
  address: ShipEngineAddress | null;
  /** True when this call used a stored row and did not ask ShipEngine. */
  fromStore: boolean;
};

function fromStored(stored: StoredAddressCheck, normalized: NormalizedShipAddress, address: ShipEngineAddress | null): EnsuredAddressCheck {
  return {
    status: stored.status,
    checkedAt: stored.checkedAt,
    addressHash: stored.addressHash,
    matched: stored.matched,
    messages: stored.messages,
    normalized,
    address,
    fromStore: true,
  };
}

/**
 * Return the stored check when the normalized address is unchanged.
 * `refreshIfStale` is for rates and purchase. `force` is Verify now.
 */
export async function ensureAddressCheck(input: {
  dealId?: string;
  contact: DealAssociatedContact;
  force?: boolean;
  refreshIfStale?: boolean;
}): Promise<EnsuredAddressCheck> {
  const normalized = normalizeShipAddress({
    street1: input.contact.street1,
    street2: input.contact.street2,
    city: input.contact.city,
    state: input.contact.state,
    zip: input.contact.zip,
    country: input.contact.country,
  });
  const addressHash = hashNormalizedAddress(normalized.normalized);
  const address = contactToShipEngineAddress(input.contact);
  const blank: EnsuredAddressCheck = {
    status: "unchecked",
    checkedAt: null,
    addressHash,
    matched: null,
    messages: [],
    normalized,
    address,
    fromStore: false,
  };
  if (!address) return blank;

  const dealId = input.dealId;
  const stored = dealId ? readAddressCheck(dealId) : null;
  const hashMatches = Boolean(stored && stored.addressHash === addressHash);
  const stale = !stored || isAddressCheckStale(stored.checkedAt);
  // No deal id means a one-off gate: always ask ShipEngine and do not persist.
  const shouldCall = !dealId || Boolean(input.force) || !hashMatches || (Boolean(input.refreshIfStale) && stale);

  if (!shouldCall && stored && hashMatches) {
    return fromStored(stored, normalized, address);
  }
  if (!getShipEngineApiKey() || Date.now() < outageUntil) {
    return blank;
  }

  try {
    const validation = await validateShipEngineAddress(address);
    const status = classifyStoredStatus(validation);
    const checkedAt = new Date().toISOString();
    if (dealId) {
      saveAddressCheck({
        dealId,
        addressHash,
        status,
        checkedAt,
        matched: validation.matched,
        messages: validation.messages,
      });
    }
    return {
      status,
      checkedAt,
      addressHash,
      matched: validation.matched,
      messages: validation.messages,
      normalized,
      address,
      fromStore: false,
    };
  } catch {
    outageUntil = Date.now() + OUTAGE_BACKOFF_MS;
    return blank;
  }
}

/** Customer checks must not open the breaker that blocks label purchases. */
export const PUBLIC_ADDRESS_CACHE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_OUTAGE_BACKOFF_MS = 120_000;
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_LIMIT = 12;

let publicOutageUntil = 0;
const publicAddressCache = new Map<string, { at: number; value: EnsuredAddressCheck }>();
const publicRates = new Map<string, { count: number; resetAt: number }>();

export class PublicAddressRateLimitError extends Error {
  constructor() {
    super("Too many address checks. Try again in a minute.");
    this.name = "PublicAddressRateLimitError";
  }
}

export function resetPublicAddressValidation(): void {
  publicOutageUntil = 0;
  publicAddressCache.clear();
  publicRates.clear();
}

export function publicAddressOutageActive(now = Date.now()): boolean {
  return now < publicOutageUntil;
}

function publicValidationLimited(rateKey: string, now = Date.now()): boolean {
  const key = rateKey.trim() || "public";
  const entry = publicRates.get(key);
  if (!entry || entry.resetAt <= now) {
    publicRates.set(key, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > PUBLIC_RATE_LIMIT;
}

/**
 * Validate one normalized address for the public form.
 * Results are cached briefly. An outage sets only the public breaker.
 */
export async function validatePublicAddress(input: {
  contact: DealAssociatedContact;
  rateKey?: string;
}): Promise<EnsuredAddressCheck> {
  const normalized = normalizeShipAddress({
    street1: input.contact.street1,
    street2: input.contact.street2,
    city: input.contact.city,
    state: input.contact.state,
    zip: input.contact.zip,
    country: input.contact.country,
  });
  const addressHash = hashNormalizedAddress(normalized.normalized);
  const address = contactToShipEngineAddress(input.contact);
  const blank: EnsuredAddressCheck = {
    status: "unchecked",
    checkedAt: null,
    addressHash,
    matched: null,
    messages: [],
    normalized,
    address,
    fromStore: false,
  };
  if (!address) return blank;

  const cached = publicAddressCache.get(addressHash);
  if (cached && Date.now() - cached.at < PUBLIC_ADDRESS_CACHE_TTL_MS) {
    return { ...cached.value, fromStore: true };
  }
  if (publicValidationLimited(input.rateKey || "public")) {
    throw new PublicAddressRateLimitError();
  }
  if (!getShipEngineApiKey() || Date.now() < publicOutageUntil) return blank;

  try {
    const validation = await validateShipEngineAddress(address);
    const status = classifyStoredStatus(validation);
    const checkedAt = new Date().toISOString();
    const result: EnsuredAddressCheck = {
      status,
      checkedAt,
      addressHash,
      matched: validation.matched,
      messages: validation.messages,
      normalized,
      address,
      fromStore: false,
    };
    publicAddressCache.set(addressHash, { at: Date.now(), value: result });
    return result;
  } catch {
    publicOutageUntil = Date.now() + PUBLIC_OUTAGE_BACKOFF_MS;
    return blank;
  }
}
