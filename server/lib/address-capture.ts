/**
 * Validate a captured address with ShipEngine, then save split fields only after confirm.
 * Validation status is stored locally. HubSpot receives street, city, state, ZIP, and country.
 */
import { formatShippingStreetLine } from "../../shared/schema";
import {
  addressNeedsUnit,
  formatLabelAddress,
  parsePastedAddress,
  resolveCaptureSubmit,
  type CaptureCheck,
  type CaptureStatus,
} from "../../shared/address-capture";
import { normalizeShipAddress, type ShipAddressFields } from "../../shared/ship-address";
import {
  ensureAddressCheck,
  hashNormalizedAddress,
  saveAddressCheck,
  type StoredAddressCheckStatus,
} from "./address-checks";
import { getConfig, resolveWriteDecision } from "./config";
import { fetchDealAssociatedContact, invalidateDealContactCache } from "./deal-ops";
import { hubspotRequest } from "./hubspot";
import { appendOrderUpdate } from "./order-updates";
import { recordShopAddressEntry } from "./address-ack";
import { SHOP_ADDRESS_FORM_PASTE, buildAddressAckSnapshot } from "../../shared/address-ack";
import { updateOffbook } from "./priority-stack";
import type { ShipEngineMatchedAddress } from "./shipengine";

function asFields(input: Partial<ShipAddressFields>): ShipAddressFields {
  return normalizeShipAddress({
    street1: input.street1,
    street2: input.street2,
    city: input.city,
    state: input.state,
    zip: input.zip,
    country: input.country,
  }).normalized;
}

function suggestionFromMatch(matched: ShipEngineMatchedAddress | null): ShipAddressFields | null {
  if (!matched) return null;
  return asFields({
    street1: matched.street1,
    street2: matched.street2,
    city: matched.city,
    state: matched.state,
    zip: matched.zip,
    country: matched.country || "US",
  });
}

export async function checkCapturedAddress(input: Partial<ShipAddressFields>): Promise<CaptureCheck> {
  const typed = asFields(input);
  const ensured = await ensureAddressCheck({
    contact: {
      id: null,
      name: "Buyer",
      email: "",
      phone: "",
      addressLines: [],
      street1: typed.street1,
      street2: typed.street2,
      city: typed.city,
      state: typed.state,
      zip: typed.zip,
      country: typed.country,
    },
  });
  const suggestion = suggestionFromMatch(ensured.matched);
  const status: CaptureStatus = ensured.status;
  return {
    status,
    needsUnit: addressNeedsUnit({
      street2: typed.street2,
      messages: ensured.messages,
      matchedStreet2: ensured.matched?.street2,
    }),
    typed,
    suggestion: status === "corrected" ? suggestion : null,
    messages: ensured.messages,
  };
}

export function capturePayload(check: CaptureCheck): Record<string, unknown> {
  return {
    ok: true,
    status: check.status,
    needsUnit: check.needsUnit,
    typed: check.typed,
    suggestion: check.suggestion,
    messages: check.messages,
    formattedTyped: formatLabelAddress(check.typed),
    formattedSuggestion: check.suggestion ? formatLabelAddress(check.suggestion) : "",
  };
}

export async function previewPastedAddress(text: string): Promise<CaptureCheck> {
  return checkCapturedAddress(parsePastedAddress(text));
}

function storableStatus(status: CaptureStatus): StoredAddressCheckStatus | null {
  if (status === "verified" || status === "corrected" || status === "unverified" || status === "error") return status;
  return null;
}

export function rememberDealAddressCheck(input: {
  dealId: string;
  fields: ShipAddressFields;
  status: CaptureStatus;
  messages: string[];
  suggestion: ShipAddressFields | null;
}): void {
  const status = storableStatus(input.status);
  if (!status || !input.dealId) return;
  const matched: ShipEngineMatchedAddress | null = input.suggestion
    ? {
        street1: input.suggestion.street1,
        street2: input.suggestion.street2,
        city: input.suggestion.city,
        state: input.suggestion.state,
        zip: input.suggestion.zip,
        country: input.suggestion.country,
      }
    : null;
  saveAddressCheck({
    dealId: input.dealId,
    addressHash: hashNormalizedAddress(input.fields),
    status,
    checkedAt: new Date().toISOString(),
    matched,
    messages: input.messages,
  });
}

