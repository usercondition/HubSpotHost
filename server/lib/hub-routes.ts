import type { Express, Request, Response } from "express";
import { fetchPrintOrderDeals, type HubSpotDealRecord } from "./hubspot";

const STOREFRONTS = ["ebay", "etsy", "offerup"] as const;
type Storefront = (typeof STOREFRONTS)[number];

type StorefrontMetric = {
  source: Storefront;
  orders: number;
  sales: number | null;
  averageOrderValue: number | null;
  listingCount: null;
  attentionFlags: null;
};

export type HubSnapshot = {
  ok: true;
  storefronts: Record<Storefront, StorefrontMetric>;
};

function asStorefront(value: string | null | undefined): Storefront | null {
  const source = String(value ?? "").trim().toLowerCase();
  return STOREFRONTS.includes(source as Storefront) ? (source as Storefront) : null;
}

function numberValue(value: string | null | undefined): number | null {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildHubSnapshot(deals: Pick<HubSpotDealRecord, "id" | "properties">[]): HubSnapshot {
  const rows = Object.fromEntries(
    STOREFRONTS.map((source) => [
      source,
      { source, orders: 0, sales: null, averageOrderValue: null, listingCount: null, attentionFlags: null },
    ]),
  ) as Record<Storefront, StorefrontMetric>;
  const totals = new Map<Storefront, number>();

  for (const deal of deals) {
    const source = asStorefront(deal.properties.print_order_source);
    if (!source) continue;
    const row = rows[source];
    row.orders += 1;
    const amount = numberValue(deal.properties.amount);
    if (amount === null) continue;
    totals.set(source, (totals.get(source) ?? 0) + amount);
  }
  for (const source of STOREFRONTS) {
    const total = totals.get(source);
    if (total === undefined) continue;
    rows[source].sales = total;
    rows[source].averageOrderValue = total / rows[source].orders;
  }
  return { ok: true, storefronts: rows };
}

export function registerHubRoutes(
  app: Express,
  rejectOwner: (req: Request, res: Response) => boolean,
  deps: { fetchDeals?: () => Promise<HubSpotDealRecord[]> } = {},
): void {
  const fetchDeals = deps.fetchDeals ?? fetchPrintOrderDeals;
  app.get("/api/hub", async (req, res) => {
    if (rejectOwner(req, res)) return;
    try {
      return res.json(buildHubSnapshot(await fetchDeals()));
    } catch {
      return res.status(502).json({ ok: false, error: "Could not load Hub storefront data" });
    }
  });
}
