import { HubSpotError, PRINT_ORDERS_PIPELINE, ensurePrintFileDealProperties, hubspotRequest } from "./hubspot";
import { splitName } from "./intake";
import { getSqlite } from "./order-links";
import type {
  HubSpotIntakeDealRef,
  OrderLineKind,
  PaidOrderCreateResult,
  PaidOrderDraft,
} from "../../shared/schema";
import { normalizeOrderLineKind, PRINT_LINE_KIND_PROPERTY, formatShippingStreetLine } from "../../shared/schema";
import { normalizeShipAddress, type ShipAddressFields } from "../../shared/ship-address";

export const DEPOSIT_RECEIVED_STAGE = "4096856781";

interface HubSpotRecord {
  id: string;
  properties?: Record<string, string | null>;
}

export type { PaidOrderCreateResult };

function clean(value: string | undefined, limit = 500): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedAmount(value: string): string {
  return Number(value.replace(/[$,\s]/g, "")).toFixed(2);
}

async function findContactByEmail(email: string): Promise<HubSpotRecord | null> {
  if (!email) return null;
  const data = await hubspotRequest("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      properties: ["firstname", "lastname", "email"],
      limit: 1,
    }),
  });
  return Array.isArray(data?.results) && data.results.length ? (data.results[0] as HubSpotRecord) : null;
}

function contactPropertiesFromDraft(draft: PaidOrderDraft, options?: { includeEmail?: boolean }): Record<string, string> {
  const name = splitName(draft.fullName, draft.marketplaceUsername);
  const properties: Record<string, string> = {
    firstname: name.firstName,
    lastname: name.lastName,
  };
  const cleaned = normalizeShipAddress({
    street1: clean(draft.address),
    street2: clean(draft.address2),
    city: clean(draft.city),
    state: clean(draft.state),
    zip: clean(draft.postalCode),
    country: clean(draft.country),
  }).normalized;
  const optional: Record<string, string> = {
    phone: clean(draft.phone),
    address: formatShippingStreetLine(cleaned.street1, cleaned.street2),
    city: cleaned.city,
    state: cleaned.state,
    zip: cleaned.zip,
    country: cleaned.street1 || cleaned.city ? cleaned.country : clean(draft.country),
  };
  if (options?.includeEmail !== false) {
    const email = clean(draft.email);
    if (email) properties.email = email;
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value) properties[key] = value;
  }
  return properties;
}

async function createContact(draft: PaidOrderDraft): Promise<HubSpotRecord> {
  return hubspotRequest("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties: contactPropertiesFromDraft(draft) }),
  });
}

function ensureContactAddressLog(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS contact_address_replacements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL,
      old_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );
  `);
}

/** Log the previous HubSpot address before a reused contact is overwritten. */
export function logReusedContactAddress(input: {
  contactId: string;
  oldText: string;
  newText: string;
}): number {
  ensureContactAddressLog();
  const row = getSqlite()
    .prepare(
      `INSERT INTO contact_address_replacements (contact_id, old_text, new_text, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.contactId, input.oldText, input.newText, new Date().toISOString());
  return Number(row.lastInsertRowid);
}

