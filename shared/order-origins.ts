/**
 * Where orders ship, aggregated to state and ZIP/city centroid.
 * Street addresses are never accepted or returned.
 * Pickup is the shop's local marker (San Diego), not a guessed customer address.
 */
import { usStateCode } from "./us-state";

/** Designated shop city for local pickup. Not derived from a customer street. */
export const LOCAL_PICKUP = {
  label: "Local pickup",
  city: "San Diego",
  state: "CA",
  lat: 32.7157,
  lon: -117.1611,
} as const;

export type ShipToFields = {
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

export type ZipCentroid = {
  city: string;
  state: string;
  lat: number;
  lon: number;
};

export type ZipIndex = {
  byZip: Map<string, ZipCentroid>;
  byCity: Map<string, ZipCentroid>;
};

export type OriginOrderInput = {
  id: string;
  amount: number | null;
  createdAt: string | null;
  pickup: boolean;
  shipTo: ShipToFields | null;
};

export type OriginTotals = {
  orders: number;
  revenue: number;
  priced: number;
};

export type OriginPlace = OriginTotals & {
  id: string;
  label: string;
  state: string;
  lat: number;
  lon: number;
};

export type OriginState = OriginTotals & { code: string };
export type OriginCountry = OriginTotals & { name: string; plotName: string | null };

export type OriginOrderRow = {
  id: string;
  amount: number | null;
  state: string | null;
  country: string | null;
  placeId: string | null;
  pickup: boolean;
};

export type OrderOrigins = {
  incomplete?: boolean;
  unknown: number;
  pickup: OriginTotals;
  states: OriginState[];
  places: OriginPlace[];
  countries: OriginCountry[];
  outsideUs: boolean;
  orders: OriginOrderRow[];
};

type Window = { start: number | null; end: number };

const US_COUNTRY = new Set([
  "us",
  "usa",
  "u.s",
  "u.s.a",
  "united states",
  "united states of america",
]);

/** Atlas country name for a stored country, when it is the same country. */
const COUNTRY_ALIAS: Record<string, string> = {
  uk: "United Kingdom",
  gb: "United Kingdom",
  "great britain": "United Kingdom",
  "united kingdom": "United Kingdom",
  canada: "Canada",
  ca: "Canada",
  australia: "Australia",
  au: "Australia",
  germany: "Germany",
  de: "Germany",
  france: "France",
  fr: "France",
  mexico: "Mexico",
  mx: "Mexico",
  "new zealand": "New Zealand",
  nz: "New Zealand",
  ireland: "Ireland",
  ie: "Ireland",
  netherlands: "Netherlands",
  nl: "Netherlands",
  japan: "Japan",
  jp: "Japan",
  "south korea": "South Korea",
  korea: "South Korea",
  kr: "South Korea",
  china: "China",
  cn: "China",
  italy: "Italy",
  it: "Italy",
  spain: "Spain",
  es: "Spain",
  brazil: "Brazil",
  br: "Brazil",
  sweden: "Sweden",
  se: "Sweden",
  norway: "Norway",
  no: "Norway",
};

const ATLAS_NAMES = new Set(Object.values(COUNTRY_ALIAS));

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function blank(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function zip5(value: string | null | undefined): string | null {
  const digits = blank(value).replace(/\s/g, "");
  const match = /^(\d{5})(?:-\d{4})?$/.exec(digits);
  return match?.[1] ?? null;
}

function countryKey(value: string | null | undefined): string {
  return blank(value).toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

export function isUsCountry(value: string | null | undefined): boolean {
  const key = countryKey(value);
  return key === "" || US_COUNTRY.has(key);
}

export function plotCountryName(value: string | null | undefined): string | null {
  const key = countryKey(value);
  if (!key || US_COUNTRY.has(key)) return null;
  return COUNTRY_ALIAS[key] ?? (ATLAS_NAMES.has(blank(value)) ? blank(value) : null);
}

function cityKey(city: string, state: string): string {
  return `${city.toLowerCase().replace(/\s+/g, " ").trim()}|${state}`;
}

export function indexZipRows(rows: Array<[string, string, string, number, number]>): ZipIndex {
  const byZip = new Map<string, ZipCentroid>();
  const cityBuckets = new Map<string, { city: string; state: string; lat: number; lon: number; n: number }>();
  for (const [zip, city, state, lat, lon] of rows) {
    const code = zip5(zip);
    const stateCode = usStateCode(state);
    if (!code || !stateCode || byZip.has(code)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const place = city.trim();
    byZip.set(code, { city: place, state: stateCode, lat, lon });
    const key = cityKey(place, stateCode);
    const bucket = cityBuckets.get(key) ?? { city: place, state: stateCode, lat: 0, lon: 0, n: 0 };
    bucket.lat += lat;
    bucket.lon += lon;
    bucket.n += 1;
    cityBuckets.set(key, bucket);
  }
  const byCity = new Map<string, ZipCentroid>();
  for (const [key, bucket] of Array.from(cityBuckets.entries())) {
    byCity.set(key, {
      city: bucket.city,
      state: bucket.state,
      lat: round2(bucket.lat / bucket.n),
      lon: round2(bucket.lon / bucket.n),
    });
  }
  return { byZip, byCity };
}

function inWindow(createdAt: string | null, window: Window): boolean {
  if (!createdAt) return false;
  const time = new Date(createdAt).getTime();
  if (!Number.isFinite(time)) return false;
  if (window.start != null && time < window.start) return false;
  return time <= window.end;
}

function addTotals(row: OriginTotals, amount: number | null) {
  row.orders += 1;
  if (amount != null) {
    row.revenue = round2(row.revenue + amount);
    row.priced += 1;
  }
}

function emptyTotals(): OriginTotals {
  return { orders: 0, revenue: 0, priced: 0 };
}

export function buildOrderOrigins(input: {
  orders: OriginOrderInput[];
  start: number | null;
  end: number;
  zips: ZipIndex;
}): OrderOrigins {
  const window = { start: input.start, end: input.end };
  const pickup = emptyTotals();
  const states = new Map<string, OriginState>();
  const places = new Map<string, OriginPlace>();
  const countries = new Map<string, OriginCountry>();
  const orders: OriginOrderRow[] = [];
  let unknown = 0;

  for (const order of input.orders) {
    if (!inWindow(order.createdAt, window)) continue;
    if (order.pickup) {
      addTotals(pickup, order.amount);
      orders.push({
        id: order.id,
        amount: order.amount,
        state: null,
        country: null,
        placeId: "pickup",
        pickup: true,
      });
      continue;
    }

    const ship = order.shipTo;
    const country = blank(ship?.country);
    if (country && !isUsCountry(country)) {
      const plotName = plotCountryName(country);
      const name = plotName ?? country;
      const row = countries.get(name) ?? { name, plotName, ...emptyTotals() };
      addTotals(row, order.amount);
      countries.set(name, row);
      orders.push({
        id: order.id,
        amount: order.amount,
        state: null,
        country: name,
        placeId: null,
        pickup: false,
      });
      continue;
    }

    const zip = zip5(ship?.zip);
    const zipHit = zip ? input.zips.byZip.get(zip) : undefined;
    const state = zipHit?.state ?? usStateCode(ship?.state);
    const cityName = blank(ship?.city);
    const cityHit = !zipHit && state && cityName ? input.zips.byCity.get(cityKey(cityName, state)) : undefined;
    const centroid = zipHit ?? cityHit;
    if (!state && !centroid) {
      unknown += 1;
      orders.push({
        id: order.id,
        amount: order.amount,
        state: null,
        country: null,
        placeId: null,
        pickup: false,
      });
      continue;
    }

    const stateCode = centroid?.state ?? state!;
    const stateRow = states.get(stateCode) ?? { code: stateCode, ...emptyTotals() };
    addTotals(stateRow, order.amount);
    states.set(stateCode, stateRow);

    let placeId: string | null = null;
    if (centroid) {
      placeId = zipHit ? `zip:${zip}` : `city:${cityKey(centroid.city, centroid.state)}`;
      const place = places.get(placeId) ?? {
        id: placeId,
        label: `${centroid.city}, ${centroid.state}`,
        state: centroid.state,
        lat: centroid.lat,
        lon: centroid.lon,
        ...emptyTotals(),
      };
      addTotals(place, order.amount);
      places.set(placeId, place);
    }

    orders.push({
      id: order.id,
      amount: order.amount,
      state: stateCode,
      country: null,
      placeId,
      pickup: false,
    });
  }

  const sortTotals = (a: OriginTotals, b: OriginTotals) => b.orders - a.orders || b.revenue - a.revenue;
  return {
    unknown,
    pickup,
    states: Array.from(states.values()).sort(sortTotals),
    places: Array.from(places.values()).sort(sortTotals),
    countries: Array.from(countries.values()).sort(sortTotals),
    outsideUs: countries.size > 0,
    orders,
  };
}

export function averageOrder(row: OriginTotals): number | null {
  if (row.priced <= 0) return null;
  return round2(row.revenue / row.priced);
}
