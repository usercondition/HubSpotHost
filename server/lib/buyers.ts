/**
 * Returning-buyer lookup: HubSpot contact by email + prior local intake history.
 * Prefills address / phone without becoming a second CRM.
 */
import { desc } from "drizzle-orm";
import { orderIntakeLinks, type ReturningBuyerProfile } from "../../shared/schema";
import { hubspotRequest } from "./hubspot";
import { getDb } from "./order-links";

function clean(value: string | null | undefined, limit = 200): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function emptyProfile(email: string): ReturningBuyerProfile {
  return {
    found: false,
    source: null,
    email,
    fullName: "",
    phone: "",
    username: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "",
    hubspotContactId: null,
    priorOrders: 0,
  };
}

async function findHubSpotContactByEmail(email: string): Promise<{
  id: string;
  properties: Record<string, string | null>;
} | null> {
  if (!email) return null;
  try {
    const data = await hubspotRequest("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [{ propertyName: "email", operator: "EQ", value: email }],
          },
        ],
        properties: ["firstname", "lastname", "email", "phone", "address", "city", "state", "zip", "country"],
        limit: 1,
      }),
    });
    const row = Array.isArray(data?.results) && data.results.length ? data.results[0] : null;
    if (!row || typeof row.id !== "string") return null;
    const properties =
      row.properties && typeof row.properties === "object"
        ? (row.properties as Record<string, string | null>)
        : {};
    return { id: row.id, properties };
  } catch {
    return null;
  }
}

function findLocalBuyerByEmail(email: string): {
  fullName: string;
  phone: string;
  username: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  priorOrders: number;
} | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const rows = getDb()
    .select()
    .from(orderIntakeLinks)
    .orderBy(desc(orderIntakeLinks.submittedAt), desc(orderIntakeLinks.id))
    .limit(300)
    .all();

  const matches = rows.filter((row) => clean(row.clientEmail).toLowerCase() === normalized);
  if (matches.length === 0) return null;
  const latest = matches[0]!;
  return {
    fullName: clean(latest.clientFullName),
    phone: clean(latest.clientPhone, 40),
    username: clean(latest.clientUsername, 120),
    address: clean(latest.shippingStreet),
    city: clean(latest.shippingCity, 120),
    state: clean(latest.shippingState, 120),
    postalCode: clean(latest.shippingPostalCode, 40),
    country: clean(latest.shippingCountry, 120),
    priorOrders: matches.filter((row) => row.status === "created" || row.status === "pending_review").length || matches.length,
  };
}

/**
 * Prefer HubSpot for shipping fields when present; fill gaps from local intake.
 */
export async function lookupReturningBuyer(emailRaw: string): Promise<ReturningBuyerProfile> {
  const email = clean(emailRaw, 200).toLowerCase();
  if (!email || !email.includes("@")) return emptyProfile(email);

  const [hubspot, local] = await Promise.all([findHubSpotContactByEmail(email), Promise.resolve(findLocalBuyerByEmail(email))]);

  if (!hubspot && !local) return emptyProfile(email);

  const props = hubspot?.properties ?? {};
  const hubName = clean([props.firstname, props.lastname].filter(Boolean).join(" "));
  const profile: ReturningBuyerProfile = {
    found: true,
    source: hubspot && local ? "both" : hubspot ? "hubspot" : "intake",
    email,
    fullName: hubName || local?.fullName || "",
    phone: clean(props.phone, 40) || local?.phone || "",
    username: local?.username || "",
    address: clean(props.address) || local?.address || "",
    city: clean(props.city, 120) || local?.city || "",
    state: clean(props.state, 120) || local?.state || "",
    postalCode: clean(props.zip, 40) || local?.postalCode || "",
    country: clean(props.country, 120) || local?.country || "",
    hubspotContactId: hubspot?.id ?? null,
    priorOrders: local?.priorOrders ?? (hubspot ? 1 : 0),
  };
  return profile;
}
