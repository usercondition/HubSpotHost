/**
 * ShipEngine / ShipStation API — rates + label purchase.
 * Token and ship-from come from env only; never log the API key.
 *
 * Auth: `API-Key` header against https://api.shipengine.com
 * Rates need connected carrier_ids (auto-listed, or SHIPENGINE_CARRIER_IDS).
 */
import { z } from "zod";

const SHIPENGINE_API_BASE = "https://api.shipengine.com";

export type ShipEngineAddress = {
  name: string;
  phone?: string;
  email?: string;
  companyName?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  residential?: boolean;
};

export type ShipEngineParcel = {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
};

export type ShipEngineCarrier = {
  carrierId: string;
  carrierCode: string;
  friendlyName: string;
  nickname: string;
};

export type ShipEngineRateOffer = {
  rateId: string;
  amount: string;
  currency: string;
  carrierId: string;
  carrierCode: string;
  carrierFriendlyName: string;
  serviceCode: string;
  serviceType: string;
  deliveryDays: number | null;
  estimatedDeliveryDate: string | null;
  attributes: string[];
};

export type ShipEngineRatesResult = {
  shipmentId: string | null;
  rates: ShipEngineRateOffer[];
  messages: string[];
  testMode: boolean;
};

export type ShipEnginePurchaseResult = {
  labelId: string;
  status: string;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
  amount: string;
  currency: string;
  carrierCode: string;
  serviceCode: string;
  testMode: boolean;
};

function envTrim(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() || "";
}

export function getShipEngineApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    envTrim(env, "CUSTOM_CRED_SHIPENGINE_API_KEY_TOKEN") ||
    envTrim(env, "SHIPENGINE_API_KEY") ||
    ""
  );
}

/** Sandbox keys from ShipEngine start with TEST_ */
export function shipEngineKeyIsTest(token: string): boolean {
  return /^TEST_/i.test(token.trim());
}

export function getShipFromAddress(env: NodeJS.ProcessEnv = process.env): ShipEngineAddress | null {
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
    country: country.length === 2 ? country.toUpperCase() : country === "United States" ? "US" : country,
    phone: envTrim(env, "SHIP_FROM_PHONE") || undefined,
    email: envTrim(env, "SHIP_FROM_EMAIL") || undefined,
    companyName: envTrim(env, "SHIP_FROM_COMPANY") || undefined,
  };
}

/**
 * ShipEngine requires a non-empty phone on ship_from (and usually ship_to).
 * Always use the shop SHIP_FROM_PHONE — never block on missing client phone.
 * If the contact has no phone, reuse the shop number on ship_to.
 */
export function ensureShipEnginePhones(
  addressFrom: ShipEngineAddress,
  addressTo: ShipEngineAddress,
): { addressFrom: ShipEngineAddress; addressTo: ShipEngineAddress } | { error: string } {
  const shopPhone = (addressFrom.phone || "").trim();
  if (!shopPhone) {
    return {
      error:
        "Set SHIP_FROM_PHONE on Railway to your shop phone. ShipEngine requires it on the ship-from address (client phone is optional).",
    };
  }
  const toPhone = (addressTo.phone || "").trim() || shopPhone;
  return {
    addressFrom: { ...addressFrom, phone: shopPhone },
    addressTo: { ...addressTo, phone: toPhone },
  };
}

/** Optional comma-separated carrier ids; empty = auto-list from account. */
export function getConfiguredCarrierIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = envTrim(env, "SHIPENGINE_CARRIER_IDS");
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

export function getShipEngineStatus(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  hasApiKey: boolean;
  hasShipFrom: boolean;
  hasShipFromPhone: boolean;
  testMode: boolean | null;
  shipFrom: ShipEngineAddress | null;
  carrierIdsConfigured: string[];
} {
  const key = getShipEngineApiKey(env);
  const shipFrom = getShipFromAddress(env);
  const hasShipFromPhone = Boolean(shipFrom?.phone?.trim());
  return {
    configured: Boolean(key && shipFrom && hasShipFromPhone),
    hasApiKey: Boolean(key),
    hasShipFrom: Boolean(shipFrom),
    hasShipFromPhone,
    testMode: key ? shipEngineKeyIsTest(key) : null,
    shipFrom,
    carrierIdsConfigured: getConfiguredCarrierIds(env),
  };
}

