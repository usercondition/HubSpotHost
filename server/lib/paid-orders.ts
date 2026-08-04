import { HubSpotError } from "./hubspot";
import { getConfig, getToken } from "./config";
import { type PaidOrderDraft, splitName } from "./intake";

const REQUEST_TIMEOUT_MS = 15_000;
export const PRINT_ORDERS_PIPELINE = "default";
export const DEPOSIT_RECEIVED_STAGE = "4096856781";

interface HubSpotRecord {
  id: string;
  properties?: Record<string, string | null>;
}

export interface PaidOrderCreateResult {
  contactId: string;
  contactStatus: "existing" | "created";
  dealId: string;
  dealName: string;
  pipeline: string;
  dealStage: string;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function hubspotRequest(path: string, init: { method: string; body?: string }): Promise<any> {
  const config = getConfig();
  const token = getToken();
  if (!token) throw new HubSpotError("HubSpot token not configured", 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.apiBase}${path}`, {
      method: init.method,
      headers: authHeaders(token),
      body: init.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        detail = typeof parsed?.message === "string" ? parsed.message : "";
      } catch {
        detail = "";
      }
      throw new HubSpotError(
        `HubSpot API ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof HubSpotError) throw error;
    if ((error as Error)?.name === "AbortError") {
      throw new HubSpotError("HubSpot API request timed out", 504);
    }
    throw new HubSpotError("HubSpot API request failed", 502);
  } finally {
    clearTimeout(timer);
  }
}

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

async function createContact(draft: PaidOrderDraft): Promise<HubSpotRecord> {
  const name = splitName(draft.fullName, draft.marketplaceUsername);
  const properties: Record<string, string> = {
    firstname: name.firstName,
    lastname: name.lastName,
  };
  const optional: Record<string, string> = {
    email: clean(draft.email),
    phone: clean(draft.phone),
    address: clean(draft.address),
    city: clean(draft.city),
    state: clean(draft.state),
    zip: clean(draft.postalCode),
    country: clean(draft.country),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value) properties[key] = value;
  }
  return hubspotRequest("/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
}

async function createDeal(draft: PaidOrderDraft, contactName: string): Promise<HubSpotRecord> {
  const product = clean(draft.productName, 180);
  const name = clean(contactName || draft.marketplaceUsername || "Marketplace customer", 100);
  const dealName = `${product} - ${name}`.slice(0, 250);
  const detailLines = [
    "Source: Facebook Marketplace",
    "Payment status: Confirmed before HubSpot creation",
    draft.marketplaceUsername ? `Marketplace username: ${clean(draft.marketplaceUsername, 100)}` : "",
    clean(draft.conversationSummary, 1500),
  ].filter(Boolean);

  return hubspotRequest("/crm/v3/objects/deals", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        dealname: dealName,
        amount: normalizedAmount(draft.amount),
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

export async function createPaidOrder(draft: PaidOrderDraft): Promise<PaidOrderCreateResult> {
  const existing = await findContactByEmail(clean(draft.email));
  const contact = existing ?? (await createContact(draft));
  const contactStatus: "existing" | "created" = existing ? "existing" : "created";
  const contactName = clean(
    [contact.properties?.firstname, contact.properties?.lastname].filter(Boolean).join(" ") ||
      draft.fullName ||
      draft.marketplaceUsername,
  );
  const deal = await createDeal(draft, contactName);
  await associateDealToContact(deal.id, contact.id);

  return {
    contactId: contact.id,
    contactStatus,
    dealId: deal.id,
    dealName: `${clean(draft.productName, 180)} - ${clean(contactName, 100)}`.slice(0, 250),
    pipeline: PRINT_ORDERS_PIPELINE,
    dealStage: DEPOSIT_RECEIVED_STAGE,
  };
}
