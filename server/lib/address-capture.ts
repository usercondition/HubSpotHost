/**
 * Validate a captured address with ShipEngine, then save split fields only after confirm.
 * Validation status is stored locally. HubSpot receives street, city, state, ZIP, and country.
 */
import { formatShippingStreetLine } from "../../shared/schema";
import {
  HUBSPOT_WRITES_OFF_MESSAGE,
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
  validatePublicAddress,
  type StoredAddressCheckStatus,
} from "./address-checks";
import { getConfig, resolveWriteDecision } from "./config";
import { fetchDealAssociatedContact, invalidateDealContactCache, type DealAssociatedContact } from "./deal-ops";
import { hubspotRequest } from "./hubspot";
import { appendOrderUpdate, markOrderUpdateApplied } from "./order-updates";
import { recordShopAddressEntry } from "./address-ack";
import { SHOP_ADDRESS_FORM_PASTE, buildAddressAckSnapshot } from "../../shared/address-ack";
import { offbookMode, updateOffbook } from "./priority-stack";
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

export function addressCheckToken(fields: ShipAddressFields): string {
  return hashNormalizedAddress(asFields(fields));
}

export async function checkCapturedAddress(
  input: Partial<ShipAddressFields>,
  options?: { audience?: "shop" | "public"; rateKey?: string },
): Promise<CaptureCheck> {
  const typed = asFields(input);
  const contact: DealAssociatedContact = {
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
  };
  const ensured =
    options?.audience === "public"
      ? await validatePublicAddress({ contact, rateKey: options.rateKey })
      : await ensureAddressCheck({ contact });
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
    checkedAt: ensured.checkedAt,
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
    checkToken: addressCheckToken(check.typed),
    suggestionToken: check.suggestion ? addressCheckToken(check.suggestion) : null,
    checkedAt: check.checkedAt ?? null,
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
  checkedAt?: string | null;
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
    checkedAt: input.checkedAt?.trim() || new Date().toISOString(),
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

function rawHubSpotAddress(contact: DealAssociatedContact): {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
} {
  return {
    address: contact.street1,
    city: contact.city,
    state: contact.state,
    zip: contact.zip,
    country: contact.country,
  };
}

function rawAddressBlank(raw: { address: string; city: string; state: string; zip: string; country: string }): boolean {
  return !raw.address.trim() && !raw.city.trim() && !raw.state.trim() && !raw.zip.trim() && !raw.country.trim();
}

export async function prepareClientAddressSubmit(input: {
  fields: Partial<ShipAddressFields>;
  decision?: string;
  noUnit?: boolean;
  addressCheckToken?: string;
  addressAcknowledged?: boolean;
  rateKey?: string;
}): Promise<
  | {
      ok: true;
      fields: ShipAddressFields;
      storedStatus: CaptureStatus;
      choice: "typed" | "suggested";
      checkedAt: string;
      messages: string[];
    }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  if (input.addressAcknowledged !== true) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        reason: "invalid-details",
        error: "Confirm that your name and shipping address are correct.",
      },
    };
  }
  const typed = asFields(input.fields);
  const check = await checkCapturedAddress(typed, { audience: "public", rateKey: input.rateKey });
  const token = input.addressCheckToken?.trim() ?? "";
  if (!token || token !== addressCheckToken(typed)) {
    const code = check.needsUnit && !typed.street2.trim() && input.noUnit !== true ? "needs_unit" : "address_choice";
    return {
      ok: false,
      status: 409,
      body: {
        ...capturePayload(check),
        ok: false,
        code,
        error:
          code === "needs_unit"
            ? "This building needs an apartment or unit number."
            : "Confirm the address again. The saved address has to match the one you checked.",
      },
    };
  }
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
  if (addressCheckToken(resolved.fields) !== token) {
    return {
      ok: false,
      status: 409,
      body: {
        ...capturePayload(check),
        ok: false,
        code: check.needsUnit && !resolved.fields.street2.trim() && input.noUnit !== true ? "needs_unit" : "address_choice",
        error: "The address check changed. Pick the address again before sending.",
      },
    };
  }
  return {
    ok: true,
    fields: typed,
    storedStatus: resolved.storedStatus,
    choice: resolved.choice,
    checkedAt: check.checkedAt?.trim() ?? "",
    messages: check.messages,
  };
}

export async function applyCapturedAddress(input: {
  confirm?: boolean;
  dealId?: string;
  offbookId?: number;
  fields: Partial<ShipAddressFields>;
  decision?: string;
  noUnit?: boolean;
  replaceHubspot?: boolean;
  switchToShip?: boolean;
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
    const mode = offbookMode(offbookId);
    if (!mode) return { ok: false, status: 404, body: { ok: false, error: "That off-book order was not found." } };
    if (mode === "pickup" && input.switchToShip !== true) {
      return {
        ok: false,
        status: 409,
        body: {
          ...capturePayload(check),
          ok: false,
          code: "switch_to_ship",
          error: "This order is pickup. Switch it to shipping and save this address?",
          fields: resolved.fields,
        },
      };
    }
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

  const contact = await fetchDealAssociatedContact(dealId, { fresh: true });
  if (!contact.id) {
    return { ok: false, status: 400, body: { ok: false, error: "No HubSpot contact linked to this deal." } };
  }
  const current = rawHubSpotAddress(contact);
  const decision = resolveWriteDecision(getConfig(), true);
  if (!rawAddressBlank(current) && input.replaceHubspot !== true) {
    return {
      ok: false,
      status: 409,
      body: {
        ...capturePayload(check),
        ok: false,
        code: "replace_hubspot",
        error: "This contact already has an address. Confirm Replace HubSpot address to overwrite it.",
        current,
        next: resolved.fields,
      },
    };
  }
  if (!decision.write) {
    return {
      ok: true,
      body: {
        ok: true,
        wrote: false,
        writesOff: true,
        reason: decision.reason,
        message: HUBSPOT_WRITES_OFF_MESSAGE,
        dealId,
        contactId: contact.id,
        current,
        fields: resolved.fields,
        status: resolved.storedStatus,
        choice: resolved.choice,
      },
    };
  }

  const before = asFields({
    street1: current.address,
    street2: "",
    city: current.city,
    state: current.state,
    zip: current.zip,
    country: current.country,
  });
  let changeLogId = 0;
  try {
    const entry = appendOrderUpdate({
      orderKey: `deal:${dealId}`,
      text: `Previous HubSpot address ${JSON.stringify(current)}. ${logText(before, resolved.fields, resolved.storedStatus)}`,
      source: "manual",
      author: "Miguel",
    });
    changeLogId = entry.id;
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: {
        ok: false,
        error: error instanceof Error ? error.message : "The previous address could not be logged, so HubSpot was not changed.",
      },
    };
  }
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
  markOrderUpdateApplied(changeLogId);
  invalidateDealContactCache(dealId);
  rememberDealAddressCheck({
    dealId,
    fields: resolved.fields,
    status: resolved.storedStatus,
    messages: check.messages,
    suggestion: resolved.choice === "suggested" ? resolved.fields : check.suggestion,
    checkedAt: check.checkedAt,
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
      wrote: true,
      reason: decision.reason,
      dealId,
      contactId: contact.id,
      fields: resolved.fields,
      status: resolved.storedStatus,
      choice: resolved.choice,
    },
  };
}
