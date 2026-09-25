/**
 * Hash-router helpers. Wouter's hash location keeps path and search together
 * as `#/prints?dealId=123`.
 */

export function readHashQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex >= 0) {
    const fromHash = new URLSearchParams(hash.slice(queryIndex + 1)).get(name);
    if (fromHash != null && fromHash !== "") return fromHash;
  }
  // Legacy: stock wouter hash navigate() parked queries on location.search.
  const fromSearch = new URLSearchParams(window.location.search).get(name);
  return fromSearch != null && fromSearch !== "" ? fromSearch : null;
}

export function printsDealHref(dealId: string): string {
  return `/prints?dealId=${encodeURIComponent(dealId)}`;
}

/** @deprecated Kits UI is parked — prefer Orders Parts + Prints plate bits. */
export function kitsDealHref(dealId: string): string {
  return `/kit-dry-run?dealId=${encodeURIComponent(dealId)}`;
}

export function queueDealHref(dealId: string): string {
  return `/queue?dealId=${encodeURIComponent(dealId)}`;
}

export function stackHref(dealId?: string | null): string {
  const id = String(dealId ?? "").trim();
  return id ? `/stack?dealId=${encodeURIComponent(id)}` : "/stack";
}

/** Ship-ready and blocked orders live on the Stack. Printer lanes stay on Queue. */
export function floorWorkHref(dealId: string, bucket: string): string {
  if (bucket === "ship_ready" || bucket === "blocked") return stackHref(dealId);
  return queueDealHref(dealId);
}

/**
 * Deep link that landed on Queue for a deal the printer lanes no longer show.
 * Returns a Stack href, or null when the deal is still a printer card (or unknown).
 */
export function parkedQueueHref(
  dealId: string,
  lanes: { nextPrint: string[]; inProduction: string[]; shipReady: string[]; blocked: string[] },
): string | null {
  if (lanes.nextPrint.includes(dealId) || lanes.inProduction.includes(dealId)) return null;
  if (lanes.shipReady.includes(dealId) || lanes.blocked.includes(dealId)) return stackHref(dealId);
  return null;
}

export function labelsDealHref(dealId?: string | null): string {
  const id = String(dealId ?? "").trim();
  return id ? `/labels?dealId=${encodeURIComponent(id)}` : "/labels";
}

/** Floor pressure-chip shortcuts — jump straight to the workspace (no extra focus page). */
export const FLOOR_FOCUS_KINDS = ["plates", "costs", "stale", "intake", "buyer"] as const;
export type FloorFocusKind = (typeof FLOOR_FOCUS_KINDS)[number];

export function isFloorFocusKind(value: string | null | undefined): value is FloorFocusKind {
  return FLOOR_FOCUS_KINDS.includes(String(value ?? "") as FloorFocusKind);
}

export function floorFocusHref(kind: FloorFocusKind): string {
  return floorFocusMeta(kind).workspaceHref;
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
        description: "Orders missing plate costs, $0 defaults, or postage after a shipping label.",
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
        description: "Paid order forms waiting for you to approve or cancel.",
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
      label: "Enter costs",
      external: false,
    };
  }
  return {
    href: queueDealHref(item.dealId),
    label: "Open in Queue",
    external: false,
  };
}
