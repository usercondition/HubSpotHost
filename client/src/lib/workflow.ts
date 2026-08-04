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

/** Map a Performance attention row to the next daily-work action. */
export function attentionNextStep(item: { dealId: string; issue: string }): {
  href: string;
  label: string;
  external: boolean;
} {
  const issue = item.issue.toLowerCase();
  if (issue.includes("ctb") || issue.includes("plate")) {
    return {
      href: printsDealHref(item.dealId),
      label: "Attach plates",
      external: false,
    };
  }
  if (issue.includes("cost")) {
    return {
      href: hubspotAppHref(),
      label: "Update costs in HubSpot",
      external: true,
    };
  }
  return {
    href: hubspotAppHref(),
    label: "Open in HubSpot",
    external: true,
  };
}
