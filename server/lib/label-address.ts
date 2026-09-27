/**
 * Label address gate: normalize on read, validate before rates or purchase,
 * and write HubSpot only after an explicit cleanup confirm.
 */
import { formatShippingStreetLine } from "../../shared/schema";
import {
  normalizeShipAddress,
  type NormalizedShipAddress,
  type ShipAddressChange,
  type ShipAddressFields,
} from "../../shared/ship-address";
import { getConfig, resolveWriteDecision } from "./config";
import {
  fetchDealAssociatedContact,
  invalidateDealContactCache,
  peekDealContactCache,
  type DealAssociatedContact,
} from "./deal-ops";
import { hubspotRequest } from "./hubspot";
import { appendOrderUpdate } from "./order-updates";
import { loadProductionQueue } from "./queue-loader";
import {
  contactToShipEngineAddress,
  getShipEngineApiKey,
  validateShipEngineAddress,
  type ShipEngineAddress,
  type ShipEngineAddressCheck,
  type ShipEngineMatchedAddress,
} from "./shipengine";

export type AddressDecision = "accept" | "override";

const MISSING_ADDRESS =
  "HubSpot contact is missing a full ship-to address (name, street, city, state, zip).";

function confirmationBody(
  normalized: NormalizedShipAddress,
  validation: ShipEngineAddressCheck,
): Record<string, unknown> {
  return {
    ok: false,
    code: "address_confirmation",
    error: "Confirm this address before buying a label.",
    original: normalized.original,
    normalized: normalized.normalized,
    suggestion: validation.matched,
    messages: validation.messages,
  };
}

function addressFromMatch(
  base: ShipEngineAddress,
  matched: ShipEngineMatchedAddress,
): ShipEngineAddress {
  const cleaned = normalizeShipAddress({
    street1: matched.street1,
    street2: matched.street2,
    city: matched.city,
    state: matched.state,
    zip: matched.zip,
    country: matched.country || base.country,
  }).normalized;
  return {
    ...base,
    street1: cleaned.street1 || matched.street1,
    street2: cleaned.street2 || undefined,
    city: cleaned.city || matched.city,
    state: cleaned.state || matched.state,
    zip: cleaned.zip || matched.zip,
    country: cleaned.country || base.country,
  };
}

/**
 * Normalize, then require a verified ShipEngine match before quoting or buying.
 * A mismatch blocks until the caller accepts the suggestion or overrides it.
 */
export async function gateLabelAddress(
  contact: DealAssociatedContact,
  decision?: AddressDecision,
): Promise<
  | {
      ok: true;
      address: ShipEngineAddress;
      normalized: NormalizedShipAddress;
      validation: ShipEngineAddressCheck;
    }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const normalized = normalizeShipAddress({
    street1: contact.street1,
    street2: contact.street2,
    city: contact.city,
    state: contact.state,
    zip: contact.zip,
    country: contact.country,
  });
  const address = contactToShipEngineAddress(contact);
  if (!address) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: MISSING_ADDRESS,
        original: normalized.original,
        normalized: normalized.normalized,
        contact: { name: contact.name, addressLines: contact.addressLines },
      },
    };
  }
  if (!getShipEngineApiKey()) {
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        error: "Add SHIPENGINE_API_KEY on Railway (ShipStation API → API Keys).",
      },
    };
  }
  const validation = await validateShipEngineAddress(address);
  const clean = validation.status === "verified" && !validation.differs;
  if (clean) {
    return { ok: true, address, normalized, validation };
  }
  if (decision === "override") {
    return { ok: true, address, normalized, validation };
  }
  if (decision === "accept" && validation.matched) {
    return {
      ok: true,
      address: addressFromMatch(address, validation.matched),
      normalized,
      validation,
    };
  }
  return { ok: false, status: 409, body: confirmationBody(normalized, validation) };
}

function cleanupLogText(result: NormalizedShipAddress): string {
  const fields: Array<keyof ShipAddressFields> = ["street1", "street2", "city", "state", "zip", "country"];
  const lines = ["Address cleanup confirmed."];
  for (const field of fields) {
    lines.push(`${field}: ${JSON.stringify(result.original[field])} → ${JSON.stringify(result.normalized[field])}`);
  }
  return lines.join("\n");
}

