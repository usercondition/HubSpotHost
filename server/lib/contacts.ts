/**
 * HubSpot contacts browser for Print Ops — CRM is source of truth;
 * this surfaces contact cards without becoming a second database.
 */
import { fetchHubSpotPortalId, hubspotRequest } from "./hubspot";
import type { HubSpotContactCard } from "../../shared/schema";

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "company",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "hs_object_id",
  "createdate",
  "lastmodifieddate",
] as const;

function clean(value: string | null | undefined, limit = 240): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function mapContactRow(row: {
  id?: string;
  properties?: Record<string, string | null>;
}): HubSpotContactCard | null {
  if (!row || typeof row.id !== "string" || !row.id) return null;
  const props = row.properties && typeof row.properties === "object" ? row.properties : {};
  const fullName = clean([props.firstname, props.lastname].filter(Boolean).join(" "));
  const email = clean(props.email, 200).toLowerCase();
  const phone = clean(props.phone || props.mobilephone, 40);
  return {
    contactId: row.id,
    fullName: fullName || (email ? email.split("@")[0]! : "Unnamed contact"),
    email,
    phone,
    company: clean(props.company, 160),
    address: clean(props.address),
    city: clean(props.city, 120),
    state: clean(props.state, 120),
    postalCode: clean(props.zip, 40),
    country: clean(props.country, 120),
    createdAt: clean(props.createdate, 40) || null,
    updatedAt: clean(props.lastmodifieddate, 40) || null,
  };
}

export type ContactsBrowseResult = {
  contacts: HubSpotContactCard[];
  total: number;
  query: string;
  hubspotPortalId: string | null;
};

/**
 * Browse / search HubSpot contacts. Empty query returns recently updated contacts.
 */
export async function browseHubSpotContacts(queryRaw: string, limit = 40): Promise<ContactsBrowseResult> {
  const query = clean(queryRaw, 120);
  const capped = Math.min(Math.max(1, Math.floor(limit) || 40), 100);

  const [portalId, data] = await Promise.all([
    fetchHubSpotPortalId(),
    query
      ? hubspotRequest("/crm/v3/objects/contacts/search", {
          method: "POST",
          body: JSON.stringify({
            query,
            properties: [...CONTACT_PROPERTIES],
            limit: capped,
            sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
          }),
        })
      : hubspotRequest(
          `/crm/v3/objects/contacts?limit=${capped}&properties=${CONTACT_PROPERTIES.join(",")}&sorts=-lastmodifieddate`,
          { method: "GET" },
        ),
  ]);

  const rows: unknown[] = Array.isArray(data?.results) ? data.results : [];
  const contacts = rows
    .map((row) =>
      mapContactRow(
        row && typeof row === "object"
          ? (row as { id?: string; properties?: Record<string, string | null> })
          : {},
      ),
    )
    .filter((row): row is HubSpotContactCard => Boolean(row));

  const total =
    typeof data?.total === "number"
      ? data.total
      : typeof data?.paging?.next?.after === "string"
        ? contacts.length
        : contacts.length;

  return {
    contacts,
    total: Number.isFinite(total) ? total : contacts.length,
    query,
    hubspotPortalId: portalId,
  };
}

export async function getHubSpotContact(contactIdRaw: string): Promise<{
  contact: HubSpotContactCard | null;
  hubspotPortalId: string | null;
}> {
  const contactId = clean(contactIdRaw, 64);
  if (!contactId) return { contact: null, hubspotPortalId: null };

  const [portalId, data] = await Promise.all([
    fetchHubSpotPortalId(),
    hubspotRequest(
      `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${CONTACT_PROPERTIES.join(",")}`,
      { method: "GET" },
    ),
  ]);

  return {
    contact: mapContactRow({
      id: typeof data?.id === "string" ? data.id : contactId,
      properties:
        data?.properties && typeof data.properties === "object"
          ? (data.properties as Record<string, string | null>)
          : {},
    }),
    hubspotPortalId: portalId,
  };
}

/** Exported for unit tests. */
export const __test = { mapContactRow, clean };
