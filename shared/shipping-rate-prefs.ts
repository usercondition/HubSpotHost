/**
 * Shop shipping preferences for Print Ops Labels.
 *
 * Derived from Pirate Ship ledger usage (2025–2026 Transactions.xlsx):
 * - 118 labels, mostly $6–$8 postage (small box territory)
 * - Refund tracking samples are mostly UPS (`1Z…`) with occasional USPS (`94…`)
 * - Ledger rows do NOT name the service — only amount + “1 Label Batch”
 *
 * Operator intent: boxes only (miniatures / resin), not envelopes or flats.
 */

export type ShippingRatePrefMode = "usual" | "all";

export type ShippingRateLike = {
  carrierCode: string;
  carrierFriendlyName?: string;
  serviceCode: string;
  serviceType: string;
};

/** Envelope / letter / flat — never useful for boxed resin shipments. */
const ENVELOPE_RE =
  /\b(envelope|letter|postcard|flat(?!\s*rate\s*box)|poly.?mailer|bubble.?mailer)\b/i;

/** Services we almost never buy for shop boxes. */
const NOISE_SERVICE_RE =
  /\b(first[_\s-]?class|media[_\s-]?mail|library[_\s-]?mail|bound[_\s-]?printed|retail[_\s-]?ground|bpm)\b/i;

/**
 * Usual box services for this shop (allowlist).
 * Matches UPS Ground / Ground Saver and USPS Ground Advantage / Priority / Parcel Select.
 */
const USUAL_SERVICE_RE =
  /\b(ups[_\s-]?ground([_\s-]?saver)?|ground[_\s-]?saver|ground[_\s-]?advantage|priority([_\s-]?mail)?(?![_\s-]?express)|parcel[_\s-]?select)\b/i;

/** Express / air — hide in Usual; still available under All. */
const EXPRESS_RE =
  /\b(express|overnight|next[_\s-]?day|2nd[_\s-]?day|2[_\s-]?day|3[_\s-]?day|air(?![_\s-]?mail)|surepost)\b/i;

function haystack(rate: ShippingRateLike): string {
  return [rate.serviceCode, rate.serviceType, rate.carrierCode, rate.carrierFriendlyName ?? ""].join(" ");
}

export function isEnvelopeLikeRate(rate: ShippingRateLike): boolean {
  return ENVELOPE_RE.test(haystack(rate));
}

export function isShopUsualBoxRate(rate: ShippingRateLike): boolean {
  if (isEnvelopeLikeRate(rate)) return false;
  if (NOISE_SERVICE_RE.test(haystack(rate))) return false;
  if (EXPRESS_RE.test(haystack(rate))) return false;
  return USUAL_SERVICE_RE.test(haystack(rate));
}

/** Always drop envelope/letter/flat noise, even in All mode. */
export function isDisplayableBoxRate(rate: ShippingRateLike): boolean {
  return !isEnvelopeLikeRate(rate);
}

export function filterShopShippingRates<T extends ShippingRateLike>(
  rates: T[],
  mode: ShippingRatePrefMode = "usual",
): T[] {
  const boxed = rates.filter(isDisplayableBoxRate);
  if (mode === "all") return boxed;
  const usual = boxed.filter(isShopUsualBoxRate);
  // If ShipEngine naming drifts and nothing matches, fall back to non-envelope list.
  return usual.length > 0 ? usual : boxed;
}
