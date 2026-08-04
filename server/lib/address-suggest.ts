/**
 * Address autocomplete suggestions for the public buyer form.
 * Proxies Photon (OpenStreetMap) so no client-side API key is required.
 */

export type AddressSuggestion = {
  id: string;
  label: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

type PhotonFeature = {
  properties?: Record<string, unknown>;
  geometry?: { coordinates?: unknown };
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildStreet(props: Record<string, unknown>): string {
  const number = asText(props.housenumber);
  const street = asText(props.street) || asText(props.name);
  if (number && street && !street.startsWith(number)) return `${number} ${street}`.trim();
  return street || number;
}

function buildCity(props: Record<string, unknown>): string {
  return (
    asText(props.city) ||
    asText(props.town) ||
    asText(props.village) ||
    asText(props.municipality) ||
    asText(props.district) ||
    asText(props.county)
  );
}

function buildLabel(parts: AddressSuggestion): string {
  return [parts.street, parts.city, parts.state, parts.postalCode, parts.country]
    .filter(Boolean)
    .join(", ");
}

export function normalizePhotonFeatures(features: unknown[]): AddressSuggestion[] {
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < features.length; index += 1) {
    const raw = features[index];
    if (!raw || typeof raw !== "object") continue;
    const feature = raw as PhotonFeature;
    const props = feature.properties && typeof feature.properties === "object" ? feature.properties : {};
    const street = buildStreet(props);
    const city = buildCity(props);
    const state = asText(props.state);
    const postalCode = asText(props.postcode);
    const country = asText(props.country);
    if (!street && !city) continue;

    const suggestion: AddressSuggestion = {
      id: `${street}|${city}|${state}|${postalCode}|${country}|${index}`,
      label: "",
      street,
      city,
      state,
      postalCode,
      country,
    };
    suggestion.label = buildLabel(suggestion);
    if (!suggestion.label || seen.has(suggestion.label)) continue;
    seen.add(suggestion.label);
    out.push(suggestion);
    if (out.length >= 8) break;
  }

  return out;
}

/**
 * Query Photon for address-like suggestions. Failures return an empty list so
 * the buyer form still works with manual typing.
 */
export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const cleaned = query.trim().replace(/\s+/g, " ").slice(0, 160);
  if (cleaned.length < 3) return [];

  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", cleaned);
  url.searchParams.set("limit", "8");
  // Bias toward common Marketplace shipping destinations without hard-locking.
  url.searchParams.set("lang", "en");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "HubSpotHost-PrintOrders/1.0 (address-suggest)",
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) return [];

  const data = (await response.json()) as { features?: unknown };
  const features = Array.isArray(data.features) ? data.features : [];
  return normalizePhotonFeatures(features);
}