export class ShipEngineError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ShipEngineError";
    this.status = status;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function moneyAmount(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (value && typeof value === "object" && "amount" in value) {
    const amount = (value as { amount: unknown }).amount;
    if (typeof amount === "number" && Number.isFinite(amount)) return amount.toFixed(2);
    if (typeof amount === "string" && amount.trim()) {
      const n = Number(amount);
      return Number.isFinite(n) ? n.toFixed(2) : amount.trim();
    }
  }
  return "";
}

function moneyCurrency(value: unknown): string {
  if (value && typeof value === "object" && "currency" in value) {
    return asString((value as { currency: unknown }).currency).toUpperCase() || "USD";
  }
  return "USD";
}

function toApiAddress(address: ShipEngineAddress) {
  const phone = (address.phone || "").trim();
  return {
    name: address.name,
    // Always send a string when present — omitting phone makes ShipEngine 400.
    ...(phone ? { phone } : {}),
    email: address.email || undefined,
    company_name: address.companyName || undefined,
    address_line1: address.street1,
    address_line2: address.street2 || undefined,
    city_locality: address.city,
    state_province: address.state,
    postal_code: address.zip,
    country_code: (address.country || "US").slice(0, 2).toUpperCase(),
    address_residential_indicator: address.residential === false ? "no" : "yes",
  };
}

async function shipEngineRequest(
  path: string,
  init: RequestInit & { apiKey: string },
): Promise<unknown> {
  const { apiKey, ...rest } = init;
  const response = await fetch(`${SHIPENGINE_API_BASE}${path}`, {
    ...rest,
    headers: {
      "API-Key": apiKey,
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
    body = { message: text.slice(0, 400) };
  }
  if (!response.ok) {
    const errors =
      typeof body === "object" && body && "errors" in body && Array.isArray((body as { errors: unknown }).errors)
        ? ((body as { errors: Array<{ message?: string }> }).errors)
            .map((err) => asString(err.message))
            .filter(Boolean)
        : [];
    const detail =
      errors[0] ||
      (typeof body === "object" && body && "message" in body
        ? asString((body as { message: unknown }).message)
        : text.slice(0, 400) || response.statusText);
    throw new ShipEngineError(`ShipEngine ${response.status}: ${detail}`, response.status);
  }
  return body;
}

export async function listShipEngineCarriers(apiKey?: string): Promise<ShipEngineCarrier[]> {
  const key = apiKey ?? getShipEngineApiKey();
  if (!key) throw new ShipEngineError("ShipEngine API key is not configured", 503);
  const body = await shipEngineRequest("/v1/carriers", { method: "GET", apiKey: key });
  const carriers = Array.isArray((body as { carriers?: unknown })?.carriers)
    ? ((body as { carriers: unknown[] }).carriers)
    : [];
  return carriers
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const raw = row as Record<string, unknown>;
      const carrierId = asString(raw.carrier_id);
      if (!carrierId) return null;
      return {
        carrierId,
        carrierCode: asString(raw.carrier_code),
        friendlyName: asString(raw.friendly_name) || asString(raw.carrier_code) || carrierId,
        nickname: asString(raw.nickname),
      };
    })
    .filter((row): row is ShipEngineCarrier => Boolean(row));
}

async function resolveCarrierIds(apiKey: string, preferred?: string[]): Promise<string[]> {
  if (preferred && preferred.length > 0) return preferred;
  const configured = getConfiguredCarrierIds();
  if (configured.length > 0) return configured;
  const carriers = await listShipEngineCarriers(apiKey);
  if (carriers.length === 0) {
    throw new ShipEngineError(
      "No ShipEngine carriers connected. Connect UPS/USPS in the ShipStation API dashboard, or set SHIPENGINE_CARRIER_IDS.",
      400,
    );
  }
  // Prefer UPS + USPS when present; otherwise all connected carriers.
  const preferredCodes = carriers.filter((carrier) => /ups|stamps|usps|parcel/i.test(carrier.carrierCode));
  const pick = preferredCodes.length > 0 ? preferredCodes : carriers;
  return pick.map((carrier) => carrier.carrierId);
}

