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
import { normalizeShipAddress } from "../../shared/ship-address";

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

/** Refresh shipping / name details when we reuse a Contact by email. */
export async function updateContact(contactId: string, draft: PaidOrderDraft): Promise<void> {
  const properties = contactPropertiesFromDraft(draft, { includeEmail: false });
  if (Object.keys(properties).length === 0) return;
  const current = await hubspotRequest(
    `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=address,city,state,zip,country`,
    { method: "GET" },
  );
  const props = (current?.properties ?? {}) as Record<string, string | null>;
  const oldAddress = {
    address: String(props.address ?? ""),
    city: String(props.city ?? ""),
    state: String(props.state ?? ""),
    zip: String(props.zip ?? ""),
    country: String(props.country ?? ""),
  };
  const replacing = ADDRESS_KEYS.some((key) => {
    const previous = oldAddress[key].trim();
    const next = properties[key]?.trim() ?? "";
    return Boolean(previous) && Boolean(next) && previous !== next;
  });
  let logId = 0;
  if (replacing) {
    logId = logReusedContactAddress({
      contactId,
      oldText: JSON.stringify(oldAddress),
      newText: JSON.stringify({
        address: properties.address ?? "",
        city: properties.city ?? "",
        state: properties.state ?? "",
        zip: properties.zip ?? "",
        country: properties.country ?? "",
      }),
    });
  }
  await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  if (logId) markReusedContactAddressApplied(logId);
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
  if (existing) {
    try {
      await updateContact(existing.id, draft);
    } catch {
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
