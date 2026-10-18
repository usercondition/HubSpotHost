/**
 * Market check for the STL Quote tool: live Etsy / eBay listing prices for a
 * search term. Never fabricates comps — when a source is blocked or not
 * configured it reports that state instead.
 *
 * Reliable (free) access needs credentials in env:
 * - eBay Browse API: EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (developer app keyset,
 *   OAuth client-credentials, scope https://api.ebay.com/oauth/api_scope).
 * - Etsy Open API v3: ETSY_API_KEY (app keystring; Etsy may require
 *   "keystring:shared_secret" as the x-api-key value).
 * Without them we try the public search HTML once; both sites usually answer
 * 403 to datacenter IPs (verified from the agent box 2026-10-17).
 */
import type { MarketCheckResult, MarketComp, MarketSourceStatus } from "../../shared/stl-quote";
import { marketStats } from "../../shared/stl-quote";

type Fetch = typeof fetch;
const TIMEOUT_MS = 9000;
const MAX_COMPS = 40;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

async function timed(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

let ebayToken: { value: string; expires: number } | null = null;

async function ebayApi(q: string, env: NodeJS.ProcessEnv, f: Fetch): Promise<{ comps: MarketComp[]; status: MarketSourceStatus }> {
  const id = env.EBAY_CLIENT_ID?.trim();
  const secret = env.EBAY_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("not-configured");
  if (!ebayToken || ebayToken.expires < Date.now() + 60_000) {
    const res = await timed(f, "https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    });
    if (!res.ok) return { comps: [], status: { source: "eBay", status: "error", method: "api", detail: `eBay OAuth ${res.status}` } };
    const j = (await res.json()) as { access_token: string; expires_in: number };
    ebayToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  }
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=${MAX_COMPS}&filter=${encodeURIComponent("priceCurrency:USD,buyingOptions:{FIXED_PRICE}")}`;
  const res = await timed(f, url, { headers: { Authorization: `Bearer ${ebayToken.value}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  if (!res.ok) return { comps: [], status: { source: "eBay", status: "error", method: "api", detail: `eBay Browse ${res.status}` } };
  const j = (await res.json()) as { itemSummaries?: Array<{ title?: string; itemWebUrl?: string; price?: { value?: string; currency?: string } }> };
  const comps = (j.itemSummaries ?? [])
    .filter((it) => it.price?.currency === "USD" && it.itemWebUrl)
    .map((it): MarketComp => ({ source: "eBay", title: it.title ?? "", priceUsd: Number(it.price!.value), url: it.itemWebUrl! }))
    .filter((c) => c.priceUsd > 0);
  return { comps, status: { source: "eBay", status: comps.length ? "ok" : "empty", method: "api", detail: `${comps.length} current fixed-price listings (Browse API)` } };
}

async function etsyApi(q: string, env: NodeJS.ProcessEnv, f: Fetch): Promise<{ comps: MarketComp[]; status: MarketSourceStatus }> {
  const key = env.ETSY_API_KEY?.trim();
  if (!key) throw new Error("not-configured");
  const url = `https://openapi.etsy.com/v3/application/listings/active?keywords=${encodeURIComponent(q)}&limit=${MAX_COMPS}`;
  const res = await timed(f, url, { headers: { "x-api-key": key } });
  if (!res.ok) return { comps: [], status: { source: "Etsy", status: "error", method: "api", detail: `Etsy API ${res.status}` } };
  const j = (await res.json()) as { results?: Array<{ title?: string; url?: string; price?: { amount: number; divisor: number; currency_code: string } }> };
  const comps = (j.results ?? [])
    .filter((it) => it.price?.currency_code === "USD" && it.url)
    .map((it): MarketComp => ({ source: "Etsy", title: it.title ?? "", priceUsd: it.price!.amount / (it.price!.divisor || 100), url: it.url! }))
    .filter((c) => c.priceUsd > 0);
  return { comps, status: { source: "Etsy", status: comps.length ? "ok" : "empty", method: "api", detail: `${comps.length} active listings (Open API v3)` } };
}

/** Parse eBay search result HTML (s-card / s-item markup). Exported for tests. */
export function parseEbaySearchHtml(html: string): MarketComp[] {
  const out: MarketComp[] = [];
  const blocks = html.split(/<li[^>]+class="[^"]*\bs-(?:card|item)\b/).slice(1);
  for (const b of blocks) {
    const url = /href="(https:\/\/www\.ebay\.com\/itm\/\d+)[^"]*"/.exec(b)?.[1];
    const priceText = /class="[^"]*s-(?:card|item)__price[^"]*"[^>]*>\s*\$([\d,]+\.\d{2})/.exec(b)?.[1];
    const title = /class="[^"]*s-(?:card|item)__title[^"]*"[^>]*>(?:<[^>]+>)*([^<]+)/.exec(b)?.[1]?.trim() ?? "";
    if (!url || !priceText || /shop on ebay/i.test(title)) continue;
    out.push({ source: "eBay", title, priceUsd: Number(priceText.replace(/,/g, "")), url });
    if (out.length >= MAX_COMPS) break;
  }
  return out;
}

