/**
 * Shippo shipping API — rates + label purchase.
 * Token and ship-from address come from env only; never log the token.
 */
import { z } from "zod";

const SHIPPO_API_BASE = "https://api.goshippo.com";

export type ShippoAddress = {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
};

export type ShippoParcel = {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
};

export type ShippoRateOffer = {
  objectId: string;
  amount: string;
  currency: string;
  provider: string;
  servicelevelName: string;
  servicelevelToken: string;
  estimatedDays: number | null;
  durationTerms: string;
  attributes: string[];
};

export type ShippoShipmentResult = {
  shipmentId: string;
  rates: ShippoRateOffer[];
  messages: string[];
  test: boolean;
};

export type ShippoPurchaseResult = {
  transactionId: string;
  status: string;
  trackingNumber: string;
  trackingUrlProvider: string | null;
  labelUrl: string | null;
  amount: string;
  currency: string;
  provider: string;
  servicelevelName: string;
  test: boolean;
  messages: string[];
};

function envTrim(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() || "";
}

/** Live or test API token. Prefer CUSTOM_CRED_* when platform-injected. */
export function getShippoApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    envTrim(env, "CUSTOM_CRED_SHIPPO_API_KEY_TOKEN") ||
    envTrim(env, "SHIPPO_API_KEY") ||
    ""
  );
}

export function shippoKeyIsTest(token: string): boolean {
  return /^shippo_test_/i.test(token.trim());
}

export function getShipFromAddress(env: NodeJS.ProcessEnv = process.env): ShippoAddress | null {
  const name = envTrim(env, "SHIP_FROM_NAME");
  const street1 = envTrim(env, "SHIP_FROM_STREET1");
  const city = envTrim(env, "SHIP_FROM_CITY");
  const state = envTrim(env, "SHIP_FROM_STATE");
  const zip = envTrim(env, "SHIP_FROM_ZIP");
  const country = envTrim(env, "SHIP_FROM_COUNTRY") || "US";
  if (!name || !street1 || !city || !state || !zip) return null;
  return {
    name,
    street1,
    street2: envTrim(env, "SHIP_FROM_STREET2") || undefined,
    city,
    state,
    zip,
    country,
    phone: envTrim(env, "SHIP_FROM_PHONE") || undefined,
    email: envTrim(env, "SHIP_FROM_EMAIL") || undefined,
  };
}

export function getShippoStatus(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  hasApiKey: boolean;
  hasShipFrom: boolean;
  testMode: boolean | null;
  shipFrom: ShippoAddress | null;
} {
  const key = getShippoApiKey(env);
  const shipFrom = getShipFromAddress(env);
  return {
    configured: Boolean(key && shipFrom),
    hasApiKey: Boolean(key),
    hasShipFrom: Boolean(shipFrom),
    testMode: key ? shippoKeyIsTest(key) : null,
    shipFrom,
  };
}

function toShippoAddressPayload(address: ShippoAddress) {
  return {
    name: address.name,
    street1: address.street1,
    street2: address.street2 || "",
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country || "US",
    phone: address.phone || "",
    email: address.email || "",
  };
}