/** Write cleaned contact fields only when confirm is literally true. */
export async function applyAddressCleanup(input: {
  dealId: string;
  confirm?: boolean;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (input.confirm !== true) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "Confirm the address cleanup first." },
    };
  }
  const contact = await fetchDealAssociatedContact(input.dealId);
  if (!contact.id) {
    return { ok: false, status: 400, body: { ok: false, error: "No HubSpot contact linked to this deal." } };
  }
  const normalized = normalizeShipAddress({
    street1: contact.street1,
    street2: contact.street2,
    city: contact.city,
    state: contact.state,
    zip: contact.zip,
    country: contact.country,
  });
  if (!normalized.changed) {
    return { ok: false, status: 400, body: { ok: false, error: "Address is already clean." } };
  }

  const decision = resolveWriteDecision(getConfig(), true);
  if (decision.write) {
    await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          address: formatShippingStreetLine(normalized.normalized.street1, normalized.normalized.street2),
          city: normalized.normalized.city,
          state: normalized.normalized.state,
          zip: normalized.normalized.zip,
          country: normalized.normalized.country,
        },
      }),
    });
    invalidateDealContactCache(input.dealId);
  }

  appendOrderUpdate({
    orderKey: `deal:${input.dealId}`,
    text: cleanupLogText(normalized),
    source: "system",
    author: "Miguel",
  });

  return {
    ok: true,
    body: {
      ok: true,
      wrote: decision.write,
      reason: decision.reason,
      dealId: input.dealId,
      contactId: contact.id,
      original: normalized.original,
      normalized: normalized.normalized,
      changes: normalized.changes,
    },
  };
}

export type AddressAuditRow = {
  dealId: string;
  dealName: string;
  contactName: string | null;
  needsCleanup: boolean;
  validationStatus: ShipEngineAddressCheck["status"] | "unchecked";
  messages: string[];
  changes: ShipAddressChange[];
  original: ShipAddressFields;
  normalized: ShipAddressFields;
};

const VALIDATION_CACHE_MS = 120_000;
const validationCache = new Map<string, { at: number; result: ShipEngineAddressCheck }>();

function validationCacheKey(address: ShipEngineAddress): string {
  return [address.street1, address.city, address.state, address.zip, address.country].join("|").toLowerCase();
}

async function cachedValidation(address: ShipEngineAddress): Promise<ShipEngineAddressCheck> {
  const key = validationCacheKey(address);
  const hit = validationCache.get(key);
  if (hit && Date.now() - hit.at < VALIDATION_CACHE_MS) return hit.result;
  const result = await validateShipEngineAddress(address);
  validationCache.set(key, { at: Date.now(), result });
  return result;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Open orders whose address needs cleanup or failed ShipEngine validation. */
export async function listAddressAudit(): Promise<AddressAuditRow[]> {
  const queue = await loadProductionQueue({ enrichAddresses: true });
  const items = new Map<string, { dealId: string; dealName: string; contactName: string | null }>();
  for (const item of [
    ...queue.nextPrint,
    ...queue.inProduction,
    ...queue.shipReady,
    ...queue.readyToPack,
    ...queue.blocked,
    ...queue.needsReply,
  ]) {
    if (item.shippingRequired === false || item.addressStatus === "pickup") continue;
    items.set(item.dealId, { dealId: item.dealId, dealName: item.dealName, contactName: item.contactName });
  }

  const canValidate = Boolean(getShipEngineApiKey());
  const rows = await mapPool(Array.from(items.values()), 2, async (item) => {
    const contact = peekDealContactCache(item.dealId) ?? (await fetchDealAssociatedContact(item.dealId).catch(() => null));
    if (!contact) return null;
    const normalized = normalizeShipAddress({
      street1: contact.street1,
      street2: contact.street2,
      city: contact.city,
      state: contact.state,
      zip: contact.zip,
      country: contact.country,
    });
    const address = contactToShipEngineAddress(contact);
    let validationStatus: AddressAuditRow["validationStatus"] = "unchecked";
    let messages: string[] = [];
    let validationFailed = false;
    if (address && canValidate) {
      try {
        const validation = await cachedValidation(address);
        validationStatus = validation.status;
        messages = validation.messages;
        validationFailed = validation.status !== "verified" || validation.differs;
      } catch (error) {
        validationStatus = "error";
        messages = [error instanceof Error ? error.message : "Address validation failed"];
        validationFailed = true;
      }
    }
    if (!normalized.changed && !validationFailed) return null;
    return {
      dealId: item.dealId,
      dealName: item.dealName,
      contactName: item.contactName,
      needsCleanup: normalized.changed,
      validationStatus,
      messages,
      changes: normalized.changes,
      original: normalized.original,
      normalized: normalized.normalized,
    } satisfies AddressAuditRow;
  });

  return rows.filter((row): row is AddressAuditRow => Boolean(row));
}
