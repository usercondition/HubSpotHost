/**
 * Validate a captured address with ShipEngine, then save split fields only after confirm.
 * Validation status is stored locally. HubSpot receives street, city, state, ZIP, and country.
 */
import { formatShippingStreetLine } from "../../shared/schema";
import {
  CLIENT_ADDRESS_ACK_TEXT,
  HUBSPOT_WRITES_OFF_MESSAGE,
  PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY,
  SHOP_ADDRESS_FORM_CLEANUP,
  SHOP_ADDRESS_FORM_PASTE,
  addressNeedsUnit,
  buildAddressAckSnapshot,
  formatAddressEntryLabel,
  formatClientConfirmedProperty,
  formatLabelAddress,
  parsePastedAddress,
  resolveCaptureSubmit,
  type AddressAckSource,
  type AddressAcknowledgment,
  type CaptureCheck,
  type CaptureStatus,
} from "../../shared/address-capture";
import {
  normalizeShipAddress,
  type NormalizedShipAddress,
  type ShipAddressFields,
} from "../../shared/ship-address";
import {
  ensureAddressCheck,
  hashNormalizedAddress,
  saveAddressCheck,
  validatePublicAddress,
  type AddressCheckStatus,
  type StoredAddressCheckStatus,
} from "./address-checks";
import { getConfig, resolveWriteDecision } from "./config";
import type { DealAssociatedContact } from "./deal-ops";
import { HUBSPOT_BUSY_MESSAGE, HubSpotError, ensurePrintFileDealProperties, hubspotRequest, isHubSpotBusyError } from "./hubspot";
import { getSqlite } from "./order-links";
import { appendOrderUpdate, markOrderUpdateApplied } from "./order-updates";
import { offbookMode, updateOffbook } from "./priority-stack";
import { attachShippingLabelToDeals } from "./shipping-label-attach";
import {
  ShipEngineError,
  buildShipNotesFromShipEngine,
  createShipEngineRates,
  getShipEngineApiKey,
  getShipFromAddress,
  getShipEngineStatus,
  purchaseShipEngineLabel,
  type ShipEngineAddress,
  type ShipEngineAddressCheck,
  type ShipEngineMatchedAddress,
} from "./shipengine";

async function loadDealOps() {
  return import("./deal-ops");
}

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

  const { fetchDealAssociatedContact } = await loadDealOps();
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
  const { invalidateDealContactCache } = await loadDealOps();
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

function ensureAckTable(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS address_acknowledgments (
      order_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      snapshot TEXT NOT NULL DEFAULT '',
      text_version TEXT NOT NULL DEFAULT '',
      form_source TEXT NOT NULL DEFAULT ''
    );
  `);
}

function readAckRow(orderKey: string): AddressAcknowledgment | null {
  ensureAckTable();
  const row = getSqlite()
    .prepare(
      `SELECT order_key, source, acknowledged_at, snapshot, text_version, form_source
       FROM address_acknowledgments WHERE order_key = ?`,
    )
    .get(orderKey) as
    | {
        order_key: string;
        source: string;
        acknowledged_at: string;
        snapshot: string;
        text_version: string;
        form_source: string;
      }
    | undefined;
  if (!row || (row.source !== "client" && row.source !== "shop")) return null;
  return {
    orderKey: row.order_key,
    source: row.source,
    acknowledgedAt: row.acknowledged_at,
    snapshot: row.snapshot,
    textVersion: row.text_version,
    formSource: row.form_source,
  };
}

export function readAddressAcknowledgment(orderKey: string): AddressAcknowledgment | null {
  return readAckRow(orderKey);
}

export function addressEntryLabelFor(orderKey: string): string | null {
  return formatAddressEntryLabel(readAckRow(orderKey));
}

export function saveAddressAcknowledgment(input: AddressAcknowledgment): void {
  ensureAckTable();
  getSqlite()
    .prepare(
      `INSERT INTO address_acknowledgments (order_key, source, acknowledged_at, snapshot, text_version, form_source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_key) DO UPDATE SET
         source = excluded.source,
         acknowledged_at = excluded.acknowledged_at,
         snapshot = excluded.snapshot,
         text_version = excluded.text_version,
         form_source = excluded.form_source`,
    )
    .run(input.orderKey, input.source, input.acknowledgedAt, input.snapshot, input.textVersion, input.formSource);
}

/** Create the deal property when it is missing, then PATCH only when the current value is blank. */
export async function writeClientConfirmedAddressIfEmpty(
  dealId: string,
  value: string,
): Promise<"skipped" | "kept" | "written"> {
  const decision = resolveWriteDecision(getConfig(), true);
  if (!decision.write) return "skipped";
  const current = await hubspotRequest(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY}`,
    { method: "GET" },
  );
  const existing = String(current?.properties?.[PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY] ?? "").trim();
  if (existing) return "kept";
  await ensurePrintFileDealProperties();
  await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { [PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY]: value.slice(0, 6000) },
    }),
  });
  return "written";
}

