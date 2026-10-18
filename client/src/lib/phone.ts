/**
 * Phone-only experience: which nav items a phone shows, and which pages or
 * sections are PC-only. Pure data + functions so they can be unit tested
 * without a DOM. Desktop never reads any of this except `isPhoneFrom`.
 */

/** Narrow viewport: the same breakpoint as Tailwind `md` (phone tab bar). */
export const PHONE_WIDTH_QUERY = "(max-width: 767px)";
/** A touch-first phone turned sideways: coarse pointer and a short, not-wide screen. */
export const PHONE_LANDSCAPE_QUERY = "(pointer: coarse) and (max-width: 932px) and (max-height: 500px)";

export const PHONE_QUERIES = [PHONE_WIDTH_QUERY, PHONE_LANDSCAPE_QUERY] as const;

/** True when any phone query matches. `matches` is window.matchMedia(q).matches in the app. */
export function isPhoneFrom(matches: (query: string) => boolean): boolean {
  return PHONE_QUERIES.some((query) => {
    try {
      return matches(query);
    } catch {
      return false;
    }
  });
}

/* ------------------------------------------------------------ phone nav --- */

/** Bottom tab bar on phones, in order (More is always last). */
export const PHONE_TAB_HREFS = ["/", "/inbox", "/printers", "/queue"] as const;

export type PhoneMoreSection = { title: string; hrefs: string[] };

/**
 * The phone More sheet, grouped by on-the-go task. An href only shows when the
 * desktop NAV has it (so Files appears once that page ships).
 */
export const PHONE_MORE_SECTIONS: PhoneMoreSection[] = [
  { title: "Orders", hrefs: ["/stack", "/orders", "/paid-orders", "/shipments", "/labels"] },
  { title: "Make", hrefs: ["/quote", "/files", "/prints"] },
  { title: "Shop", hrefs: ["/supplies", "/expenses", "/performance", "/nerve"] },
];

/** Short phone labels where the desktop label is too long or unclear on a phone. */
export const PHONE_LABELS: Record<string, string> = {
  "/prints": "Plates",
};

/** The phone More page lives at its own route (not an overlay). */
export const PHONE_MORE_HREF = "/more";

/** One-line descriptions for rows on the phone More page. */
export const PHONE_DESCRIPTIONS: Record<string, string> = {
  "/stack": "Order lineup, status and tracking",
  "/orders": "Send a buyer the order-form link",
  "/paid-orders": "Type in an order by hand",
  "/shipments": "Where every package is",
  "/labels": "Buy a label, copy the tracking note",
  "/quote": "Price an STL with modifiers",
  "/files": "Search Drive files and thumbnails",
  "/prints": "Plates per order and part QC",
  "/supplies": "Snap a receipt, resin to buy",
  "/expenses": "Add a shop charge",
  "/performance": "Sales, profit and print time",
  "/nerve": "Mac mini and agent status",
};

/** Where the phone Back button on a More page goes. */
export function phoneBackTarget(path: string, moreHrefs: string[]): string | null {
  const clean = (path.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return moreHrefs.includes(clean) ? PHONE_MORE_HREF : null;
}

/* ------------------------------------------------------- PC-only routes --- */

export type PcOnlyRoute = {
  /** What the page is, in a few words. */
  what: string;
  /** Optional phone-friendly place to go instead. */
  alt?: { href: string; label: string };
};

/**
 * Whole pages that are PC work (Library, HubSpot board, Profit, Setup, plus the
 * off-nav Marketplace brief and Resin tables). On a phone the shell shows a short
 * "Do this on your PC" note instead of the page, and they are not in the phone nav.
 */
export const PC_ONLY_ROUTES: Record<string, PcOnlyRoute> = {
  "/library": { what: "The slice file library (CTB / ULTX plates)", alt: { href: "/prints", label: "See plates per order" } },
  "/deals": { what: "The full HubSpot stage board", alt: { href: "/stack", label: "Open Priority" } },
  "/operations": { what: "Profit automation and recalculation", alt: { href: "/performance", label: "See Stats" } },
  "/setup": { what: "System setup and connections", alt: { href: "/nerve", label: "Check Nerve status" } },
  "/marketplace-brief": { what: "The Marketplace brief and Chrome helper", alt: { href: "/inbox", label: "Open Inbox" } },
  "/resin": { what: "Resin inventory tables", alt: { href: "/supplies", label: "Open Supplies" } },
};

export function pcOnlyRouteFor(path: string): PcOnlyRoute | null {
  const clean = (path.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return PC_ONLY_ROUTES[clean] ?? null;
}

type NavLike = { href: string };

/** Phone tab items in PHONE_TAB_HREFS order, limited to what NAV has. */
export function phoneTabs<T extends NavLike>(nav: T[]): T[] {
  return PHONE_TAB_HREFS.map((href) => nav.find((item) => item.href === href)).filter((item): item is T => Boolean(item));
}

/** Phone More sections with NAV items filled in; empty sections dropped. PC-only and tab items never appear. */
export function phoneMoreSections<T extends NavLike>(nav: T[]): Array<{ title: string; items: T[] }> {
  const tabs = new Set<string>(PHONE_TAB_HREFS);
  return PHONE_MORE_SECTIONS.map((section) => ({
    title: section.title,
    items: section.hrefs
      .filter((href) => !tabs.has(href) && !pcOnlyRouteFor(href))
      .map((href) => nav.find((item) => item.href === href))
      .filter((item): item is T => Boolean(item)),
  })).filter((section) => section.items.length > 0);
}

/** Every href a phone can reach from the nav (tabs + More). */
export function phoneNavHrefs<T extends NavLike>(nav: T[]): string[] {
  return [...phoneTabs(nav), ...phoneMoreSections(nav).flatMap((s) => s.items)].map((item) => item.href);
}