function mapRate(raw: Record<string, unknown>): ShipEngineRateOffer | null {
  const rateId = asString(raw.rate_id);
  const shipping = moneyAmount(raw.shipping_amount);
  const insurance = moneyAmount(raw.insurance_amount);
  const confirmation = moneyAmount(raw.confirmation_amount);
  const other = moneyAmount(raw.other_amount);
  const total =
    [shipping, insurance, confirmation, other]
      .map((part) => Number(part))
      .filter((n) => Number.isFinite(n))
      .reduce((sum, n) => sum + n, 0) || Number(shipping);
  if (!rateId || !Number.isFinite(total)) return null;
  const attributes = Array.isArray(raw.rate_attributes)
    ? raw.rate_attributes.map((item) => asString(item)).filter(Boolean)
    : [];
  const deliveryDays =
    typeof raw.delivery_days === "number" && Number.isFinite(raw.delivery_days)
      ? raw.delivery_days
      : null;
  return {
    rateId,
    amount: total.toFixed(2),
    currency: moneyCurrency(raw.shipping_amount),
    carrierId: asString(raw.carrier_id),
    carrierCode: asString(raw.carrier_code),
    carrierFriendlyName:
      asString(raw.carrier_friendly_name) || asString(raw.carrier_nickname) || asString(raw.carrier_code),
    serviceCode: asString(raw.service_code),
    serviceType: asString(raw.service_type) || asString(raw.service_code),
    deliveryDays,
    estimatedDeliveryDate: asString(raw.estimated_delivery_date) || null,
    attributes,
  };
}

/** UPS first, then cheapest within group. */
export function sortShipEngineRates(rates: ShipEngineRateOffer[]): ShipEngineRateOffer[] {
  return [...rates].sort((a, b) => {
    const aUps = /ups/i.test(a.carrierCode) || /ups/i.test(a.carrierFriendlyName) ? 0 : 1;
    const bUps = /ups/i.test(b.carrierCode) || /ups/i.test(b.carrierFriendlyName) ? 0 : 1;
    if (aUps !== bUps) return aUps - bUps;
    const aAmt = Number(a.amount);
    const bAmt = Number(b.amount);
    if (Number.isFinite(aAmt) && Number.isFinite(bAmt) && aAmt !== bAmt) return aAmt - bAmt;
    return a.serviceType.localeCompare(b.serviceType);
  });
}

export async function createShipEngineRates(input: {
  addressFrom: ShipEngineAddress;
  addressTo: ShipEngineAddress;
  parcel: ShipEngineParcel;
  carrierIds?: string[];
  apiKey?: string;
}): Promise<ShipEngineRatesResult> {
  const apiKey = input.apiKey ?? getShipEngineApiKey();
  if (!apiKey) throw new ShipEngineError("ShipEngine API key is not configured", 503);
  const carrierIds = await resolveCarrierIds(apiKey, input.carrierIds);

  const body = await shipEngineRequest("/v1/rates", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      rate_options: { carrier_ids: carrierIds },
      shipment: {
        validate_address: "no_validation",
        ship_to: toApiAddress(input.addressTo),
        ship_from: toApiAddress({ ...input.addressFrom, residential: false }),
        packages: [
          {
            package_code: "package",
            weight: { value: input.parcel.weightOz, unit: "ounce" },
            dimensions: {
              unit: "inch",
              length: input.parcel.lengthIn,
              width: input.parcel.widthIn,
              height: input.parcel.heightIn,
            },
          },
        ],
      },
    }),
  });

  const root = (body ?? {}) as Record<string, unknown>;
  const rateResponse =
    typeof root.rate_response === "object" && root.rate_response
      ? (root.rate_response as Record<string, unknown>)
      : {};
  const rawRates = Array.isArray(rateResponse.rates) ? rateResponse.rates : [];
  const rates = sortShipEngineRates(
    rawRates
      .map((row) => (row && typeof row === "object" ? mapRate(row as Record<string, unknown>) : null))
      .filter((row): row is ShipEngineRateOffer => Boolean(row)),
  );

  const messages: string[] = [];
  if (Array.isArray(rateResponse.errors)) {
    for (const err of rateResponse.errors) {
      if (err && typeof err === "object" && "message" in err) {
        const msg = asString((err as { message: unknown }).message);
        if (msg) messages.push(msg);
      }
    }
  }
  if (Array.isArray(rateResponse.invalid_rates)) {
    for (const invalid of rateResponse.invalid_rates) {
      if (invalid && typeof invalid === "object") {
        const warnings = Array.isArray((invalid as { error_messages?: unknown }).error_messages)
          ? ((invalid as { error_messages: unknown[] }).error_messages)
          : [];
        for (const warning of warnings) {
          const msg = asString(warning);
          if (msg) messages.push(msg);
        }
      }
    }
  }

  return {
    shipmentId: asString(root.shipment_id) || asString(rateResponse.shipment_id) || null,
    rates,
    messages,
    testMode: shipEngineKeyIsTest(apiKey),
  };
}

