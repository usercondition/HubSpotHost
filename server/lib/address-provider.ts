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

type NewAddressComponent = {
  longText?: string;
  shortText?: string;
  long_name?: string;
  short_name?: string;
  types?: string[];
};

function asLegacyComponent(part: NewAddressComponent): AddressComponent {
  return {
    long_name: part.longText ?? part.long_name,
    short_name: part.shortText ?? part.short_name,
    types: part.types,
  };
}

/**
 * Places API (New) autocomplete, restricted to US addresses.
 * A session token groups the autocomplete call and the following details call.
 * Failures return an empty list so the form still works by hand.
 * The API key is sent as a header and is never included in thrown errors.
 */
export async function suggestGooglePlaces(
  query: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
  sessionToken = "",
): Promise<AddressSuggestion[]> {
  const key = apiKey.trim();
  const cleaned = query.trim().replace(/\s+/g, " ").slice(0, 160);
  const session = sessionToken.trim();
  if (!key || cleaned.length < 3 || !session) return [];

  try {
    const autoResponse = await fetchImpl("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
      },
      body: JSON.stringify({
        input: cleaned,
        includedRegionCodes: ["us"],
        sessionToken: session,
        languageCode: "en",
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!autoResponse.ok) return [];
    const autoBody = (await autoResponse.json()) as {
      suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }>;
    };
    const predictions = Array.isArray(autoBody.suggestions) ? autoBody.suggestions.slice(0, 5) : [];
    const suggestions: AddressSuggestion[] = [];
    for (const prediction of predictions) {
      const placeId = typeof prediction.placePrediction?.placeId === "string" ? prediction.placePrediction.placeId : "";
      if (!placeId) continue;
      const detailUrl = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
      detailUrl.searchParams.set("sessionToken", session);
      const detailResponse = await fetchImpl(detailUrl, {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "formattedAddress,addressComponents",
        },
        signal: AbortSignal.timeout(6_000),
      });
      if (!detailResponse.ok) continue;
      const detailBody = (await detailResponse.json()) as {
        formattedAddress?: string;
        addressComponents?: NewAddressComponent[];
      };
      const suggestion = suggestionFromPlaceDetails({
        placeId,
        formatted: detailBody.formattedAddress || prediction.placePrediction?.text?.text,
        components: (detailBody.addressComponents ?? []).map(asLegacyComponent),
      });
      if (suggestion) suggestions.push(suggestion);
    }
    return suggestions;
  } catch {
    return [];
  }
}

export async function suggestFromProvider(
  query: string,
  env: NodeJS.ProcessEnv = process.env,
  sessionToken = "",
): Promise<AddressSuggestion[]> {
  const status = addressProviderStatus(env);
  if (!status.enabled) return [];
  const key = env.GOOGLE_PLACES_API_KEY?.trim() ?? "";
  return suggestGooglePlaces(query, key, fetch, sessionToken);
}
