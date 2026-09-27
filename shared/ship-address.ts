/**
 * Ship-to address readiness for Ready to Ship / Labels.
 * Presence-only (HubSpot contact fields) — never invents addresses.
 * Local pickup skips ship-to entirely.
 */
import { normalizeUsStateProvince, usStateCode, usStateName } from "./us-state";

export type AddressStatus = "ready" | "partial" | "missing" | "pickup" | "unknown";

export type ShipAddressInput = {
  name?: string | null;
  firstName?: string | null;
  street1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  dealName?: string | null;
  /** Fallback when HubSpot first name is empty (deal "Product - Client"). */
  contactNameHint?: string | null;
  /** From intake: false means local pickup — no ship-to needed. */
  shippingRequired?: boolean | null;
  shipPlanNote?: string | null;
};

export type ShipAddressReadiness = {
  addressStatus: AddressStatus;
  /** Compact "City, ST" when both exist; otherwise null. */
  addressSummary: string | null;
  /** Messenger/email chase draft — copy only, never auto-send. */
  chaseDraft: string;
  missingFields: Array<"name" | "street" | "city" | "state" | "zip">;
};

function trim(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/** True when intake or notes say the buyer is picking up (no ship-to). */
export function looksLikePickup(input: {
  shippingRequired?: boolean | null;
  shipPlanNote?: string | null;
  dealName?: string | null;
}): boolean {
  if (input.shippingRequired === false) return true;
  const blob = `${trim(input.shipPlanNote)} ${trim(input.dealName)}`.toLowerCase();
  return /\b(local\s*)?pick[\s-]*up\b/.test(blob) || /\bpickup\b/.test(blob);
}

export function pickupAddressReadiness(): ShipAddressReadiness {
  return {
    addressStatus: "pickup",
    addressSummary: "Local pickup",
    chaseDraft: "",
    missingFields: [],
  };
}

/** Address is fine for labeling / digests (ready ship-to or pickup). */
export function addressIsSatisfied(status: AddressStatus | null | undefined): boolean {
  return status === "ready" || status === "pickup";
}

/**
 * Confirmed ship-to gap. Unknown means the lookup did not finish —
 * do not chase or count it as needing an address.
 */
export function addressNeedsChase(status: string | null | undefined): boolean {
  return status === "missing" || status === "partial";
}

function firstNameFrom(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "there";
  const first = cleaned.split(/\s+/)[0] ?? "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Prefer product title before " - Client" for chase copy. */
export function dealNameForChase(dealName: string | null | undefined): string {
  const cleaned = trim(dealName);
  if (!cleaned) return "print order";
  if (cleaned.includes(" - ")) {
    const product = cleaned.slice(0, cleaned.lastIndexOf(" - ")).trim();
    if (product) return product;
  }
  return cleaned;
}

export function draftAddressChaseMessage(input: {
  firstName?: string | null;
  name?: string | null;
  contactNameHint?: string | null;
  dealName?: string | null;
}): string {
  const who =
    firstNameFrom(input.firstName) !== "there"
      ? firstNameFrom(input.firstName)
      : firstNameFrom(input.name) !== "there"
        ? firstNameFrom(input.name)
        : firstNameFrom(
            input.contactNameHint && String(input.contactNameHint).includes(" - ")
              ? String(input.contactNameHint).slice(String(input.contactNameHint).lastIndexOf(" - ") + 3)
              : input.contactNameHint,
          );
  const order = dealNameForChase(input.dealName);
  return `Hey ${who} — your ${order} is ready to ship. Can you confirm the best address to send it to?`;
}

/**
 * Derive ready / partial / missing from HubSpot-shaped ship-to fields.
 * Aligns with ShipEngine label buy gates (name + street + city + state + zip).
 * Optional `stateOk` lets the server reject unnormalizable US states as partial.
 */
export function deriveShipAddressReadiness(
  input: ShipAddressInput,
  options?: { stateOk?: boolean },
): ShipAddressReadiness {
  if (looksLikePickup(input)) {
    return pickupAddressReadiness();
  }

  const name = trim(input.name);
  const street1 = trim(input.street1);
  const city = trim(input.city);
  const state = trim(input.state);
  const zip = trim(input.zip);

  const missingFields: ShipAddressReadiness["missingFields"] = [];
  if (!name) missingFields.push("name");
  if (!street1) missingFields.push("street");
  if (!city) missingFields.push("city");
  if (!state) missingFields.push("state");
  if (!zip) missingFields.push("zip");

  const hasAnyAddress = Boolean(street1 || city || zip || state);
  const stateOk = options?.stateOk !== false;
  let addressStatus: AddressStatus;
  if (missingFields.length === 0 && stateOk) {
    addressStatus = "ready";
  } else if (!hasAnyAddress && !name) {
    addressStatus = "missing";
  } else if (!hasAnyAddress) {
    // Name only — still no usable ship-to.
    addressStatus = "missing";
  } else {
    addressStatus = "partial";
  }

  const addressSummary =
    city && state ? `${city}, ${state}` : city || state || null;

  return {
    addressStatus,
    addressSummary,
    chaseDraft: draftAddressChaseMessage({
      firstName: input.firstName,
      name,
      contactNameHint: input.contactNameHint ?? input.dealName,
      dealName: input.dealName,
    }),
    missingFields,
  };
}

/**
 * A live ship-to wins over the queue pill.
 * ready:false must not keep a cached "ready" label.
 * liveReady null means the live read has not arrived.
 */
export function addressStatusWithLiveShipTo(
  queueStatus: AddressStatus | null | undefined,
  liveReady: boolean | null,
): AddressStatus {
  if (queueStatus === "pickup") return "pickup";
  if (liveReady === false) {
    return queueStatus && queueStatus !== "ready" ? queueStatus : "partial";
  }
  if (liveReady === true) return "ready";
  return queueStatus ?? "unknown";
}

export function addressStatusPill(status: AddressStatus): {
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
} {
  switch (status) {
    case "ready":
      return { label: "Address ready", tone: "good" };
    case "pickup":
      return { label: "Pickup", tone: "good" };
    case "partial":
      return { label: "Address partial", tone: "warn" };
    case "unknown":
      return { label: "Address unchecked", tone: "neutral" };
    default:
      return { label: "Needs address", tone: "bad" };
  }
}

export type ShipAddressField = "street1" | "street2" | "city" | "state" | "zip" | "country";

export type ShipAddressFields = Record<ShipAddressField, string>;

export type ShipAddressChange = {
  field: ShipAddressField;
  from: string;
  to: string;
};

/** Original HubSpot (or form) values beside the cleaned label address. */
export type NormalizedShipAddress = {
  original: ShipAddressFields;
  normalized: ShipAddressFields;
  changed: boolean;
  changes: ShipAddressChange[];
};

function tidyCommas(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

function letterCase(value: string): "lower" | "upper" | "mixed" | "none" {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (!letters) return "none";
  if (letters === letters.toLowerCase()) return "lower";
  if (letters === letters.toUpperCase()) return "upper";
  return "mixed";
}

function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** City and state: fix all-lower and all-upper. Mixed casing stays. */
function normalizePlaceCase(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const casing = letterCase(cleaned);
  if (casing === "lower" || casing === "upper") return titleCase(cleaned);
  return cleaned;
}

/** Street keeps its own casing unless the letters are entirely lowercase. */
function normalizeStreet(value: string): string {
  const cleaned = tidyCommas(value);
  if (!cleaned) return "";
  if (letterCase(cleaned) === "lower") return titleCase(cleaned);
  return cleaned;
}

function normalizeZip(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(\d{5})(?:[-\s]?(\d{4}))?$/);
  if (match) return match[2] ? `${match[1]}-${match[2]}` : match[1]!;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return trimmed.replace(/\s+/g, " ");
}

function normalizeCountry(raw: string): string {
  const cleaned = raw.replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "US";
  const key = cleaned.toLowerCase();
  if (key === "us" || key === "usa" || key === "united states" || key === "united states of america") {
    return "US";
  }
  if (/^[a-z]{2}$/i.test(cleaned)) return cleaned.toUpperCase();
  return normalizePlaceCase(cleaned);
}

function countryToken(value: string): string {
  return value.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
}

function isUsCountryToken(token: string): boolean {
  return token === "us" || token === "usa" || token === "united states" || token === "united states of america";
}

function stripDuplicateLocality(street: string, fields: ShipAddressFields): string {
  const parts = tidyCommas(street).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";

  const city = fields.city.trim().toLowerCase();
  const stateCodes = new Set<string>();
  const stateNames = new Set<string>();
  const code = usStateCode(fields.state);
  if (code) {
    stateCodes.add(code.toLowerCase());
    const name = usStateName(code);
    if (name) stateNames.add(name);
  }
  const rawState = fields.state.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (rawState) stateNames.add(rawState);

  const zipDigits = fields.zip.replace(/\D/g, "");
  const zip5 = zipDigits.slice(0, 5);
  const countryKey = countryToken(fields.country);
  const countryIsUs = !countryKey || isUsCountryToken(countryKey);

  const isDuplicate = (part: string): boolean => {
    const token = countryToken(part);
    if (!token) return true;
    if (city && token === city) return true;
    if (stateCodes.has(token) || stateNames.has(token)) return true;
    if (countryIsUs && isUsCountryToken(token)) return true;
    if (!countryIsUs && countryKey && token === countryKey) return true;
    const digits = part.replace(/\D/g, "");
    if (zip5 && (digits === zip5 || digits === zipDigits) && /^[\d\s-]+$/.test(part.trim())) return true;
    if (zip5 && digits.endsWith(zip5)) {
      const without = token.replace(zip5, "").replace(/[-\s]+/g, " ").trim();
      if (!without) return true;
      if (stateCodes.has(without) || stateNames.has(without)) return true;
      if (city && (without === city || without.startsWith(`${city} `))) {
        const rest = without === city ? "" : without.slice(city.length).trim();
        if (!rest || stateCodes.has(rest) || stateNames.has(rest)) return true;
      }
    }
    return false;
  };

  const kept = [parts[0]!];
  for (const part of parts.slice(1)) {
    if (!isDuplicate(part)) kept.push(part);
  }
  return tidyCommas(kept.join(", "));
}

function splitCombinedStreet(street: string): { street1: string; city: string; state: string; zip: string } | null {
  const parts = tidyCommas(street).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const rest = parts.slice();
  while (rest.length > 1 && isUsCountryToken(countryToken(rest[rest.length - 1]!))) {
    rest.pop();
  }
  if (rest.length < 2) return null;

  const tail = rest[rest.length - 1]!;
  const zipMatch = tail.match(/^(.*?)(\d{5})(?:[-\s]?(\d{4}))?\s*$/);
  if (!zipMatch) return null;
  const zip = zipMatch[3] ? `${zipMatch[2]}-${zipMatch[3]}` : zipMatch[2]!;
  const before = (zipMatch[1] ?? "").trim().replace(/[,\s]+$/g, "");
  rest.pop();

  let state = "";
  let city = "";
  if (before) {
    const bits = before.split(/\s+/).filter(Boolean);
    const twoWord = bits.length >= 2 ? usStateCode(bits.slice(-2).join(" ")) : null;
    const oneWord = usStateCode(bits[bits.length - 1] ?? "");
    if (bits.length >= 3 && twoWord) {
      state = twoWord;
      city = bits.slice(0, -2).join(" ");
    } else if (bits.length >= 2 && oneWord && !usStateCode(before)) {
      state = oneWord;
      city = bits.slice(0, -1).join(" ");
    } else if (usStateCode(before)) {
      state = usStateCode(before)!;
    } else {
      return null;
    }
  }

  if (!state && rest.length > 1) {
    const maybe = rest[rest.length - 1]!;
    const code = usStateCode(maybe);
    if (code) {
      state = code;
      rest.pop();
    }
  }
  if (!city && rest.length > 1) {
    const maybeCity = rest[rest.length - 1]!;
    if (!/\d/.test(maybeCity)) {
      city = maybeCity;
      rest.pop();
    }
  }
  if (!rest.length || !city || !state || !zip || /\d/.test(city)) return null;
  return { street1: rest.join(", "), city, state, zip };
}

function snapshotAddress(input: Partial<ShipAddressFields>): ShipAddressFields {
  return {
    street1: trim(input.street1),
    street2: trim(input.street2),
    city: trim(input.city),
    state: trim(input.state),
    zip: trim(input.zip),
    country: trim(input.country),
  };
}

/**
 * Clean a ship-to for labels without writing HubSpot.
 * Strips a repeated city/state/ZIP off the street, splits a combined line when
 * the separate fields are blank, and normalizes state, ZIP, city, and country.
 */
export function normalizeShipAddress(input: Partial<ShipAddressFields>): NormalizedShipAddress {
  const original = snapshotAddress(input);
  const country = normalizeCountry(original.country);
  let street1 = tidyCommas(original.street1);
  const street2 = normalizeStreet(original.street2);
  let city = original.city;
  let state = original.state;
  let zip = original.zip;

  const separateFieldsBlank = !original.city && !original.state && !original.zip;
  if (separateFieldsBlank) {
    const split = splitCombinedStreet(street1);
    if (split) {
      street1 = split.street1;
      city = split.city;
      state = split.state;
      zip = split.zip;
    }
  } else {
    street1 = stripDuplicateLocality(street1, original);
  }

  street1 = normalizeStreet(street1);
  city = normalizePlaceCase(city);
  state = country === "US" ? normalizeUsStateProvince(state) : normalizePlaceCase(state);
  zip = normalizeZip(zip);

  const normalized: ShipAddressFields = { street1, street2, city, state, zip, country };
  const changes: ShipAddressChange[] = [];
  const fields: ShipAddressField[] = ["street1", "street2", "city", "state", "zip", "country"];
  for (const field of fields) {
    if (field === "country" && !original.country) continue;
    if (original[field] !== normalized[field]) {
      changes.push({ field, from: original[field], to: normalized[field] });
    }
  }
  return { original, normalized, changed: changes.length > 0, changes };
}
