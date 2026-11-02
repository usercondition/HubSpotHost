import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ExternalLink, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/primitives";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";

type Storefront = "ebay" | "etsy" | "offerup";
type Metric = { source: Storefront; orders: number; sales: number | null; averageOrderValue: number | null; listingCount: null; attentionFlags: null };
type HubData = { ok: true; storefronts: Record<Storefront, Metric> };
type ListingItem = { id: string; storefront: Storefront; title: string; kind: "health" | "pricing"; reason: string; proposedPrice?: number | null };
type Heartbeat = { service: string; status: "green" | "yellow" | "red"; metrics: Record<string, unknown>; timestamp: string };
type ActionResult = { ok: boolean; message?: string; error?: string; applied?: boolean; executed?: boolean };

const STORES: Array<{ source: Storefront; name: string; inbox: boolean }> = [
  { source: "ebay", name: "eBay", inbox: true },
  { source: "etsy", name: "Etsy", inbox: true },
  { source: "offerup", name: "OfferUp", inbox: false },
];
const SYSTEMS = ["Paperclip", "Syncthing", "Network", "Auto-heal"];

function money(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function normalizeService(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function statusClass(status: Heartbeat["status"]): string {
  switch (status) {
    case "green":
      return "border-good/40 bg-good/10";
    case "yellow":
      return "border-warn/40 bg-warn/10";
    case "red":
      return "border-bad/40 bg-bad/10";
    default: {
      const unexpected: never = status;
      return unexpected;
    }
  }
}

export function PrintOpsHub({ today }: { today?: ReactNode }) {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const queryClient = useQueryClient();
  const [dealId, setDealId] = useState("");
  const [notice, setNotice] = useState("");
  const hub = useQuery<HubData>({ queryKey: ["/api/hub", ownerCode], enabled: isUnlocked, queryFn: async () => (await apiRequest("GET", "/api/hub", undefined, { headers })).json() });
  const listings = useQuery<{ ok: true; pending: boolean; items: ListingItem[] }>({ queryKey: ["/api/listings-health", ownerCode], enabled: isUnlocked, queryFn: async () => (await apiRequest("GET", "/api/listings-health", undefined, { headers })).json() });
  const systems = useQuery<{ ok: true; pending: boolean; heartbeats: Heartbeat[] }>({ queryKey: ["/api/systems", ownerCode], enabled: isUnlocked, queryFn: async () => (await apiRequest("GET", "/api/systems", undefined, { headers })).json() });
  const push = useMutation({ mutationFn: async (marketplace: "ebay" | "etsy") => (await apiRequest("POST", "/api/marketplace-tracking/push", { dealId, marketplace }, { headers })).json() as Promise<ActionResult> });
  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: "approved" | "dismissed" }) => (await apiRequest("POST", `/api/listings-health/${encodeURIComponent(input.id)}/decision`, { decision: input.decision }, { headers })).json() as Promise<ActionResult>,
    onSuccess: (result) => {
      setNotice(result.applied === false ? "Decision saved locally. No listing or price was changed." : result.error ?? "");
      void queryClient.invalidateQueries({ queryKey: ["/api/listings-health", ownerCode] });
    },
  });
  const systemAction = useMutation({
    mutationFn: async (input: { service: string; action: "wake" | "restart" }) => (await apiRequest("POST", `/api/systems/${encodeURIComponent(input.service)}/actions`, { action: input.action }, { headers })).json() as Promise<ActionResult>,
    onSuccess: (result) => setNotice(result.message ?? result.error ?? ""),
  });
  if (!isUnlocked) return <>{today}</>;

  return (
    <div className="min-w-0 max-w-full space-y-4" data-testid="print-ops-hub">
      <nav className="sticky top-0 z-10 flex min-w-0 max-w-full gap-2 overflow-x-auto border-y border-border bg-background/95 py-2 backdrop-blur" aria-label="Hub sections">
        {["Today", "Storefronts", "Flow", "Listings + Pricing", "Systems", "Money"].map((label) => (
          <a key={label} href={`#hub-${label.toLowerCase().replace(/\s+\+\s+|\s+/g, "-")}`} className="shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-muted">{label}</a>
        ))}
      </nav>
      {today}
      <section id="hub-storefronts" className="scroll-mt-14">
        <Panel title="Storefronts" description="Manage buyer conversations and compare only data that is connected.">
          <div className="grid gap-3 md:grid-cols-3">
            {STORES.map((store) => {
              const metric = hub.data?.storefronts?.[store.source];
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
          <div className="mt-4 min-w-0 max-w-full overflow-x-auto" data-testid="hub-storefront-comparison">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead><tr className="text-muted-foreground"><th className="py-1 pr-3">Storefront</th><th>Sales</th><th>Orders</th><th>AOV</th><th>Listings</th><th>Attention</th></tr></thead>
              <tbody>
                {STORES.map((store) => {
                  const metric = hub.data?.storefronts?.[store.source];
                  return <tr key={store.source} className="border-t border-border"><td className="py-2 pr-3">{store.name}</td><td>{money(metric?.sales ?? null)}</td><td>{metric?.orders ?? "—"}</td><td>{money(metric?.averageOrderValue ?? null)}</td><td>— Feed pending</td><td>— Feed pending</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
      <section id="hub-flow" className="scroll-mt-14">
        <Panel title="Intake, production, and ship" description="Existing shop routes stay in place.">
          <div className="flex min-w-0 max-w-full gap-2 overflow-x-auto">{[["Orders", "/orders"], ["Queue", "/queue"], ["Labels", "/labels"], ["Stack", "/stack"]].map(([label, href]) => <Button key={href} asChild size="sm" variant="outline" className="shrink-0"><Link href={href}>{label}</Link></Button>)}</div>
          <div className="mt-3 flex min-w-0 max-w-full gap-2 overflow-x-auto"><Input aria-label="HubSpot deal ID" className="h-9 min-w-36" value={dealId} onChange={(event) => setDealId(event.target.value)} placeholder="Deal ID" />{(["ebay", "etsy"] as const).map((marketplace) => <Button key={marketplace} size="sm" variant="outline" className="shrink-0" disabled={push.isPending || !dealId.trim()} onClick={() => { if (window.confirm(`Record a ${marketplace} tracking push for this order?`)) void push.mutateAsync(marketplace).then((result) => setNotice(result.message ?? result.error ?? "")); }}>Push to {marketplace === "ebay" ? "eBay" : "Etsy"}</Button>)}</div>
        </Panel>
      </section>
      <section id="hub-listings-pricing" className="scroll-mt-14">
        <Panel title="Listings + Pricing" description="Approve or dismiss only. Nothing is applied to a marketplace.">
          {listings.data?.pending || !listings.data?.items.length ? <p className="text-sm text-muted-foreground">Feed pending</p> : listings.data.items.map((item) => (
            <article key={item.id} className="flex items-center justify-between gap-2 border-t border-border py-2 first:border-t-0" data-testid={`listing-${item.id}`}>
              <div className="min-w-0"><p className="truncate font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{item.storefront} · {item.kind} · {item.reason}{item.proposedPrice == null ? "" : ` · $${item.proposedPrice}`}</p></div>
              <div className="flex shrink-0 gap-1"><Button size="sm" variant="outline" onClick={() => { if (window.confirm(`Approve “${item.title}” locally? This will not change the listing.`)) decision.mutate({ id: item.id, decision: "approved" }); }}>Approve</Button><Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Dismiss “${item.title}”? This will not change the listing.`)) decision.mutate({ id: item.id, decision: "dismissed" }); }}>Dismiss</Button></div>
            </article>
          ))}
        </Panel>
      </section>
      <section id="hub-systems" className="scroll-mt-14" data-testid="hub-systems">
        <Panel title="Systems" description="Heartbeat files only. Wake and restart requests are recorded and do not run a command.">
          <div className="grid gap-3 sm:grid-cols-2">
            {SYSTEMS.map((label) => {
              const beat = systems.data?.heartbeats?.find((row) => normalizeService(row.service) === normalizeService(label));
              return (
                <article key={label} className={`rounded-lg border p-3 ${beat ? statusClass(beat.status) : "border-border"}`} data-testid={`system-${normalizeService(label)}`}>
                  <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{label}</h3><span className="text-xs uppercase">{beat?.status ?? "Feed pending"}</span></div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{beat ? `${beat.timestamp} · ${Object.entries(beat.metrics).map(([key, value]) => `${key} ${String(value)}`).join(", ")}` : "—"}</p>
                  <div className="mt-3 flex gap-2">{(["wake", "restart"] as const).map((action) => <Button key={action} size="sm" variant="outline" disabled={systemAction.isPending} onClick={() => { if (window.confirm(`Record a ${action} request for ${label}? No system command will run.`)) systemAction.mutate({ service: label, action }); }}>{action}</Button>)}</div>
                </article>
              );
            })}
          </div>
        </Panel>
      </section>
      <section id="hub-money" className="scroll-mt-14"><Panel title="Money" description="Spending stays in its existing workspace. Storefront sales above use HubSpot amounts only."><Button asChild size="sm" variant="outline"><Link href="/spending">Open Spending</Link></Button></Panel></section>
      {notice ? <p className="text-sm text-muted-foreground" data-testid="hub-action-notice">{notice}</p> : null}
    </div>
  );
}