export function markReusedContactAddressApplied(id: number): void {
  ensureContactAddressLog();
  getSqlite()
    .prepare(`UPDATE contact_address_replacements SET applied_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function reusedContactAddressAppliedAt(id: number): string | null {
  ensureContactAddressLog();
  const row = getSqlite().prepare(`SELECT applied_at FROM contact_address_replacements WHERE id = ?`).get(id) as
    | { applied_at: string | null }
    | undefined;
  const value = row?.applied_at?.trim() ?? "";
  return value || null;
}

const ADDRESS_KEYS = ["address", "city", "state", "zip", "country"] as const;

export type RawContactAddress = {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

/** Manual paid-order create asks before a non-blank contact address is replaced. */
export class PaidOrderAddressConflict extends Error {
  readonly status = 409;
  readonly code = "replace_hubspot" as const;
  readonly current: RawContactAddress;
  readonly next: ShipAddressFields;

  constructor(current: RawContactAddress, next: ShipAddressFields) {
    super("This contact already has an address. Confirm Replace HubSpot address to overwrite it.");
    this.name = "PaidOrderAddressConflict";
    this.current = current;
    this.next = next;
  }
}

function draftShipAddress(draft: PaidOrderDraft): ShipAddressFields {
  return normalizeShipAddress({
    street1: clean(draft.address),
    street2: clean(draft.address2),
    city: clean(draft.city),
    state: clean(draft.state),
    zip: clean(draft.postalCode),
    country: clean(draft.country),
  }).normalized;
}

function readRawAddress(props: Record<string, string | null> | undefined): RawContactAddress {
  return {
    address: String(props?.address ?? ""),
    city: String(props?.city ?? ""),
    state: String(props?.state ?? ""),
    zip: String(props?.zip ?? ""),
    country: String(props?.country ?? ""),
  };
}

function rawAddressBlank(raw: RawContactAddress): boolean {
  return !raw.address.trim() && !raw.city.trim() && !raw.state.trim() && !raw.zip.trim() && !raw.country.trim();
}

function nextHasAddress(next: ShipAddressFields): boolean {
  return Boolean(next.street1 || next.street2 || next.city || next.state || next.zip);
}

function addressesDiffer(current: RawContactAddress, next: ShipAddressFields): boolean {
  const currentNorm = normalizeShipAddress({
    street1: current.address,
    street2: "",
    city: current.city,
    state: current.state,
    zip: current.zip,
    country: current.country,
  }).normalized;
  const currentLine = formatShippingStreetLine(currentNorm.street1, currentNorm.street2);
  const nextLine = formatShippingStreetLine(next.street1, next.street2);
  return (
    currentLine !== nextLine ||
    currentNorm.city !== next.city ||
    currentNorm.state !== next.state ||
    currentNorm.zip !== next.zip ||
    currentNorm.country !== next.country
  );
}

function addressProperties(next: ShipAddressFields): Record<string, string> {
  const properties: Record<string, string> = {
    address: formatShippingStreetLine(next.street1, next.street2),
    city: next.city,
    state: next.state,
    zip: next.zip,
    country: next.country,
  };
  for (const key of ADDRESS_KEYS) {
    if (!properties[key]) delete properties[key];
  }
  return properties;
}

export function keptOrderAddressLine(draft: PaidOrderDraft): string {
  const next = draftShipAddress(draft);
  const street = formatShippingStreetLine(next.street1, next.street2);
  const region = [next.city, [next.state, next.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, region, next.country].filter(Boolean).join(", ");
}

export type ContactAddressWrite = "filled" | "replaced" | "kept" | "unchanged";

/**
 * Name, phone, and address are written only when that HubSpot field is blank.
 * A different non-blank address is replaced only after an explicit confirm,
 * and the previous value is logged before that write.
 * A non-blank name or phone is left as HubSpot has it.
 */
export async function updateContact(
  contactId: string,
  draft: PaidOrderDraft,
  options?: { replaceHubspot?: boolean; keepOnOrder?: boolean; confirmAddressReplace?: boolean },
): Promise<ContactAddressWrite> {
  const next = draftShipAddress(draft);
  const properties = contactPropertiesFromDraft(draft, { includeEmail: false });
  for (const key of ADDRESS_KEYS) delete properties[key];

  const currentRecord = await hubspotRequest(
    `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=firstname,lastname,phone,address,city,state,zip,country`,
    { method: "GET" },
  );
  const rawProps = (currentRecord?.properties ?? {}) as Record<string, string | null>;
  const current = readRawAddress(rawProps);
  const wantsAddress = nextHasAddress(next);
  const differs = wantsAddress && !rawAddressBlank(current) && addressesDiffer(current, next);
  let mode: ContactAddressWrite = "unchanged";
  let logId = 0;

  if (wantsAddress && rawAddressBlank(current)) {
    Object.assign(properties, addressProperties(next));
    mode = "filled";
  } else if (differs && options?.replaceHubspot === true) {
    const nextRaw = addressProperties(next);
    logId = logReusedContactAddress({
      contactId,
      oldText: JSON.stringify(current),
      newText: JSON.stringify({
        address: nextRaw.address ?? "",
        city: nextRaw.city ?? "",
        state: nextRaw.state ?? "",
        zip: nextRaw.zip ?? "",
        country: nextRaw.country ?? "",
      }),
    });
    Object.assign(properties, nextRaw);
    mode = "replaced";
  } else if (differs && options?.confirmAddressReplace === true && options.keepOnOrder !== true) {
    throw new PaidOrderAddressConflict(current, next);
  } else if (differs) {
    mode = "kept";
  }

  if (String(rawProps.firstname ?? "").trim()) delete properties.firstname;
  if (String(rawProps.lastname ?? "").trim()) delete properties.lastname;
  if (String(rawProps.phone ?? "").trim()) delete properties.phone;

  if (Object.keys(properties).length === 0) return mode;
  await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  if (logId) markReusedContactAddressApplied(logId);
  return mode;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;

function ensurePaidOrderIdempotency(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS paid_order_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
}

/** Claim a manual-create retry key so a second submit cannot create another deal. */
export function claimPaidOrderCreate(
  key: string,
): { state: "invalid" } | { state: "claimed" } | { state: "pending" } | { state: "done"; result: PaidOrderCreateResult } {
  const cleaned = key.trim();
  if (!IDEMPOTENCY_KEY.test(cleaned)) return { state: "invalid" };
  ensurePaidOrderIdempotency();
  try {
    getSqlite()
      .prepare(`INSERT INTO paid_order_idempotency (idempotency_key, result_json, created_at) VALUES (?, '', ?)`)
      .run(cleaned, new Date().toISOString());
    return { state: "claimed" };
  } catch {
    const row = getSqlite()
      .prepare(`SELECT result_json FROM paid_order_idempotency WHERE idempotency_key = ?`)
      .get(cleaned) as { result_json: string } | undefined;
    const raw = row?.result_json?.trim() ?? "";
    if (!raw) return { state: "pending" };
    try {
      return { state: "done", result: JSON.parse(raw) as PaidOrderCreateResult };
    } catch {
      return { state: "pending" };
    }
  }
}

export function savePaidOrderCreate(key: string, result: PaidOrderCreateResult): void {
  const cleaned = key.trim();
  if (!IDEMPOTENCY_KEY.test(cleaned)) return;
  ensurePaidOrderIdempotency();
  getSqlite()
    .prepare(`UPDATE paid_order_idempotency SET result_json = ? WHERE idempotency_key = ?`)
    .run(JSON.stringify(result), cleaned);
}

export function releasePaidOrderCreate(key: string): void {
  const cleaned = key.trim();
  if (!IDEMPOTENCY_KEY.test(cleaned)) return;
  ensurePaidOrderIdempotency();
  getSqlite()
    .prepare(`DELETE FROM paid_order_idempotency WHERE idempotency_key = ? AND result_json = ''`)
    .run(cleaned);
}

async function createDeal(input: {
  productName: string;
  amount: string;
  contactName: string;
  marketplaceUsername: string;
  conversationSummary: string;
  orderGroup?: string;
  lineIndex?: number;
  lineCount?: number;
  kind?: OrderLineKind;
  keptShipTo?: string;
}): Promise<HubSpotRecord> {
  const product = clean(input.productName, 180);
  const name = clean(input.contactName || input.marketplaceUsername || "Marketplace customer", 100);
  const kind = normalizeOrderLineKind(input.kind);
  const dealName = `${product} - ${name}`.slice(0, 250);
  const detailLines = [
    "Source: Facebook Marketplace",
    "Payment status: Confirmed before HubSpot creation",
    kind === "shipping"
      ? "Line kind: Shipping (no plates required)"
      : kind === "fee"
        ? "Line kind: Fee / surcharge (no plates required)"
        : "Line kind: Print item",
    input.marketplaceUsername ? `Marketplace username: ${clean(input.marketplaceUsername, 100)}` : "",
    input.orderGroup
      ? `Order group: ${clean(input.orderGroup, 80)}${
          input.lineCount && input.lineCount > 1
            ? ` (item ${Number(input.lineIndex ?? 0) + 1} of ${input.lineCount})`
            : ""
        }`
      : "",
    clean(input.conversationSummary, 1500),
    input.keptShipTo ? `Ship-to kept on this order: ${clean(input.keptShipTo, 400)}` : "",
  ].filter(Boolean);

  return hubspotRequest("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        dealname: dealName,
        amount: normalizedAmount(input.amount),
        pipeline: PRINT_ORDERS_PIPELINE,
        dealstage: DEPOSIT_RECEIVED_STAGE,
        description: detailLines.join("\n"),
        [PRINT_LINE_KIND_PROPERTY]: kind,
      },
    }),
  });
}

async function associateDealToContact(dealId: string, contactId: string): Promise<void> {
  await hubspotRequest(
    `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/default/contacts/${encodeURIComponent(contactId)}`,
    { method: "PUT" },
  );
}

/**
 * Create one Contact (reuse by email) and one Deal per commercial line.
 * A single-item order still produces exactly one deal — same as before.
 */
export async function createPaidOrder(
  draft: PaidOrderDraft,
  options?: {
    lineItems?: Array<{ productName: string; amount: string; kind?: OrderLineKind }>;
    orderGroup?: string;
    replaceHubspot?: boolean;
    keepOnOrder?: boolean;
    /** Manual create shows Replace HubSpot address before a non-blank contact address changes. */
    confirmAddressReplace?: boolean;
  },
): Promise<PaidOrderCreateResult> {
  const lines =
    options?.lineItems && options.lineItems.length > 0
      ? options.lineItems
      : [{ productName: draft.productName, amount: draft.amount, kind: "print" as const }];

  await ensurePrintFileDealProperties();

  const existing = await findContactByEmail(clean(draft.email));
  const contact = existing ?? (await createContact(draft));
  const contactStatus: "existing" | "created" = existing ? "existing" : "created";
  let keptShipTo = "";
  if (existing) {
    try {
      const addressWrite = await updateContact(existing.id, draft, {
        replaceHubspot: options?.replaceHubspot === true,
        keepOnOrder: options?.keepOnOrder === true,
        confirmAddressReplace: options?.confirmAddressReplace === true,
      });
      if (addressWrite === "kept") keptShipTo = keptOrderAddressLine(draft);
    } catch (error) {
      if (error instanceof PaidOrderAddressConflict) throw error;
      // Contact reuse still succeeds even if a property patch fails.
    }
  }
  const contactName = clean(
    draft.fullName ||
      [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(" ") ||
      draft.marketplaceUsername,
  );

  const deals: HubSpotIntakeDealRef[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kind = normalizeOrderLineKind(line.kind);
    const deal = await createDeal({
      productName: line.productName,
      amount: line.amount,
      contactName,
      marketplaceUsername: draft.marketplaceUsername,
      conversationSummary: draft.conversationSummary,
      orderGroup: options?.orderGroup,
      lineIndex: index,
      lineCount: lines.length,
      kind,
      keptShipTo,
    });
    await associateDealToContact(deal.id, contact.id);
    const dealName = `${clean(line.productName, 180)} - ${clean(contactName, 100)}`.slice(0, 250);
    deals.push({
      dealId: deal.id,
      dealName,
      amount: normalizedAmount(line.amount),
      productName: clean(line.productName, 180),
      kind,
    });
  }

  const primary = deals[0]!;
  return {
    contactId: contact.id,
    contactStatus,
    dealId: primary.dealId,
    dealName: primary.dealName,
    pipeline: PRINT_ORDERS_PIPELINE,
    dealStage: DEPOSIT_RECEIVED_STAGE,
    deals,
  };
}