/** Copy a client-form acknowledgment onto each new deal. A HubSpot failure does not undo the local proof. */
export async function publishClientAddressAcknowledgments(
  dealIds: string[],
  input: { acknowledgedAt: string; snapshot: string; textVersion: string; formSource: string },
): Promise<void> {
  const propertyValue = formatClientConfirmedProperty(input);
  for (const dealId of dealIds) {
    const orderKey = `deal:${dealId}`;
    saveAddressAcknowledgment({
      orderKey,
      source: "client" satisfies AddressAckSource,
      acknowledgedAt: input.acknowledgedAt,
      snapshot: input.snapshot,
      textVersion: input.textVersion,
      formSource: input.formSource,
    });
    appendOrderUpdate({
      orderKey,
      text: [
        "Client confirmed name and address.",
        "Confirmed by customer.",
        input.acknowledgedAt,
        input.snapshot,
        `checkbox ${input.textVersion} · form ${input.formSource}`,
        CLIENT_ADDRESS_ACK_TEXT,
      ].join("\n"),
      source: "system",
      author: "Client",
    });
    const decision = resolveWriteDecision(getConfig(), true);
    if (!decision.write) continue;
    const outcome = await writeClientConfirmedAddressIfEmpty(dealId, propertyValue);
    if (outcome === "kept") {
      appendOrderUpdate({
        orderKey,
        text: "print_client_confirmed_address already had a value. The newer confirmation stayed in this log and was not copied over HubSpot.",
        source: "system",
        author: "Client",
      });
    }
  }
}

/** Paste-to-fill and Fix in HubSpot. Does not touch the client confirmation property. */
export function recordShopAddressEntry(input: {
  orderKey: string;
  formSource: string;
  snapshot: string;
  sourceKind: "manual" | "system";
}): void {
  const acknowledgedAt = new Date().toISOString();
  saveAddressAcknowledgment({
    orderKey: input.orderKey,
    source: "shop",
    acknowledgedAt,
    snapshot: input.snapshot,
    textVersion: "",
    formSource: input.formSource,
  });
  appendOrderUpdate({
    orderKey: input.orderKey,
    text: `Entered by shop.\n${input.snapshot}`,
    source: input.sourceKind,
    author: "Miguel",
  });
}

export type AddressDecision = "accept" | "override";

const MISSING_ADDRESS =
  "HubSpot contact is missing a full ship-to address (name, street, city, state, zip).";

const BOUGHT_LABEL_WARNING = "Label bought; the follow-up contact read failed";