async function shippoRequest(
  path: string,
  init: RequestInit & { apiKey: string },
): Promise<unknown> {
  const { apiKey, ...rest } = init;
  const response = await fetch(`${SHIPPO_API_BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `ShippoToken ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(rest.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { detail: text.slice(0, 400) };
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : typeof body === "object" && body && "messages" in body
          ? JSON.stringify((body as { messages: unknown }).messages)
          : text.slice(0, 400) || response.statusText;
    throw new ShippoError(`Shippo ${response.status}: ${detail}`, response.status);
  }
  return body;
}

export class ShippoError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ShippoError";
    this.status = status;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function mapRate(raw: Record<string, unknown>): ShippoRateOffer | null {
  const objectId = asString(raw.object_id);
  const amount = asString(raw.amount);
  if (!objectId || !amount) return null;
  const servicelevel =
    typeof raw.servicelevel === "object" && raw.servicelevel
      ? (raw.servicelevel as Record<string, unknown>)
      : {};
  const estimated =
    typeof raw.estimated_days === "number" && Number.isFinite(raw.estimated_days)
      ? raw.estimated_days
      : null;
  return {
    objectId,
    amount,
    currency: asString(raw.currency) || "USD",
    provider: asString(raw.provider) || asString(raw.provider_image_75) || "Carrier",
    servicelevelName: asString(servicelevel.name) || asString(raw.servicelevel_name) || "Service",
    servicelevelToken: asString(servicelevel.token) || asString(raw.servicelevel_token) || "",
    estimatedDays: estimated,
    durationTerms: asString(raw.duration_terms),
    attributes: Array.isArray(raw.attributes)
      ? raw.attributes.map((item) => asString(item)).filter(Boolean)
      : [],
  };
}

/** Prefer UPS, then cheapest within each carrier group. */
export function sortShippoRates(rates: ShippoRateOffer[]): ShippoRateOffer[] {
  return [...rates].sort((a, b) => {
    const aUps = /ups/i.test(a.provider) ? 0 : 1;
    const bUps = /ups/i.test(b.provider) ? 0 : 1;
    if (aUps !== bUps) return aUps - bUps;
    const aAmt = Number(a.amount);
    const bAmt = Number(b.amount);
    if (Number.isFinite(aAmt) && Number.isFinite(bAmt) && aAmt !== bAmt) return aAmt - bAmt;
    return a.servicelevelName.localeCompare(b.servicelevelName);
  });
}

export async function createShippoShipmentRates(input: {
  addressFrom: ShippoAddress;
  addressTo: ShippoAddress;
  parcel: ShippoParcel;
  apiKey?: string;
}): Promise<ShippoShipmentResult> {
  const apiKey = input.apiKey ?? getShippoApiKey();
  if (!apiKey) throw new ShippoError("Shippo API key is not configured", 503);

  const body = await shippoRequest("/shipments/", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      address_from: toShippoAddressPayload(input.addressFrom),
      address_to: toShippoAddressPayload(input.addressTo),
      parcels: [
        {
          length: String(input.parcel.lengthIn),
          width: String(input.parcel.widthIn),
          height: String(input.parcel.heightIn),
          distance_unit: "in",
          weight: String(input.parcel.weightOz),
          mass_unit: "oz",
        },
      ],
      async: false,
    }),
  });

  const shipment = (body ?? {}) as Record<string, unknown>;
  const rawRates = Array.isArray(shipment.rates) ? shipment.rates : [];
  const rates = sortShippoRates(
    rawRates
      .map((row) => (row && typeof row === "object" ? mapRate(row as Record<string, unknown>) : null))
      .filter((row): row is ShippoRateOffer => Boolean(row)),
  );
  const messages = Array.isArray(shipment.messages)
    ? shipment.messages
        .map((msg) => {
          if (typeof msg === "string") return msg;
          if (msg && typeof msg === "object" && "text" in msg) return asString((msg as { text: unknown }).text);
          return "";
        })
        .filter(Boolean)
    : [];

  return {
    shipmentId: asString(shipment.object_id),
    rates,
    messages,
    test: Boolean(shipment.test) || shippoKeyIsTest(apiKey),
  };
}

export async function purchaseShippoLabel(input: {
  rateObjectId: string;
  labelFileType?: "PDF" | "PNG" | "PDF_4x6";
  apiKey?: string;
}): Promise<ShippoPurchaseResult> {
  const apiKey = input.apiKey ?? getShippoApiKey();
  if (!apiKey) throw new ShippoError("Shippo API key is not configured", 503);

  const body = await shippoRequest("/transactions/", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      rate: input.rateObjectId,
      label_file_type: input.labelFileType ?? "PDF_4x6",
      async: false,
    }),
  });

  const tx = (body ?? {}) as Record<string, unknown>;
  const status = asString(tx.status) || "UNKNOWN";
  const rate =
    typeof tx.rate === "object" && tx.rate ? (tx.rate as Record<string, unknown>) : null;
  const servicelevel =
    rate && typeof rate.servicelevel === "object" && rate.servicelevel
      ? (rate.servicelevel as Record<string, unknown>)
      : {};
  const messages = Array.isArray(tx.messages)
    ? tx.messages
        .map((msg) => {
          if (typeof msg === "string") return msg;
          if (msg && typeof msg === "object" && "text" in msg) return asString((msg as { text: unknown }).text);
          return "";
        })
        .filter(Boolean)
    : [];

  if (status !== "SUCCESS") {
    throw new ShippoError(
      messages[0] || `Shippo label purchase failed (${status})`,
      502,
    );
  }

  const trackingNumber = asString(tx.tracking_number);
  if (!trackingNumber) {
    throw new ShippoError("Shippo returned a label without a tracking number", 502);
  }

  return {
    transactionId: asString(tx.object_id),
    status,
    trackingNumber,
    trackingUrlProvider: asString(tx.tracking_url_provider) || null,
    labelUrl: asString(tx.label_url) || null,
    amount: asString(rate?.amount) || "",
    currency: asString(rate?.currency) || "USD",
    provider: asString(rate?.provider) || "",
    servicelevelName: asString(servicelevel.name) || asString(rate?.servicelevel_name) || "",
    test: Boolean(tx.test) || shippoKeyIsTest(apiKey),
    messages,
  };
}

