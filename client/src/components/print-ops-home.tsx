import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { useShopCounts } from "@/hooks/use-shop-counts";
import { apiRequest } from "@/lib/queryClient";
import { formatMoney, formatLocalDateTime } from "@/lib/format";
import { shipByCalendarDate } from "@shared/ship-by";
import { buildTrackingRows, TRACKING_STAGE_LABEL, TRACKING_STAGES, type TrackingStage } from "@shared/order-tracking";
import { SYSTEM_CATALOG, SYSTEM_STATUS_IDS } from "@shared/system-catalog";
import type { StackView } from "@/components/priority-stack-list";
import type {
  PerformanceResponse,
  PrinterFleetSnapshot,
  ProductionQueueResponse,
  ResinReorderResponse,
  ShipstationShipmentView,
} from "@shared/schema";

type HubData = {
  ok: true;
  storefronts: Record<"ebay" | "etsy" | "offerup", { orders: number | null; sales: number | null }>;
};
type SystemTile = {
  id: string;
  label: string;
  status: "green" | "amber" | "red" | "unknown";
  summary: string;
  checkedAt: string | null;
};
type Tone = "good" | "warn" | "bad";
type ListingItem = { id: string; storefront: string; title: string; kind: string; reason: string; proposedPrice?: number | null };
type ActionResult = { ok?: boolean; message?: string; error?: string; applied?: boolean };

const CHANNELS: Array<{ id: "ebay" | "etsy" | "offerup" | "mmf"; name: string }> = [
  { id: "ebay", name: "eBay" },
  { id: "etsy", name: "Etsy" },
  { id: "offerup", name: "OfferUp" },
  { id: "mmf", name: "MyMiniFactory" },
];

function toneClass(tone: Tone): string {
  if (tone === "bad") return "border-bad/40 bg-bad/10";
  if (tone === "warn") return "border-warn/40 bg-warn/10";
  return "border-good/40 bg-good/10";
}

function tileClass(status: SystemTile["status"]): string {
  if (status === "red") return toneClass("bad");
  if (status === "amber") return toneClass("warn");
  if (status === "green") return toneClass("good");
  return "border-border bg-card";
}

