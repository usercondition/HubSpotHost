import { HubSpotError, PRINT_ORDERS_PIPELINE, hubspotRequest } from "./hubspot";
import { splitName } from "./intake";
import type {
  HubSpotIntakeDealRef,
  PaidOrderCreateResult,
  PaidOrderDraft,
} from "../../shared/schema";

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
  const optional: Record<string, string> = {
    phone: clean(draft.phone),
    address: clean(draft.address),
    city: clean(draft.city),
    state: clean(draft.state),
    zip: clean(draft.postalCode),
    country: clean(draft.country),
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

/** Refresh shipping / name details when we reuse a Contact by email. */
async function updateContact(contactId: string, draft: PaidOrderDraft): Promise<void> {
  const properties = contactPropertiesFromDraft(draft, { includeEmail: false });
  if (Object.keys(properties).length === 0) return;
  await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
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
}): Promise<HubSpotRecord> {
  const product = clean(input.productName, 180);
  const name = clean(input.contactName || input.marketplaceUsername || "Marketplace customer", 100);
  const dealName = `${product} - ${name}`.slice(0, 250);
  const detailLines = [
    "Source: Facebook Marketplace",
    "Payment status: Confirmed before HubSpot creation",
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
    lineItems?: Array<{ productName: string; amount: string }>;
    orderGroup?: string;
  },
): Promise<PaidOrderCreateResult> {
  const lines =
    options?.lineItems && options.lineItems.length > 0
      ? options.lineItems
      : [{ productName: draft.productName, amount: draft.amount }];

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
    const deal = await createDeal({
      productName: line.productName,
      amount: line.amount,
      contactName,
      marketplaceUsername: draft.marketplaceUsername,
      conversationSummary: draft.conversationSummary,
      orderGroup: options?.orderGroup,
      lineIndex: index,
      lineCount: lines.length,
    });
    await associateDealToContact(deal.id, contact.id);
    const dealName = `${clean(line.productName, 180)} - ${clean(contactName, 100)}`.slice(0, 250);
    deals.push({
      dealId: deal.id,
      dealName,
      amount: normalizedAmount(line.amount),
      productName: clean(line.productName, 180),
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
