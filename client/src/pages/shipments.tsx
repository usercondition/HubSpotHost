import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, PackageSearch, Truck } from "lucide-react";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import type { ShipstationShipmentView } from "@shared/schema";

const tone = (status: ShipstationShipmentView["status"]) =>
  status === "delivered" ? "good" : status === "exception" ? "bad" : status === "out for delivery" ? "warn" : "neutral";

function recipient(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)?.[0]}.` : parts[0] || "Unknown recipient";
}

export default function ShipmentsPage() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({ successTitle: "Shipments unlocked", successDescription: "Shipment history is ready." });
  const shipments = useQuery<{ ok: true; shipments: ShipstationShipmentView[] }>({
    queryKey: ["/api/shipstation/shipments", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/shipstation/shipments", undefined, { headers })).json(),
  });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Shipments" subtitle="Read-only tracking from ShipStation. Sample data is clearly labeled in demos." />
      <div className="page-stack">
        {!isUnlocked ? <OwnerUnlockPanel title="Unlock Shipments" description="Owner code required to view recipient and tracking data." buttonLabel="Unlock Shipments" testIdPrefix="shipments" pending={unlock.isPending} onUnlock={(code) => unlock.mutate(code)} /> : (
          <Panel title="Recent shipments" description="Newest first · exceptions and shipments with no movement for four days need attention." testId="panel-shipments">
            {shipments.isLoading ? <p className="text-sm text-muted-foreground">Loading shipments…</p> : shipments.data?.shipments.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr><th className="pb-2 pr-3">Date</th><th className="pb-2 pr-3">Recipient</th><th className="pb-2 pr-3">Carrier / service</th><th className="pb-2 pr-3">Tracking</th><th className="pb-2 pr-3">Status</th><th className="pb-2 pr-3 text-right">Cost</th><th className="pb-2">Matched order</th></tr>
                  </thead>
                  <tbody>
                    {shipments.data.shipments.map((shipment) => (
                      <tr key={shipment.shipmentId} className="border-b last:border-0">
                        <td className="py-3 pr-3 whitespace-nowrap">{shipment.shipDate ? new Date(shipment.shipDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</td>
                        <td className="py-3 pr-3 font-medium">{recipient(shipment.shipToName)}</td>
                        <td className="py-3 pr-3"><span className="block">{shipment.carrierCode || "Carrier unknown"}</span><span className="text-xs text-muted-foreground">{shipment.serviceCode || "—"}</span></td>
                        <td className="py-3 pr-3">{shipment.trackingUrl ? <a className="text-primary hover:underline" href={shipment.trackingUrl} target="_blank" rel="noreferrer">{shipment.trackingNumber || "—"}</a> : shipment.trackingNumber || "—"}</td>
                        <td className="py-3 pr-3"><div className="flex items-center gap-1.5"><StatusPill tone={tone(shipment.status)} icon={shipment.status === "delivered" ? CheckCircle2 : Truck} label={shipment.status} />{(shipment.stale || shipment.status === "exception") && <AlertTriangle className="h-4 w-4 text-destructive" aria-label={shipment.stale ? "Stale" : "Exception"} />}</div></td>
                        <td className="py-3 pr-3 text-right tabular-nums">{shipment.shipmentCost ? formatMoney(Number(shipment.shipmentCost)) : "—"}</td>
                        <td className="py-3">{shipment.matchedDealName || shipment.orderNumber || "Unmatched"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="glance-item flex-col items-center py-8 text-center"><PackageSearch className="h-5 w-5 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No ShipStation shipments yet</p><p className="text-xs text-muted-foreground">Webhooks or an owner sync will add them here.</p></div>}
          </Panel>
        )}
      </div>
    </div>
  );
}
