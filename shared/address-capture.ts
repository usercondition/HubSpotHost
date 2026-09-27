/**
 * Foolproof address capture shared by the client form and Miguel's paste box.
 * Parsing reuses normalizeShipAddress. Autocomplete stays off unless a provider is enabled.
 */
import { z } from "zod";
import {
  countryIsUs,
  normalizeShipAddress,
  type ShipAddressFields,
} from "./ship-address";

export type CaptureStatus = "verified" | "corrected" | "unverified" | "unchecked" | "error";

/** Shown on the customer form when a check cannot verify the address. */
export const CUSTOMER_ADDRESS_CHECK_NOTE =
  "We couldn't verify this address automatically; we'll double-check it before shipping.";

export const HUBSPOT_WRITES_OFF_MESSAGE = "Not written to HubSpot (writes off)";

export type CaptureCheck = {
  status: CaptureStatus;
  needsUnit: boolean;
  typed: ShipAddressFields;
  suggestion: ShipAddressFields | null;
  messages: string[];
  /** When the carrier check ran. Empty when the check did not run. */
  checkedAt?: string | null;
};

const UNIT_LINE = /^(?:apt|apartment|suite|ste|unit|#)\b/i;
const UNIT_HINT = /\b(apt|apartment|suite|unit|secondary|address line 2|missing unit|multi-?unit)\b/i;

export function formatLabelAddress(fields: ShipAddressFields): string {
  const region = [fields.state, fields.zip].filter(Boolean).join(" ");
  const cityLine = [fields.city, region].filter(Boolean).join(", ");
  return [fields.street1, fields.street2, cityLine, fields.country || "US"].filter(Boolean).join("\n");
}

export function addressNeedsUnit(input: {
  street2: string;
  messages: string[];
  matchedStreet2?: string | null;
}): boolean {
  if (input.street2.trim()) return false;
  if (input.matchedStreet2?.trim()) return true;
  return input.messages.some((message) => UNIT_HINT.test(message));
}

function blankAddress(): ShipAddressFields {
  return normalizeShipAddress({}).normalized;
}

/**
 * Turn a Marketplace or Messenger paste into street, unit, city, state, ZIP, and country.
 * A leading name line is dropped when another line contains a street number.
 */
export function parsePastedAddress(text: string): ShipAddressFields {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return blankAddress();
  if (lines.length === 1) {
    return normalizeShipAddress({ street1: lines[0], country: "" }).normalized;
  }

  const body = lines.slice();
  let country = "";
  const last = body[body.length - 1] ?? "";
  if (countryIsUs(last) && last.trim()) {
    country = last;
    body.pop();
  }
  if (body.length === 0) return normalizeShipAddress({ country }).normalized;

  if (body.length >= 2 && !/\d/.test(body[0] ?? "") && body.some((line, index) => index > 0 && /\d/.test(line))) {
    body.shift();
  }

  let street2 = "";
  const unitIndex = body.findIndex((line, index) => index > 0 && UNIT_LINE.test(line));
  if (unitIndex >= 0) {
    street2 = body[unitIndex] ?? "";
    body.splice(unitIndex, 1);
  }

  return normalizeShipAddress({
    street1: body.join(", "),
    street2,
    country,
  }).normalized;
}

export type CaptureResolve =
  | { ok: false; status: 409; code: "needs_unit" | "address_choice"; error: string }
  | {
      ok: true;
      fields: ShipAddressFields;
      storedStatus: CaptureStatus;
      choice: "typed" | "suggested";
    };

/**
 * Decide what may be saved after a ShipEngine check.
 * A corrected address is not saved until the person picks one.
 * A missing unit on a multi-unit building is not saved until they add one or say there is none.
 */
export function resolveCaptureSubmit(input: {
  check: CaptureCheck;
  decision?: string;
  noUnit?: boolean;
}): CaptureResolve {
  const typed = input.check.typed;
  if (input.check.needsUnit && !typed.street2.trim() && input.noUnit !== true) {
    return {
      ok: false,
      status: 409,
      code: "needs_unit",
      error: "This building needs an apartment or unit number.",
    };
  }
  if (input.check.status === "corrected" && input.check.suggestion) {
    if (input.decision !== "accept" && input.decision !== "override") {
      return {
        ok: false,
        status: 409,
        code: "address_choice",
        error: "Pick the standardized address or keep what was typed.",
      };
    }
    if (input.decision === "accept") {
      return { ok: true, fields: input.check.suggestion, storedStatus: "verified", choice: "suggested" };
    }
    return { ok: true, fields: typed, storedStatus: "unverified", choice: "typed" };
  }
  const storedStatus: CaptureStatus =
    input.check.status === "verified"
      ? "verified"
      : input.check.status === "error"
        ? "error"
        : input.check.status === "unchecked"
          ? "unchecked"
          : "unverified";
  return { ok: true, fields: typed, storedStatus, choice: "typed" };
}

const bounded = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);

/** Public validate-address body. Rejects non-strings and over-long fields before any carrier call. */
export const publicAddressFieldsSchema = z.object({
  shippingStreet: bounded(200),
  shippingStreet2: bounded(120).optional().default(""),
  shippingCity: bounded(120),
  shippingState: bounded(120),
  shippingPostalCode: bounded(40),
  shippingCountry: bounded(120),
});

export const CLIENT_ADDRESS_ACK_VERSION = "v1";
export const CLIENT_ADDRESS_ACK_FORM = "client-order";
export const CLIENT_ADDRESS_ACK_TEXT =
  "I confirm my name and shipping address above are correct. Orders ship to exactly this address, and I'm responsible for any errors in what I entered.";

export const SHOP_ADDRESS_FORM_PASTE = "paste";
export const SHOP_ADDRESS_FORM_CLEANUP = "hubspot-cleanup";

export const PRINT_CLIENT_CONFIRMED_ADDRESS_PROPERTY = "print_client_confirmed_address";

export type AddressAckSource = "client" | "shop";

export type AddressAcknowledgment = {
  orderKey: string;
  source: AddressAckSource;
  acknowledgedAt: string;
  snapshot: string;
  textVersion: string;
  formSource: string;
};

/** Exact name, contact, and label address the buyer confirmed. Built on the server. */
export function buildAddressAckSnapshot(input: {
  fullName: string;
  email: string;
  phone: string;
  address: ShipAddressFields;
}): string {
  const lines = [input.fullName.trim()];
  const email = input.email.trim();
  const phone = input.phone.trim();
  if (email) lines.push(email);
  if (phone) lines.push(phone);
  lines.push(formatLabelAddress(input.address));
  return lines.join("\n");
}

/** Value stored on the HubSpot deal when that property is still empty. */
export function formatClientConfirmedProperty(input: {
  acknowledgedAt: string;
  snapshot: string;
  textVersion: string;
  formSource: string;
}): string {
  return [input.acknowledgedAt, input.snapshot, `checkbox ${input.textVersion}`, `form ${input.formSource}`].join("\n");
}

export function formatAckDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  })
    .format(date)
    .replace(/[\u202f\u00a0]/g, " ");
}

/** Small line for the order drawer and the ship-to block. Null when nobody recorded an entry. */
export function formatAddressEntryLabel(
  row: Pick<AddressAcknowledgment, "source" | "acknowledgedAt"> | null | undefined,
): string | null {
  if (!row) return null;
  if (row.source === "shop") return "Entered by shop";
  const date = formatAckDate(row.acknowledgedAt);
  return date ? `Client confirmed name and address on ${date}` : "Client confirmed name and address";
}