function logText(before: ShipAddressFields, after: ShipAddressFields, status: string): string {
  const quote = (fields: ShipAddressFields) =>
    [fields.street1, fields.street2, fields.city, fields.state, fields.zip, fields.country]
      .map((part) => JSON.stringify(part))
      .join(", ");
  return `Ship-to address ${quote(before)} → ${quote(after)}. Validation ${status}.`;
}

export async function applyCapturedAddress(input: {
  confirm?: boolean;
  dealId?: string;
  offbookId?: number;
  fields: Partial<ShipAddressFields>;
  decision?: string;
  noUnit?: boolean;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (input.confirm !== true) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "Confirm the address before saving it." },
    };
  }
  const check = await checkCapturedAddress(input.fields);
  const resolved = resolveCaptureSubmit({ check, decision: input.decision, noUnit: input.noUnit });
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.status,
      body: {
        ...capturePayload(check),
        ok: false,
        code: resolved.code,
        error: resolved.error,
      },
    };
  }

  const dealId = input.dealId?.trim() ?? "";
  const offbookId = input.offbookId;
  if (!dealId && !offbookId) {
    return { ok: false, status: 400, body: { ok: false, error: "Choose an order before saving the address." } };
  }

  if (offbookId) {
    const saved = updateOffbook(offbookId, {
      mode: "ship",
      shipStreet: formatShippingStreetLine(resolved.fields.street1, resolved.fields.street2),
      shipCity: resolved.fields.city,
      shipState: resolved.fields.state,
      shipZip: resolved.fields.zip,
      shipCountry: resolved.fields.country,
    });
    if (!saved) return { ok: false, status: 404, body: { ok: false, error: "That off-book order was not found." } };
    appendOrderUpdate({
      orderKey: `offbook:${offbookId}`,
      text: logText(check.typed, resolved.fields, resolved.storedStatus),
      source: "manual",
      author: "Miguel",
    });
    recordShopAddressEntry({
      orderKey: `offbook:${offbookId}`,
      formSource: SHOP_ADDRESS_FORM_PASTE,
      snapshot: formatLabelAddress(resolved.fields),
      sourceKind: "manual",
    });
    return {
      ok: true,
      body: {
        ok: true,
        wrote: false,
        offbookId,
        fields: resolved.fields,
        status: resolved.storedStatus,
        choice: resolved.choice,
      },
    };
  }

  const contact = await fetchDealAssociatedContact(dealId);
  if (!contact.id) {
    return { ok: false, status: 400, body: { ok: false, error: "No HubSpot contact linked to this deal." } };
  }
  const before = asFields({
    street1: contact.street1,
    street2: contact.street2,
    city: contact.city,
    state: contact.state,
    zip: contact.zip,
    country: contact.country,
  });
  const decision = resolveWriteDecision(getConfig(), true);
  if (decision.write) {
    await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          address: formatShippingStreetLine(resolved.fields.street1, resolved.fields.street2),
          city: resolved.fields.city,
          state: resolved.fields.state,
          zip: resolved.fields.zip,
          country: resolved.fields.country,
        },
      }),
    });
    invalidateDealContactCache(dealId);
  }
  rememberDealAddressCheck({
    dealId,
    fields: resolved.fields,
    status: resolved.storedStatus,
    messages: check.messages,
    suggestion: resolved.choice === "suggested" ? resolved.fields : check.suggestion,
  });
  appendOrderUpdate({
    orderKey: `deal:${dealId}`,
    text: logText(before, resolved.fields, resolved.storedStatus),
    source: "manual",
    author: "Miguel",
  });
  recordShopAddressEntry({
    orderKey: `deal:${dealId}`,
    formSource: SHOP_ADDRESS_FORM_PASTE,
    snapshot: buildAddressAckSnapshot({
      fullName: contact.name,
      email: contact.email,
      phone: contact.phone,
      address: resolved.fields,
    }),
    sourceKind: "manual",
  });
  return {
    ok: true,
    body: {
      ok: true,
      wrote: decision.write,
      reason: decision.reason,
      dealId,
      contactId: contact.id,
      fields: resolved.fields,
      status: resolved.storedStatus,
      choice: resolved.choice,
    },
  };
}
