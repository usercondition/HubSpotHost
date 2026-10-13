import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Cuboid, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { formatMoney } from "@/lib/format";
import { orderTitle } from "@/lib/order-title";
import { shopDateLabel, shipByCalendarDate } from "@shared/ship-by";
import { stagePresentation } from "@/lib/stage-chip";
import { printsDealHref, stackHref } from "@/lib/workflow";
import { WORKSHOP_STATIONS, workshopStationForOrder } from "@/lib/workshop-stations";
import type { DealOpsDetail, OrderPart, ProductionQueueItem } from "@shared/schema";

type PartsResponse = { ok: true; parts: OrderPart[] };

export function WorkshopOrderPanel({
  order,
  headers,
  sample,
  onClose,
}: {
  order: ProductionQueueItem;
  headers: Record<string, string>;
  sample: boolean;
  onClose: () => void;
}) {
  const today = shipByCalendarDate();
  const title = orderTitle(order.dealName, order.contactName);
  const status = stagePresentation(order.stage);
  const station = workshopStationForOrder(order);
  const live = !sample && /^\d+$/.test(order.dealId);

  const ops = useQuery<DealOpsDetail>({
    queryKey: ["/api/deal-ops", order.dealId],
    enabled: live,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/deal-ops/${encodeURIComponent(order.dealId)}`, undefined, {
        headers,
      });
      return (await response.json()) as DealOpsDetail;
    },
  });

  const parts = useQuery<PartsResponse>({
    queryKey: ["/api/orders", order.dealId, "parts"],
    enabled: live,
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/orders/${encodeURIComponent(order.dealId)}/parts`,
        undefined,
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
  });

  const plateNames = ops.data?.plates.map((plate) => plate.fileName).filter(Boolean) ?? [];
  const partFiles = parts.data?.parts.map((part) => part.fileName || part.label).filter(Boolean) ?? [];
  const hasModelHint = plateNames.length > 0 || partFiles.length > 0;

  return (
    <aside className="workshop-panel" data-testid="panel-workshop-order" aria-label="Order details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="workshop-kicker">{WORKSHOP_STATIONS.find((entry) => entry.id === station)?.label ?? station}</p>
          <h2 className="workshop-panel-title" data-testid="text-workshop-order-name">
            {title}
          </h2>
          {order.contactName ? <p className="text-sm text-muted-foreground">{order.contactName}</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          onClick={onClose}
          data-testid="button-close-workshop-order"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      <dl className="workshop-facts">
        <div>
          <dt>Status</dt>
          <dd data-testid="text-workshop-order-stage">{status.label}</dd>
        </div>
        <div>
          <dt>Ship by</dt>
          <dd>
            {shopDateLabel({
              date: order.shipBy,
              today,
              source: order.shipBySource === "override" ? "override" : "derived",
              tentative: order.tentative,
            })}
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd className="numeric">{formatMoney(order.amount)}</dd>
        </div>
        {order.assignedPrinterNames.length > 0 ? (
          <div>
            <dt>Printer</dt>
            <dd>{order.assignedPrinterNames.join(", ")}</dd>
          </div>
        ) : null}
      </dl>

      <div className="workshop-model" data-testid="panel-workshop-model">
        <div className="workshop-model-bust" aria-hidden>
          <Cuboid className="h-10 w-10" />
        </div>
        {hasModelHint ? (
          <div>
            <p className="text-sm font-medium">Model files</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {(plateNames.length > 0 ? plateNames : partFiles).slice(0, 4).map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {sample ? "Sample order — no mesh on file." : "No STL or plate mesh on this order yet."}
          </p>
        )}
      </div>

      {live ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link href={stackHref(order.dealId)}>Open in Stack</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={printsDealHref(order.dealId)}>Prints</Link>
          </Button>
          {ops.data?.hubspotPortalId ? (
            <a
              className="inline-flex h-8 items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              href={`https://app.hubspot.com/contacts/${ops.data.hubspotPortalId}/record/0-3/${order.dealId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              HubSpot <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Sample shop data. Live deals open here when the owner session is unlocked.</p>
      )}
    </aside>
  );
}
