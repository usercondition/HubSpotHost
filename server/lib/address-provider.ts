/**
 * Address autocomplete providers. Off by default.
 * Google Places runs only when GOOGLE_PLACES_API_KEY is set, and only for US addresses.
 */
import type { AddressSuggestion } from "./address-suggest";
import { addressProviderFromEnv, type AddressProviderStatus } from "../../shared/address-capture";

type AddressComponent = { long_name?: string; short_name?: string; types?: string[] };

export function addressProviderStatus(env: NodeJS.ProcessEnv = process.env): AddressProviderStatus {
  return addressProviderFromEnv(env);
}

function component(parts: AddressComponent[], type: string, form: "short" | "long" = "long"): string {
  const match = parts.find((part) => Array.isArray(part.types) && part.types.includes(type));
  if (!match) return "";
  const value = form === "short" ? match.short_name : match.long_name;
  return typeof value === "string" ? value.trim() : "";
}

/** Map a Place Details result into split fields. Non-US results are dropped. */
export function suggestionFromPlaceDetails(input: {
  placeId: string;
  formatted?: string;
  components?: AddressComponent[];
}): AddressSuggestion | null {
  const parts = input.components ?? [];
  const country = component(parts, "country", "short").toUpperCase();
  if (country && country !== "US") return null;
  const number = component(parts, "street_number");
  const route = component(parts, "route");
  const street = [number, route].filter(Boolean).join(" ").trim();
  const city =
    component(parts, "locality") ||
    component(parts, "postal_town") ||
    component(parts, "sublocality") ||
    component(parts, "neighborhood");
  const state = component(parts, "administrative_area_level_1", "short");
  const postalCode = component(parts, "postal_code");
  if (!street && !city) return null;
  const suggestion: AddressSuggestion = {
    id: input.placeId || `${street}|${city}|${state}|${postalCode}`,
    label: "",
    street,
    city,
    state,
    postalCode,
    country: "US",
  };
  suggestion.label =
    input.formatted?.trim() ||
    [suggestion.street, suggestion.city, suggestion.state, suggestion.postalCode, "US"].filter(Boolean).join(", ");
  return suggestion;
}

type FetchLike = typeof fetch;

/**
 * Places Autocomplete restricted to US addresses.
 * Failures return an empty list so the form still works by hand.
 * The API key is never included in thrown errors.
 */
export async function suggestGooglePlaces(
  query: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<AddressSuggestion[]> {
  const key = apiKey.trim();
  const cleaned = query.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!key || cleaned.length < 3) return [];

  try {
    const autoUrl = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    autoUrl.searchParams.set("input", cleaned);
    autoUrl.searchParams.set("types", "address");
    autoUrl.searchParams.set("components", "country:us");
    autoUrl.searchParams.set("key", key);
    const autoResponse = await fetchImpl(autoUrl, { signal: AbortSignal.timeout(6_000) });
    if (!autoResponse.ok) return [];
    const autoBody = (await autoResponse.json()) as { predictions?: Array<{ place_id?: string; description?: string }> };
    const predictions = Array.isArray(autoBody.predictions) ? autoBody.predictions.slice(0, 5) : [];
    const suggestions: AddressSuggestion[] = [];
    for (const prediction of predictions) {
      const placeId = typeof prediction.place_id === "string" ? prediction.place_id : "";
      if (!placeId) continue;
      const detailUrl = new URL("https://maps.googleapis.com/maps/api/place/details/json");
      detailUrl.searchParams.set("place_id", placeId);
      detailUrl.searchParams.set("fields", "address_component,formatted_address");
      detailUrl.searchParams.set("key", key);
      const detailResponse = await fetchImpl(detailUrl, { signal: AbortSignal.timeout(6_000) });
      if (!detailResponse.ok) continue;
      const detailBody = (await detailResponse.json()) as {
        result?: { formatted_address?: string; address_components?: AddressComponent[] };
      };
      const suggestion = suggestionFromPlaceDetails({
        placeId,
        formatted: detailBody.result?.formatted_address || prediction.description,
        components: detailBody.result?.address_components,
      });
      if (suggestion) suggestions.push(suggestion);
    }
    return suggestions;
  } catch {
    return [];
  }
}

export async function suggestFromProvider(query: string, env: NodeJS.ProcessEnv = process.env): Promise<AddressSuggestion[]> {
  const status = addressProviderStatus(env);
  if (!status.enabled) return [];
  const key = env.GOOGLE_PLACES_API_KEY?.trim() ?? "";
  return suggestGooglePlaces(query, key);
}