async function ebayHtml(q: string, f: Fetch): Promise<{ comps: MarketComp[]; status: MarketSourceStatus }> {
  const res = await timed(f, `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_BIN=1`, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  if (res.status === 403 || res.status === 429) return { comps: [], status: { source: "eBay", status: "blocked", method: "html", detail: `eBay search page answered ${res.status} (bot wall)` } };
  if (!res.ok) return { comps: [], status: { source: "eBay", status: "error", method: "html", detail: `eBay search page ${res.status}` } };
  const comps = parseEbaySearchHtml(await res.text());
  return { comps, status: { source: "eBay", status: comps.length ? "ok" : "blocked", method: "html", detail: comps.length ? `${comps.length} listings parsed from public search` : "Search page had no parsable listings (likely a challenge page)" } };
}

async function etsyHtml(q: string, f: Fetch): Promise<{ comps: MarketComp[]; status: MarketSourceStatus }> {
  const res = await timed(f, `https://www.etsy.com/search?q=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  if (!res.ok) return { comps: [], status: { source: "Etsy", status: res.status === 403 || res.status === 429 ? "blocked" : "error", method: "html", detail: `Etsy search page answered ${res.status}` } };
  // Etsy search HTML is client-rendered behind DataDome; we don't scrape it. Treat as unavailable.
  return { comps: [], status: { source: "Etsy", status: "blocked", method: "html", detail: "Etsy search page is not machine-readable without the API" } };
}

async function run(
  source: "eBay" | "Etsy",
  api: () => Promise<{ comps: MarketComp[]; status: MarketSourceStatus }>,
  html: () => Promise<{ comps: MarketComp[]; status: MarketSourceStatus }>,
): Promise<{ comps: MarketComp[]; status: MarketSourceStatus; usedApi: boolean }> {
  try {
    const r = await api();
    return { ...r, usedApi: true };
  } catch (error) {
    if (!(error instanceof Error && error.message === "not-configured")) {
      return { comps: [], usedApi: true, status: { source, status: "error", method: "api", detail: error instanceof Error ? error.name : "error" } };
    }
  }
  try {
    const r = await html();
    return { ...r, usedApi: false };
  } catch (error) {
    return { comps: [], usedApi: false, status: { source, status: "error", method: "html", detail: error instanceof Error && error.name === "AbortError" ? "timed out" : "request failed" } };
  }
}

export async function checkMarket(query: string, env: NodeJS.ProcessEnv = process.env, f: Fetch = fetch): Promise<MarketCheckResult> {
  const q = query.trim().slice(0, 120);
  const [ebay, etsy] = await Promise.all([
    run("eBay", () => ebayApi(q, env, f), () => ebayHtml(q, f)),
    run("Etsy", () => etsyApi(q, env, f), () => etsyHtml(q, f)),
  ]);
  const comps = [...ebay.comps, ...etsy.comps];
  const credentialsNeeded: string[] = [];
  if (!ebay.usedApi) credentialsNeeded.push("EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (free eBay developer app keyset, Browse API)");
  if (!etsy.usedApi) credentialsNeeded.push("ETSY_API_KEY (free Etsy Open API v3 app key)");
  return {
    ok: comps.length > 0,
    query: q,
    checkedAt: new Date().toISOString(),
    comps,
    stats: marketStats(comps),
    sources: [ebay.status, etsy.status],
    credentialsNeeded,
  };
}