export function PrintOpsHome() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Print Ops unlocked",
    successDescription: "Today's shop, orders, and systems are ready.",
  });
  const { needs } = useShopCounts();
  const [stage, setStage] = useState<TrackingStage | "all">("all");
  const [dealId, setDealId] = useState("");
  const [notice, setNotice] = useState("");
  const queryClient = useQueryClient();
  const listings = useQuery<{ ok: true; pending: boolean; items: ListingItem[] }>({
    queryKey: ["/api/listings-health", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/listings-health", undefined, { headers })).json(),
  });
  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: "approved" | "dismissed" }) =>
      (await apiRequest("POST", `/api/listings-health/${encodeURIComponent(input.id)}/decision`, { decision: input.decision }, { headers })).json() as Promise<ActionResult>,
    onSuccess: (result) => {
      setNotice(result.applied === false ? "Decision saved locally. No listing or price was changed." : result.error ?? "");
      void queryClient.invalidateQueries({ queryKey: ["/api/listings-health", ownerCode] });
    },
  });
  const push = useMutation({
    mutationFn: async (marketplace: "ebay" | "etsy") =>
      (await apiRequest("POST", "/api/marketplace-tracking/push", { dealId, marketplace }, { headers })).json() as Promise<ActionResult>,
    onSuccess: (result) => setNotice(result.message ?? result.error ?? ""),
  });
  const today = shipByCalendarDate();

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/performance", undefined, { headers })).json(),
  });
  const stack = useQuery<StackView>({
    queryKey: ["/api/priority-stack", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/priority-stack", undefined, { headers })).json(),
  });
  const queue = useQuery<ProductionQueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/production-queue", undefined, { headers })).json(),
  });
  const hub = useQuery<HubData>({
    queryKey: ["/api/hub", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/hub", undefined, { headers })).json(),
  });
  const systems = useQuery<{ ok: true; tiles: SystemTile[] }>({
    queryKey: ["/api/systems/status", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/systems/status", undefined, { headers })).json(),
  });
  const printers = useQuery<{ ok: true } & PrinterFleetSnapshot>({
    queryKey: ["/api/printers", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/printers", undefined, { headers })).json(),
  });
  const resin = useQuery<ResinReorderResponse>({
    queryKey: ["/api/resin-reorder", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/resin-reorder", undefined, { headers })).json(),
  });
  const shipments = useQuery<{ ok: true; shipments: ShipstationShipmentView[] }>({
    queryKey: ["/api/shipstation/shipments", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/shipstation/shipments", undefined, { headers })).json(),
  });

  const tiles = systems.data?.tiles ?? [];
  const failedSystems = tiles.filter((tile) => tile.status === "red" || tile.status === "amber");
  const overdue = (stack.data?.rows ?? []).filter((row) => row.targetDate && row.targetDate < today);
  const stripTone: Tone = needs.some((need) => need.lane === "bad") || tiles.some((tile) => tile.status === "red") || overdue.length > 0
    ? "bad"
    : needs.length > 0 || failedSystems.length > 0
      ? "warn"
      : "good";

  const tracking = useMemo(() => {
    const items = queue.data
      ? [...queue.data.nextPrint, ...queue.data.inProduction, ...queue.data.shipReady, ...queue.data.blocked]
      : [];
    return buildTrackingRows(
      items,
      (shipments.data?.shipments ?? []).map((row) => ({
        id: row.shipmentId,
        dealId: row.matchedDealId,
        name: row.matchedDealName || row.shipToName,
        status: row.status,
        stale: row.stale,
        trackingNumber: row.trackingNumber,
        shipDate: row.shipDate,
        carrierCode: row.carrierCode,
        voided: row.voided,
      })),
    );
  }, [queue.data, shipments.data]);
  const visible = stage === "all" ? tracking : tracking.filter((row) => row.stage === stage);

  if (!isUnlocked) {
    return (
      <OwnerUnlockPanel
        title="Unlock Print Ops"
        description="One page for what needs you, orders, tracking, and every system."
        buttonLabel="Unlock Print Ops"
        testIdPrefix="dashboard"
        pending={unlock.isPending}
        onUnlock={(code) => unlock.mutate(code)}
      />
    );
  }

  const summary = performance.data?.summary;
  const shippedCount = stack.data?.outTheDoor?.length ?? 0;
  const shippedMoney = stack.data?.totals?.outTheDoor ?? 0;

  return (
    <div className="print-ops-home" data-testid="print-ops-hub">
      <nav className="print-ops-jumps" aria-label="Print Ops sections">
        {[
          ["needs", "Needs Miguel today"],
          ["metrics", "Metrics"],
          ["orders", "Orders"],
          ["systems", "Systems"],
          ["production", "Production"],
        ].map(([id, label]) => (
          <a key={id} href={`#print-ops-${id}`}>{label}</a>
        ))}
      </nav>

      <section id="print-ops-needs" className={`print-ops-strip ${toneClass(stripTone)}`} data-testid="work-hub" data-tone={stripTone}>
        <header>
          <h2>Needs Miguel today</h2>
          <span>{overdue.length + needs.length + failedSystems.length}</span>
        </header>
        {needs.length === 0 && overdue.length === 0 && failedSystems.length === 0 ? (
          <p>Nothing needs you right now.</p>
        ) : (
          <ul>
            {overdue.slice(0, 6).map((row) => (
              <li key={`overdue-${row.key}`}>
                <Link href="/stack"><strong>{row.name}</strong><span>Overdue ship-by</span></Link>
              </li>
            ))}
            {needs.slice(0, 8).map((need) => (
              <li key={need.key}>
                <Link href={need.href}><strong>{need.pill}</strong><span>{need.name} · {need.problem}</span></Link>
              </li>
            ))}
            {failedSystems.map((tile) => (
              <li key={tile.id}>
                <a href="#print-ops-systems"><strong>{tile.label}</strong><span>{tile.summary}</span></a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="print-ops-metrics" className="metric-strip" aria-label="Shop metrics">
        <article className="ops-card">
          <p>Open orders</p>
          <strong>{stack.data ? stack.data.rows.length : "—"}</strong>
        </article>
        <article className="ops-card">
          <p>Shipped this week</p>
          <strong>{stack.data ? shippedCount : "—"}</strong>
          <small>{stack.data ? formatMoney(shippedMoney, { compact: false }) : ""}</small>
        </article>
        <article className="ops-card">
          <p>Revenue {performance.data ? `· ${performance.data.period.days}d` : ""}</p>
          <strong>{summary ? formatMoney(summary.revenue, { compact: false }) : "—"}</strong>
          <small>{summary ? `${summary.weightedMarginPercent.toFixed(0)}% margin` : ""}</small>
        </article>
        {CHANNELS.map((channel) => {
          const metric = channel.id === "mmf" ? null : hub.data?.storefronts[channel.id];
          const sales = metric?.sales ?? null;
          return (
            <article key={channel.id} className="ops-card" data-testid={`hub-storefront-${channel.id}`}>
              <p>{channel.name}</p>
              <strong>{sales == null ? "—" : formatMoney(sales, { compact: false })}</strong>
              <small>{sales == null ? "No data yet" : `${metric?.orders ?? "—"} orders`}</small>
            </article>
          );
        })}
      </section>

      <section id="print-ops-orders" aria-label="Orders and tracking">
        <header className="print-ops-section-head">
          <h2>Orders and tracking</h2>
          <div className="print-ops-jumps">
            <button type="button" data-active={stage === "all"} onClick={() => setStage("all")}>All</button>
            {TRACKING_STAGES.map((key) => (
              <button key={key} type="button" data-active={stage === key} onClick={() => setStage(key)}>
                {TRACKING_STAGE_LABEL[key]}
              </button>
            ))}
          </div>
        </header>
        <div className="print-ops-table-wrap">
          <table className="print-ops-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Order</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={4}>Nothing in this stage.</td></tr>
              ) : visible.map((row) => (
                <tr key={row.key} data-stuck={row.stuck ? "true" : "false"}>
                  <td>{TRACKING_STAGE_LABEL[row.stage]}</td>
                  <td>{row.dealId ? <Link href={`/stack?dealId=${encodeURIComponent(row.dealId)}`}>{row.name}</Link> : row.name}</td>
                  <td className="print-ops-ellipsis">{row.stuck ? `Stuck · ${row.detail}` : row.detail}</td>
                  <td>{row.when || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="print-ops-systems" data-testid="hub-systems" aria-label="Systems">
        <header className="print-ops-section-head"><h2>Systems</h2></header>
        <div className="print-ops-systems">
          {(tiles.length > 0 ? tiles : SYSTEM_STATUS_IDS.map((id) => ({
            id,
            label: SYSTEM_CATALOG[id].label,
            status: "unknown" as const,
            summary: "No data yet",
            checkedAt: null,
          }))).map((tile) => (
            <article key={tile.id} className={tileClass(tile.status)} data-testid={`system-${tile.id}`}>
              <header>
                <h3>{tile.label}</h3>
                <span>{tile.status === "unknown" ? "No data yet" : tile.status}</span>
              </header>
              <p className="print-ops-ellipsis">{tile.summary}</p>
              <small>{tile.checkedAt ? formatLocalDateTime(tile.checkedAt) : "No check yet"}</small>
            </article>
          ))}
        </div>
      </section>

      <section id="print-ops-production" aria-label="Production">
        <header className="print-ops-section-head">
          <h2>Production</h2>
          <Link href="/prints">Plates</Link>
          <Link href="/printers">Printers</Link>
          <Link href="/resin">Resin</Link>
        </header>
        <div className="print-ops-systems">
          <article className="ops-card">
            <h3>Printers</h3>
            <p>{printers.data?.fleetTotals ? `${printers.data.fleetTotals.activePrinters} active · ${printers.data.fleetTotals.plateCount} plates on record` : "—"}</p>
            <ul>
              {(printers.data?.printers ?? []).slice(0, 8).map((printer) => (
                <li key={printer.name}>{printer.name} · {printer.status}{printer.fepHoursUsedPercent != null ? ` · FEP ${Math.round(printer.fepHoursUsedPercent)}%` : ""}</li>
              ))}
            </ul>
          </article>
          <article className="ops-card">
            <h3>Resin reorder</h3>
            {!resin.data ? <p>—</p> : resin.data.buyNow.length === 0 ? <p>Nothing to reorder</p> : (
              <ul>
                {resin.data?.buyNow.map((row) => (
                  <li key={row.productId}>{row.name} · {row.urgency} · {row.reason}</li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>

      <section id="print-ops-listings" aria-label="Listing notes">
        <header className="print-ops-section-head"><h2>Listing notes</h2></header>
        {listings.data?.pending || !listings.data?.items.length ? <p>No data yet</p> : listings.data.items.map((item) => (
          <article key={item.id} data-testid={`listing-${item.id}`}>
            <p className="print-ops-ellipsis">{item.title}</p>
            <p>{item.storefront} · {item.kind} · {item.reason}{item.proposedPrice == null ? "" : ` · $${item.proposedPrice}`}</p>
            <button type="button" onClick={() => { if (window.confirm(`Approve “${item.title}” locally? This will not change the listing.`)) decision.mutate({ id: item.id, decision: "approved" }); }}>Approve</button>
            <button type="button" onClick={() => { if (window.confirm(`Dismiss “${item.title}”? This will not change the listing.`)) decision.mutate({ id: item.id, decision: "dismissed" }); }}>Dismiss</button>
          </article>
        ))}
        <form className="print-ops-actions" onSubmit={(event) => event.preventDefault()}>
          <input aria-label="HubSpot deal ID" value={dealId} onChange={(event) => setDealId(event.target.value)} placeholder="Deal ID" />
          {(["ebay", "etsy"] as const).map((marketplace) => (
            <button key={marketplace} type="button" disabled={push.isPending || !dealId.trim()} onClick={() => { if (window.confirm(`Record a ${marketplace} tracking push for this order?`)) push.mutate(marketplace); }}>
              Push to {marketplace === "ebay" ? "eBay" : "Etsy"}
            </button>
          ))}
        </form>
        {notice ? <p data-testid="hub-action-notice">{notice}</p> : null}
      </section>
    </div>
  );
}