export async function purchaseShipEngineLabel(input: {
  rateId: string;
  apiKey?: string;
}): Promise<ShipEnginePurchaseResult> {
  const apiKey = input.apiKey ?? getShipEngineApiKey();
  if (!apiKey) throw new ShipEngineError("ShipEngine API key is not configured", 503);

  const body = await shipEngineRequest(`/v1/labels/rates/${encodeURIComponent(input.rateId)}`, {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      label_format: "pdf",
      label_layout: "4x6",
    }),
  });

  const label = (body ?? {}) as Record<string, unknown>;
  const status = asString(label.status) || "unknown";
  const trackingNumber = asString(label.tracking_number);
  if (!trackingNumber) {
    throw new ShipEngineError(
      status !== "completed"
        ? `ShipEngine label purchase failed (${status})`
        : "ShipEngine returned a label without a tracking number",
      502,
    );
  }

  const download =
    typeof label.label_download === "object" && label.label_download
      ? (label.label_download as Record<string, unknown>)
      : {};
  const shipmentCost = label.shipment_cost;
  const insuranceCost = label.insurance_cost;
  const amountNum =
    (Number(moneyAmount(shipmentCost)) || 0) + (Number(moneyAmount(insuranceCost)) || 0);

  return {
    labelId: asString(label.label_id),
    status,
    trackingNumber,
    trackingUrl: asString(label.tracking_url) || null,
    labelUrl: asString(download.pdf) || asString(download.href) || null,
    amount: amountNum > 0 ? amountNum.toFixed(2) : moneyAmount(shipmentCost),
    currency: moneyCurrency(shipmentCost),
    carrierCode: asString(label.carrier_code),
    serviceCode: asString(label.service_code),
    testMode: shipEngineKeyIsTest(apiKey),
  };
}

export const shipEngineParcelSchema = z.object({
  lengthIn: z.coerce.number().positive().max(108),
  widthIn: z.coerce.number().positive().max(108),
  heightIn: z.coerce.number().positive().max(108),
  weightOz: z.coerce.number().positive().max(2_400),
});

export const shipEngineRatesRequestSchema = z.object({
  dealId: z.string().trim().regex(/^[0-9]{1,20}$/, "Select a valid Print Order"),
  parcel: shipEngineParcelSchema,
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

export const shipEnginePurchaseRequestSchema = z
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
    rateId: z.string().trim().min(4).max(80),
    amount: z.string().trim().optional().default(""),
    carrierCode: z.string().trim().max(80).optional().default(""),
    serviceType: z.string().trim().max(120).optional().default(""),
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
    rateId: value.rateId,
    amount: value.amount,
    carrierCode: value.carrierCode,
    serviceType: value.serviceType,
    messageChannel: value.messageChannel,
    packingDone: value.packingDone,
    liveWrite: value.liveWrite,
  }));

export function contactToShipEngineAddress(contact: {
  name: string;
  email: string;
  phone: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}): ShipEngineAddress | null {
  const name = contact.name.trim();
  const street1 = contact.street1.trim();
  const city = contact.city.trim();
  const state = contact.state.trim();
  const zip = contact.zip.trim();
  if (!name || !street1 || !city || !state || !zip) return null;
  const countryRaw = contact.country.trim() || "US";
  const country =
    countryRaw.length === 2
      ? countryRaw.toUpperCase()
      : /united states|usa/i.test(countryRaw)
        ? "US"
        : countryRaw.slice(0, 2).toUpperCase() || "US";
  return {
    name,
    street1,
    street2: contact.street2.trim() || undefined,
    city,
    state,
    zip,
    country,
    phone: contact.phone.trim() || undefined,
    email: contact.email.trim() || undefined,
    residential: true,
  };
}

export function buildShipNotesFromShipEngine(purchase: {
  carrierCode: string;
  serviceType: string;
  amount: string;
  labelUrl?: string | null;
  recipientName?: string | null;
}): string {
  const parts: string[] = [];
  const service = [purchase.carrierCode, purchase.serviceType].filter(Boolean).join(" ");
  if (service) parts.push(service);
  if (purchase.amount) parts.push(`Postage $${purchase.amount}`);
  if (purchase.recipientName) parts.push(`Label to ${purchase.recipientName}`);
  if (purchase.labelUrl) parts.push(`Label ${purchase.labelUrl}`);
  return parts.join(" · ").slice(0, 2_000);
}
