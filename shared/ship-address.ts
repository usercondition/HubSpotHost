/**
 * Ship-to address readiness for Ready to Ship / Labels.
 * Presence-only (HubSpot contact fields) — never invents addresses.
 * Local pickup skips ship-to entirely.
 */

export type AddressStatus = "ready" | "partial" | "missing" | "pickup";

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

export function addressStatusPill(status: AddressStatus): {
  label: string;
  tone: "good" | "warn" | "bad";
} {
  switch (status) {
    case "ready":
      return { label: "Address ready", tone: "good" };
    case "pickup":
      return { label: "Pickup", tone: "good" };
    case "partial":
      return { label: "Address partial", tone: "warn" };
    default:
      return { label: "Needs address", tone: "bad" };
  }
}