function confirmationBody(normalized: NormalizedShipAddress, validation: ShipEngineAddressCheck): Record<string, unknown> {
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

function addressFromMatch(base: ShipEngineAddress, matched: ShipEngineMatchedAddress): ShipEngineAddress {
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
  const status =
    ensured.status === "corrected" || ensured.status === "verified"
      ? "verified"
      : ensured.status === "error"
        ? "error"
        : "unverified";
  return { status, matched: ensured.matched, messages: ensured.messages, differs: ensured.status === "corrected" };
}

export async function gateLabelAddress(
  contact: DealAssociatedContact,
  decision?: AddressDecision,
  dealId?: string,
): Promise<
  | { ok: true; address: ShipEngineAddress; normalized: NormalizedShipAddress; validation: ShipEngineAddressCheck }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const ensured = await ensureAddressCheck({ dealId, contact, refreshIfStale: true });
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
    if (!getShipEngineApiKey()) {
      return {
        ok: false,
        status: 503,
        body: {
          ok: false,
          code: "address_unchecked",
          error: "Add SHIPENGINE_API_KEY on Railway (ShipStation API → API Keys).",
        },
      };
    }
    if (decision === "override") {
      return {
        ok: true,
        address: ensured.address,
        normalized: ensured.normalized,
        validation: {
          status: "unverified",
          matched: null,
          messages: ["ShipEngine could not check this address."],
          differs: false,
        },
      };
    }
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        code: "address_confirmation",
        error: "ShipEngine could not check this address.",
        original: ensured.normalized.original,
        normalized: ensured.normalized.normalized,
        suggestion: null,
        messages: ["ShipEngine could not check this address. Keep the contact address to see rates. Nothing was bought."],
      },
    };
  }
  const validation = asAddressCheck(ensured);
  if (ensured.status === "verified" || decision === "override") {
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

export async function applyAddressCleanup(input: {
  dealId: string;
  confirm?: boolean;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (input.confirm !== true) {
    return { ok: false, status: 400, body: { ok: false, error: "Confirm the address cleanup first." } };
  }
  const { fetchDealAssociatedContact, invalidateDealContactCache } = await loadDealOps();
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
  recordShopAddressEntry({
    orderKey: `deal:${input.dealId}`,
    formSource: SHOP_ADDRESS_FORM_CLEANUP,
    snapshot: buildAddressAckSnapshot({
      fullName: contact.name,
      email: contact.email,
      phone: contact.phone,
      address: normalized.normalized,
    }),
    sourceKind: "system",
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

export async function verifyAddressNow(dealId: string): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { fetchDealAssociatedContact } = await loadDealOps();
  const contact = await fetchDealAssociatedContact(dealId);
  const ensured = await ensureAddressCheck({ dealId, contact, force: true });
  if (!ensured.address) return { ok: false, status: 400, body: { ok: false, error: MISSING_ADDRESS } };
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

export type HttpResult = { status: number; body: Record<string, unknown> };

function httpFailure(error: unknown, fallback: string): HttpResult {
  if (isHubSpotBusyError(error)) return { status: 503, body: { ok: false, error: HUBSPOT_BUSY_MESSAGE } };
  const statusCode = error instanceof ShipEngineError || error instanceof HubSpotError ? error.status : 502;
  return {
    status: statusCode >= 400 && statusCode < 600 ? statusCode : 502,
    body: { ok: false, error: error instanceof Error ? error.message : fallback },
  };
}

export async function loadLabelShipTo(dealId: string): Promise<HttpResult> {
  try {
    const { fetchDealAssociatedContact } = await loadDealOps();
    const contact = await fetchDealAssociatedContact(dealId);
    const ensured = await ensureAddressCheck({ dealId, contact });
    const cleaned = ensured.normalized;
    const missing = ensured.address
      ? []
      : [
          !contact.name && "name",
          !cleaned.normalized.street1 && "street",
          !cleaned.normalized.city && "city",
          !cleaned.normalized.state && "state",
          !cleaned.normalized.zip && "zip",
        ].filter(Boolean);
    return {
      status: 200,
      body: {
        ok: true,
        dealId,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          addressLines: contact.addressLines,
          street1: contact.street1,
          street2: contact.street2,
          city: contact.city,
          state: contact.state,
          zip: contact.zip,
          country: contact.country,
        },
        original: cleaned.original,
        normalized: cleaned.normalized,
        needsCleanup: cleaned.changed,
        changes: cleaned.changes,
        validation: {
          status: ensured.status,
          checkedAt: ensured.checkedAt,
          addressHash: ensured.addressHash,
          suggestion: ensured.matched,
          messages: ensured.messages,
        },
        addressEntryLabel: addressEntryLabelFor(`deal:${dealId}`),
        ready: Boolean(ensured.address),
        hasContact: Boolean(contact.id),
        missing,
      },
    };
  } catch (error) {
    return httpFailure(error, "Could not load ship-to address");
  }
}

export async function quoteGatedLabelRates(input: {
  dealId: string;
  parcel: { lengthIn: number; widthIn: number; heightIn: number; weightOz: number };
  addressFrom?: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    phone?: string;
    email?: string;
  };
  addressDecision?: AddressDecision;
}): Promise<HttpResult> {
  if (!getShipEngineStatus().hasApiKey) {
    return { status: 503, body: { ok: false, error: "Add SHIPENGINE_API_KEY on Railway (ShipStation API → API Keys)." } };
  }
  const addressFrom = input.addressFrom
    ? {
        name: input.addressFrom.name,
        street1: input.addressFrom.street1,
        street2: input.addressFrom.street2 || undefined,
        city: input.addressFrom.city,
        state: input.addressFrom.state,
        zip: input.addressFrom.zip,
        country: input.addressFrom.country || "US",
        phone: input.addressFrom.phone || undefined,
        email: input.addressFrom.email || undefined,
      }
    : getShipFromAddress();
  if (!addressFrom) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Set SHIP_FROM_NAME, SHIP_FROM_STREET1, SHIP_FROM_CITY, SHIP_FROM_STATE, and SHIP_FROM_ZIP on Railway.",
      },
    };
  }
  try {
    const { fetchDealAssociatedContact } = await loadDealOps();
    const contact = await fetchDealAssociatedContact(input.dealId);
    const gated = await gateLabelAddress(contact, input.addressDecision, input.dealId);
    if (!gated.ok) return { status: gated.status, body: gated.body };
    const quoted = await createShipEngineRates({ addressFrom, addressTo: gated.address, parcel: input.parcel });
    return {
      status: 200,
      body: {
        ok: true,
        dealId: input.dealId,
        testMode: quoted.testMode,
        shipmentId: quoted.shipmentId,
        addressTo: {
          name: gated.address.name,
          street1: gated.address.street1,
          city: gated.address.city,
          state: gated.address.state,
          zip: gated.address.zip,
        },
        original: gated.normalized.original,
        normalized: gated.normalized.normalized,
        rates: quoted.rates,
        messages: quoted.messages,
      },
    };
  } catch (error) {
    return httpFailure(error, "Could not get ShipEngine rates");
  }
}

