/**
 * Foolproof address capture shared by the client form and Miguel's paste box.
 * Parsing reuses normalizeShipAddress. Autocomplete stays off unless a provider is enabled.
 */
import {
  countryIsUs,
  normalizeShipAddress,
  type ShipAddressFields,
} from "./ship-address";

export type CaptureStatus = "verified" | "corrected" | "unverified" | "unchecked" | "error";

export type CaptureCheck = {
  status: CaptureStatus;
  needsUnit: boolean;
  typed: ShipAddressFields;
  suggestion: ShipAddressFields | null;
  messages: string[];
};

export type AddressProviderId = "off" | "google-places";

export type AddressProviderStatus = {
  id: AddressProviderId;
  enabled: boolean;
  /** Google Places is restricted to US addresses. */
  country: "US" | null;
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

/** Off unless GOOGLE_PLACES_API_KEY is set. The key itself is never returned. */
export function addressProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AddressProviderStatus {
  const key = env.GOOGLE_PLACES_API_KEY?.trim() ?? "";
  if (!key) return { id: "off", enabled: false, country: null };
  return { id: "google-places", enabled: true, country: "US" };
}