export const shippoParcelSchema = z.object({
  lengthIn: z.coerce.number().positive().max(108),
  widthIn: z.coerce.number().positive().max(108),
  heightIn: z.coerce.number().positive().max(108),
  weightOz: z.coerce.number().positive().max(2_400),
});

export const shippoRatesRequestSchema = z.object({
  dealId: z.string().trim().regex(/^[0-9]{1,20}$/, "Select a valid Print Order"),
  parcel: shippoParcelSchema,
  /** Optional override; defaults to SHIP_FROM_* env. */
  addressFrom: z
    .object({
      name: z.string().trim().min(1).max(120),
      street1: z.string().trim().min(1).max(200),
      street2: z.string().trim().max(200).optional().default(""),
      city: z.string().trim().min(1).max(100),
      state: z.string().trim().min(1).max(40),
      zip: z.string().trim().min(3).max(20),
      country: z.string().trim().min(2).max(40).optional().default("US"),
      phone: z.string().trim().max(40).optional().default(""),
      email: z.string().trim().max(200).optional().default(""),
    })
    .optional(),
});

export const shippoPurchaseRequestSchema = z
  .object({
    dealId: z
      .string()
      .trim()
      .regex(/^[0-9]{1,20}$/, "Select a valid Print Order")
      .optional(),
    dealIds: z
      .array(z.string().trim().regex(/^[0-9]{1,20}$/, "Select a valid Print Order"))
      .min(1)
      .max(20)
      .optional(),
    rateObjectId: z.string().trim().min(8).max(80),
    /** Echoed from the rates UI so notes/postage stay accurate if rate lookup drifts. */
    amount: z.string().trim().optional().default(""),
    provider: z.string().trim().max(80).optional().default(""),
    servicelevelName: z.string().trim().max(120).optional().default(""),
    messageChannel: z.enum(["marketplace", "offerup"]).optional().default("marketplace"),
    packingDone: z.boolean().optional().default(true),
    liveWrite: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const ids = [...(value.dealIds ?? []), ...(value.dealId ? [value.dealId] : [])];
    if (ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select at least one Print Order",
        path: ["dealIds"],
      });
    }
  })
  .transform((value) => ({
    dealIds: Array.from(new Set([...(value.dealIds ?? []), ...(value.dealId ? [value.dealId] : [])])),
    rateObjectId: value.rateObjectId,
    amount: value.amount,
    provider: value.provider,
    servicelevelName: value.servicelevelName,
    messageChannel: value.messageChannel,
    packingDone: value.packingDone,
    liveWrite: value.liveWrite,
  }));

export type ShippoRatesRequest = z.infer<typeof shippoRatesRequestSchema>;
export type ShippoPurchaseRequest = z.infer<typeof shippoPurchaseRequestSchema>;

export function contactToShippoAddress(contact: {
  name: string;
  email: string;
  phone: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}): ShippoAddress | null {
  const name = contact.name.trim();
  const street1 = contact.street1.trim();
  const city = contact.city.trim();
  const state = contact.state.trim();
  const zip = contact.zip.trim();
  if (!name || !street1 || !city || !state || !zip) return null;
  return {
    name,
    street1,
    street2: contact.street2.trim() || undefined,
    city,
    state,
    zip,
    country: contact.country.trim() || "US",
    phone: contact.phone.trim() || undefined,
    email: contact.email.trim() || undefined,
  };
}

export function buildShipNotesFromShippo(purchase: {
  provider: string;
  servicelevelName: string;
  amount: string;
  labelUrl?: string | null;
  recipientName?: string | null;
}): string {
  const parts: string[] = [];
  const service = [purchase.provider, purchase.servicelevelName].filter(Boolean).join(" ");
  if (service) parts.push(service);
  if (purchase.amount) parts.push(`Postage $${purchase.amount}`);
  if (purchase.recipientName) parts.push(`Label to ${purchase.recipientName}`);
  if (purchase.labelUrl) parts.push(`Label ${purchase.labelUrl}`);
  return parts.join(" · ").slice(0, 2_000);
}
