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

export function kitsDealHref(dealId: string): string {
  return `/kit-dry-run?dealId=${encodeURIComponent(dealId)}`;
}

export function queueDealHref(dealId: string): string {
  return `/queue?dealId=${encodeURIComponent(dealId)}`;
}

/** Floor pressure-chip shortcuts — temporary focused lists (not in the nav rail). */
export const FLOOR_FOCUS_KINDS = ["plates", "costs", "stale", "intake", "buyer"] as const;
export type FloorFocusKind = (typeof FLOOR_FOCUS_KINDS)[number];

export function isFloorFocusKind(value: string | null | undefined): value is FloorFocusKind {
  return FLOOR_FOCUS_KINDS.includes(String(value ?? "") as FloorFocusKind);
}

export function floorFocusHref(kind: FloorFocusKind): string {
  return `/focus?kind=${encodeURIComponent(kind)}`;
}

export function floorFocusMeta(kind: FloorFocusKind): {
  title: string;
  description: string;
  issueKey: string | null;
  workspaceHref: string;
  workspaceLabel: string;
} {
  switch (kind) {
    case "plates":
      return {
        title: "Need plates",
        description: "Open print orders still missing CTB / slice files.",
        issueKey: "no_plates",
        workspaceHref: "/prints",
        workspaceLabel: "Open Prints",
      };
    case "costs":
      return {
        title: "Need costs",
        description: "Orders missing material or shipping costs (labor absorbed · free USPS boxes = $0).",
        issueKey: "costs_incomplete",
        workspaceHref: "/queue",
        workspaceLabel: "Open Queue",
      };
    case "stale":
      return {
        title: "Stale jobs",
        description: "Orders with no HubSpot update lately — poke them or advance stage.",
        issueKey: "stale",
        workspaceHref: "/queue",
        workspaceLabel: "Open Queue",
      };
    case "intake":
      return {
        title: "Intake review",
        description: "Paid order forms waiting for you to approve or reject.",
        issueKey: null,
        workspaceHref: "/orders",
        workspaceLabel: "Open Intake",
      };
    case "buyer":
      return {
        title: "Awaiting buyer",
        description: "Intake links sent but the buyer hasn’t finished the form yet.",
        issueKey: null,
        workspaceHref: "/orders",
        workspaceLabel: "Open Intake",
      };
  }
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

/** Contact record deep link when portal id is known; otherwise HubSpot home. */
export function hubspotContactHref(contactId: string, portalId?: string | null): string {
  const id = String(contactId ?? "").trim();
  const portal = String(portalId ?? "").trim();
  if (id && portal) {
    return `https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/record/0-1/${encodeURIComponent(id)}`;
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
      href: queueDealHref(item.dealId),
      label: "Enter costs in Queue",
      external: false,
    };
  }
  return {
    href: queueDealHref(item.dealId),
    label: "Open in Queue",
    external: false,
  };
}