function boughtLabelBody(
  dealIds: string[],
  purchase: Awaited<ReturnType<typeof purchaseShipEngineLabel>>,
  warning: string,
): Record<string, unknown> {
  return {
    ok: true,
    attachedDealIds: dealIds,
    contact: { id: null, name: "", email: "" },
    buyerEmail: null,
    marketplaceSend: null,
    warning,
    shipengine: {
      labelId: purchase.labelId,
      trackingNumber: purchase.trackingNumber,
      trackingUrl: purchase.trackingUrl,
      labelUrl: purchase.labelUrl,
      amount: purchase.amount,
      currency: purchase.currency,
      carrierCode: purchase.carrierCode,
      serviceCode: purchase.serviceCode,
      testMode: purchase.testMode,
    },
  };
}

export async function purchaseGatedLabel(input: {
  dealIds: string[];
  rateId: string;
  amount?: string;
  carrierCode?: string;
  serviceType?: string;
  messageChannel?: "marketplace" | "offerup";
  packingDone?: boolean;
  liveWrite?: boolean;
  addressDecision?: AddressDecision;
}): Promise<HttpResult> {
  if (!getShipEngineStatus().hasApiKey) {
    return { status: 503, body: { ok: false, error: "Add SHIPENGINE_API_KEY on Railway before buying labels." } };
  }
  let purchase: Awaited<ReturnType<typeof purchaseShipEngineLabel>> | null = null;
  try {
    const { fetchDealAssociatedContact } = await loadDealOps();
    const contact = await fetchDealAssociatedContact(input.dealIds[0]!, { fresh: true });
    const gated = await gateLabelAddress(contact, input.addressDecision, input.dealIds[0]);
    if (!gated.ok) return { status: gated.status, body: gated.body };
    purchase = await purchaseShipEngineLabel({ rateId: input.rateId });
    const notes = buildShipNotesFromShipEngine({
      carrierCode: purchase.carrierCode || input.carrierCode || "",
      serviceType: purchase.serviceCode || input.serviceType || "",
      amount: purchase.amount || input.amount || "",
      labelUrl: purchase.labelUrl,
      recipientName: contact.name || null,
    });
    const postageUsd = purchase.amount || input.amount || "";
    const label = {
      labelId: purchase.labelId,
      trackingNumber: purchase.trackingNumber,
      trackingUrl: purchase.trackingUrl,
      labelUrl: purchase.labelUrl,
      amount: postageUsd,
      currency: purchase.currency,
      carrierCode: purchase.carrierCode || input.carrierCode,
      serviceCode: purchase.serviceCode || input.serviceType,
      testMode: purchase.testMode,
    };
    try {
      const attached = await attachShippingLabelToDeals({
        dealIds: input.dealIds,
        trackingNumber: purchase.trackingNumber,
        notes,
        postageUsd,
        packingDone: input.packingDone ?? true,
        labelBought: true,
        markComplete: true,
        messageChannel: input.messageChannel ?? "marketplace",
        liveWrite: input.liveWrite,
        shipengine: { labelId: purchase.labelId, carrier: purchase.carrierCode, service: purchase.serviceCode },
      });
      if (!attached.ok) return { status: 400, body: { ...attached, shipengine: label } };
      return { status: 200, body: { ...attached, shipengine: label } };
    } catch (error) {
      return {
        status: 200,
        body: boughtLabelBody(input.dealIds, purchase, error instanceof Error ? error.message : BOUGHT_LABEL_WARNING),
      };
    }
  } catch (error) {
    if (purchase) {
      return {
        status: 200,
        body: boughtLabelBody(input.dealIds, purchase, error instanceof Error ? error.message : BOUGHT_LABEL_WARNING),
      };
    }
    return httpFailure(error, "Could not purchase ShipEngine label");
  }
}
