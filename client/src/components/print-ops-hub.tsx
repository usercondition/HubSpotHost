import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ExternalLink, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/primitives";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";

type Storefront = "ebay" | "etsy" | "offerup";
type Metric = { source: Storefront; orders: number; sales: number | null; averageOrderValue: number | null; listingCount: null; attentionFlags: null };
type HubData = { ok: true; storefronts: Record<Storefront, Metric> };

const STORES: Array<{ source: Storefront; name: string; inbox: boolean }> = [
  { source: "ebay", name: "eBay", inbox: true },
  { source: "etsy", name: "Etsy", inbox: true },
  { source: "offerup", name: "OfferUp", inbox: false },
];

function money(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function PrintOpsHub() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const hub = useQuery<HubData>({
    queryKey: ["/api/hub", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/hub", undefined, { headers })).json(),
  });
  if (!isUnlocked) return null;

  return (
    <div className="space-y-4" data-testid="print-ops-hub">
      <nav className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-y border-border bg-background/95 py-2 backdrop-blur" aria-label="Hub sections">
        {["Today", "Storefronts", "Flow", "Listings + Pricing", "Systems", "Money"].map((label) => (
          <a key={label} href={`#hub-${label.toLowerCase().replace(/\s+\+\s+|\s+/g, "-")}`} className="shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-muted">{label}</a>
        ))}
      </nav>
      <section id="hub-storefronts" className="scroll-mt-14">
        <Panel title="Storefronts" description="Manage buyer conversations and compare only data that is connected.">
          <div className="grid gap-3 md:grid-cols-3">
            {STORES.map((store) => {
              const metric = hub.data?.storefronts[store.source];
              return (
                <article key={store.source} className="rounded-lg border border-border bg-card p-3" data-testid={`hub-storefront-${store.source}`}>
                  <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{store.name}</h3><Store className="h-4 w-4 text-muted-foreground" /></div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div><dt className="text-muted-foreground">Orders</dt><dd className="font-medium">{metric?.orders ?? "—"}</dd></div>
                    <div><dt className="text-muted-foreground">Sales</dt><dd className="font-medium">{money(metric?.sales ?? null)}</dd></div>
                    <div><dt className="text-muted-foreground">Listings</dt><dd>— <span className="text-xs text-muted-foreground">Feed pending</span></dd></div>
                    <div><dt className="text-muted-foreground">Attention</dt><dd>— <span className="text-xs text-muted-foreground">Feed pending</span></dd></div>
                  </dl>
                  {store.inbox ? <Button asChild className="mt-3 w-full" size="sm" variant="outline"><Link href={`/inbox?storefront=${store.source}`}><ExternalLink className="h-3.5 w-3.5" />Manage</Link></Button> : <p className="mt-3 text-sm text-muted-foreground">Listing tools · Feed pending</p>}
                </article>
              );
            })}
          </div>
        </Panel>
      </section>
      <section id="hub-listings-pricing" className="scroll-mt-14"><Panel title="Listings + Pricing" description="Approval-only feed. Feed pending." ><p className="text-sm text-muted-foreground">No listings or pricing changes are applied automatically.</p></Panel></section>
      <section id="hub-systems" className="scroll-mt-14"><Panel title="Systems" description="Paperclip, Syncthing, network, and auto-heal heartbeats."><p className="text-sm text-muted-foreground">Feed pending.</p></Panel></section>
    </div>
  );
}
