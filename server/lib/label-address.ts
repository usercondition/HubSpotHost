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
  addressBelongsOnAudit,
  ensureAddressCheck,
  type AddressCheckStatus,
} from "./address-checks";
import {
  getShipEngineApiKey,
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

function asAddressCheck(ensured: {
  status: AddressCheckStatus;
  matched: ShipEngineMatchedAddress | null;
  messages: string[];
}): ShipEngineAddressCheck {
  const differs = ensured.status === "corrected";
  const status =
    ensured.status === "corrected" || ensured.status === "verified"
      ? "verified"
      : ensured.status === "error"
        ? "error"
        : "unverified";
  return { status, matched: ensured.matched, messages: ensured.messages, differs };
}

/**
 * Normalize, then require a fresh verified ShipEngine check before quoting or buying.
 * A stored check is reused until it is stale or the address hash changes.
 * A mismatch blocks until the caller accepts the suggestion or overrides it.
 */
export async function gateLabelAddress(
  contact: DealAssociatedContact,
  decision?: AddressDecision,
  dealId?: string,
): Promise<
  | {
      ok: true;
      address: ShipEngineAddress;
      normalized: NormalizedShipAddress;
      validation: ShipEngineAddressCheck;
    }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const ensured = await ensureAddressCheck({
    dealId,
    contact,
    refreshIfStale: true,
  });
  if (!ensured.address) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: MISSING_ADDRESS,
        original: ensured.normalized.original,
        normalized: ensured.normalized.normalized,
        contact: { name: contact.name, addressLines: contact.addressLines },
      },
    };
  }
  if (ensured.status === "unchecked") {
    return {
      ok: false,
      status: 503,
      body: {
        ok: false,
        code: "address_unchecked",
        error: getShipEngineApiKey()
          ? "ShipEngine could not check this address. Nothing was bought."
          : "Add SHIPENGINE_API_KEY on Railway (ShipStation API → API Keys).",
      },
    };
  }
  const validation = asAddressCheck(ensured);
  if (ensured.status === "verified") {
    return { ok: true, address: ensured.address, normalized: ensured.normalized, validation };
  }
  if (decision === "override") {
    return { ok: true, address: ensured.address, normalized: ensured.normalized, validation };
  }
  if (decision === "accept" && ensured.matched) {
    return {
      ok: true,
      address: addressFromMatch(ensured.address, ensured.matched),
      normalized: ensured.normalized,
      validation,
    };
  }
  return { ok: false, status: 409, body: confirmationBody(ensured.normalized, validation) };
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
  validationStatus: AddressCheckStatus;
  checkedAt: string | null;
  messages: string[];
  changes: ShipAddressChange[];
  original: ShipAddressFields;
  normalized: ShipAddressFields;
  suggestion: ShipEngineMatchedAddress | null;
};

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

/** Open orders that need cleanup, or whose stored check is unverified, corrected, or error. */
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

  const rows = await mapPool(Array.from(items.values()), 2, async (item) => {
    const contact = peekDealContactCache(item.dealId) ?? (await fetchDealAssociatedContact(item.dealId).catch(() => null));
    if (!contact) return null;
    const ensured = await ensureAddressCheck({ dealId: item.dealId, contact });
    if (!addressBelongsOnAudit({ needsCleanup: ensured.normalized.changed, status: ensured.status })) return null;
    return {
      dealId: item.dealId,
      dealName: item.dealName,
      contactName: item.contactName,
      needsCleanup: ensured.normalized.changed,
      validationStatus: ensured.status,
      checkedAt: ensured.checkedAt,
      messages: ensured.messages,
      changes: ensured.normalized.changes,
      original: ensured.normalized.original,
      normalized: ensured.normalized.normalized,
      suggestion: ensured.matched,
    } satisfies AddressAuditRow;
  });

  return rows.filter((row): row is AddressAuditRow => Boolean(row));
}

/** Verify now: always ask ShipEngine, even when the stored hash still matches. */
export async function verifyAddressNow(dealId: string): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const contact = await fetchDealAssociatedContact(dealId);
  const ensured = await ensureAddressCheck({ dealId, contact, force: true });
  if (!ensured.address) {
    return { ok: false, status: 400, body: { ok: false, error: MISSING_ADDRESS } };
  }
  return {
    ok: true,
    body: {
      ok: true,
      dealId,
      status: ensured.status,
      checkedAt: ensured.checkedAt,
      addressHash: ensured.addressHash,
      suggestion: ensured.matched,
      messages: ensured.messages,
      normalized: ensured.normalized.normalized,
    },
  };
}
