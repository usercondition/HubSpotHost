/**
 * Hash-router helpers. Wouter's hash location keeps path and search together
 * as `#/prints?dealId=123`.
 */

export function readHashQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get(name);
}

export function printsDealHref(dealId: string): string {
  return `/prints?dealId=${encodeURIComponent(dealId)}`;
}

export function hubspotAppHref(): string {
  return "https://app.hubspot.com/";
}

/** Deal record deep link when portal id is known; otherwise HubSpot home. */
export function hubspotDealHref(dealId: string, portalId?: string | null): string {
  const id = String(dealId ?? "").trim();
  const portal = String(portalId ?? "").trim();
  if (id && portal) {
    return `https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/record/0-3/${encodeURIComponent(id)}`;
  }
  return hubspotAppHref();
}

/** Print Orders object list when portal id is known; otherwise HubSpot home. */
export function hubspotDealsListHref(portalId?: string | null): string {
  const portal = String(portalId ?? "").trim();
  if (portal) {
    return `https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/objects/0-3/views/all/list`;
  }
  return hubspotAppHref();
}

/** Map a Performance attention row to the next daily-work action. */
export function attentionNextStep(item: {
  dealId: string;
  issue: string;
  portalId?: string | null;
}): {
  href: string;
  label: string;
  external: boolean;
} {
  const issue = item.issue.toLowerCase();
  if (issue.includes("ctb") || issue.includes("ultx") || issue.includes("slice") || issue.includes("plate")) {
    return {
      href: printsDealHref(item.dealId),
      label: "Attach plates",
      external: false,
    };
  }
  if (issue.includes("cost")) {
    return {
      href: hubspotDealHref(item.dealId, item.portalId),
      label: "Update costs in HubSpot",
      external: true,
    };
  }
  return {
    href: hubspotDealHref(item.dealId, item.portalId),
    label: "Open in HubSpot",
    external: true,
  };
}
