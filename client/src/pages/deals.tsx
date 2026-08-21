import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Calendar,
  CircleDollarSign,
  ExternalLink,
  FileUp,
  Loader2,
  Package,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, hubspotDealsListHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsPanel } from "@/components/deal-ops-panel";
import {
  OrderPartsDialog,
  formatPartsBadge,
  type OrderPartSummary,
} from "@/components/order-parts-dialog";
import { formatMoney, formatLocalDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

type BoardDeal = PerformanceResponse["activeDeals"][number] & {
  needsCosts: boolean;
  needsPlates: boolean;
  alerts: PerformanceResponse["attention"];
};

type BoardColumn = PerformanceResponse["pipeline"][number] & {
  deals: BoardDeal[];
  totalAmount: number;
};

/**
 * Orders board — at-a-glance Print Orders pipeline columns.
 * Open Ops on a card (or Queue) to move stage, enter costs, and ship.
 */
export default function DealsPage() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Orders unlocked",
    successDescription: "Live HubSpot stages and open print jobs, without leaving Print Operations.",
  });
  const [showClosedStages, setShowClosedStages] = useState(false);
  const [showEmptyStages, setShowEmptyStages] = useState(false);
  const [opsDealId, setOpsDealId] = useState<string | null>(null);
  const [partsDeal, setPartsDeal] = useState<{ dealId: string; dealName: string } | null>(null);

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const partSummaries = useQuery<{ ok: true; summaries: OrderPartSummary[] }>({
    queryKey: ["/api/order-parts/summaries", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/order-parts/summaries", undefined, { headers });
      return (await response.json()) as { ok: true; summaries: OrderPartSummary[] };
    },
  });

  const summaryByDeal = useMemo(() => {
    const map = new Map<string, OrderPartSummary>();
    for (const row of partSummaries.data?.summaries ?? []) {
      map.set(row.hubspotDealId, row);
    }
    return map;
  }, [partSummaries.data?.summaries]);

  const snapshot = performance.data;
  const portalId = snapshot?.hubspotPortalId ?? null;

  const { columns, openValue, closedColumnCount, emptyColumnCount } = useMemo(() => {
    if (!snapshot) {
      return { columns: [] as BoardColumn[], openValue: 0, closedColumnCount: 0, emptyColumnCount: 0 };
    }

    const alertsByDeal = new Map<string, PerformanceResponse["attention"]>();
    for (const item of snapshot.attention) {
      const list = alertsByDeal.get(item.dealId) ?? [];
      list.push(item);
      alertsByDeal.set(item.dealId, list);
    }

    const byStage = new Map<string, BoardDeal[]>();
    let openValue = 0;
    for (const deal of snapshot.activeDeals) {
      // Shipping / fee HubSpot deals are charges, not print jobs — keep them off the board.
      if (!deal.requiresPlates) continue;
      openValue += deal.amount;
      const alerts = alertsByDeal.get(deal.dealId) ?? [];
      const key = deal.stageId || deal.stage;
      const list = byStage.get(key) ?? [];
      list.push({
        ...deal,
        needsCosts: alerts.some((item) => item.issueKey === "costs_incomplete"),
        needsPlates: deal.promptAttachPlates,
        alerts,
      });
      byStage.set(key, list);
    }

    const allColumns: BoardColumn[] = snapshot.pipeline.map((stage) => {
      const deals = byStage.get(stage.id) ?? [];
      const totalAmount = deals.reduce((sum, deal) => sum + deal.amount, 0);
      return { ...stage, deals, totalAmount };
    });

    const closedColumnCount = allColumns.filter((column) => column.closed).length;
    const visible = showClosedStages ? allColumns : allColumns.filter((column) => !column.closed);
    const emptyColumnCount = visible.filter((column) => column.deals.length === 0).length;
    const columns = showEmptyStages ? visible : visible.filter((column) => column.deals.length > 0);

    return { columns, openValue, closedColumnCount, emptyColumnCount };
  }, [snapshot, showClosedStages, showEmptyStages]);

  const boardReady = isUnlocked && !performance.isLoading && !performance.isError && Boolean(snapshot);

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-[100rem] flex-col overflow-hidden">
      <PageHeader
        title="Orders"
        subtitle="Print Orders board — print jobs only (shipping and fees stay in HubSpot as charges)."
        actions={
          <>
            {isUnlocked ? (
              <>
                <Button asChild size="sm" data-testid="button-open-queue-from-deals">
                  <Link href="/queue">
                    <Package className="mr-2 h-3.5 w-3.5" />
                    Queue
                  </Link>
                </Button>
                <Button asChild size="sm" variant="ghost" data-testid="button-open-hubspot-deals">
                  <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
                    HubSpot
                    <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => performance.refetch()}
                  disabled={performance.isFetching}
                  data-testid="button-refresh-deals"
                >
                  {performance.isFetching ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  )}
                  Refresh
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          boardReady ? "px-4 pb-4 pt-3 md:px-6" : "page-stack overflow-y-auto",
        )}
      >
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the Orders board"
            description="Same owner code as Daily Work. Live HubSpot stages and open print jobs, without leaving Print Operations."
            buttonLabel="Unlock Orders"
            testIdPrefix="deals"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <BoardSkeleton />
        ) : performance.isError || !snapshot ? (
          <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-deals-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <h2 className="text-base font-semibold tracking-tight">Orders could not be loaded</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Check the HubSpot connection, then refresh.
                </p>
                <Button className="mt-4" size="sm" onClick={() => performance.refetch()} data-testid="button-retry-deals">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <section
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-card-border bg-card"
            data-testid="panel-deals-board"
            aria-label="Print Orders pipeline board"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 md:px-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-tight">Print Orders</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    Same stages as HubSpot · Ops panel moves stage and costs without leaving Print Ops
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label="Orders summary"
                  data-testid="panel-deals-summary"
                >
                  <span
                    className="rounded border border-border bg-muted/60 px-2 py-1 text-xs tabular-nums text-muted-foreground"
                    data-testid="metric-orders-open"
                  >
                    <span className="font-semibold text-foreground">{snapshot.summary.activeOrders}</span> open
                  </span>
                  <span
                    className="rounded border border-border bg-muted/60 px-2 py-1 text-xs tabular-nums text-muted-foreground"
                    data-testid="metric-orders-value"
                  >
                    <span className="font-semibold text-foreground numeric">{formatMoney(openValue)}</span>
                  </span>
                  <span
                    className={cn(
                      "rounded border px-2 py-1 text-xs tabular-nums",
                      snapshot.summary.attentionCount > 0
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-muted/60 text-muted-foreground",
                    )}
                    data-testid="metric-orders-alerts"
                  >
                    <span className="font-semibold">{snapshot.summary.attentionCount}</span> attention
                  </span>
                </div>
                {emptyColumnCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    onClick={() => setShowEmptyStages((value) => !value)}
                    data-testid="button-toggle-empty-stages"
                  >
                    {showEmptyStages ? "Hide empty stages" : `Show empty (${emptyColumnCount})`}
                  </Button>
                ) : null}
                {closedColumnCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    onClick={() => setShowClosedStages((value) => !value)}
                    data-testid="button-toggle-closed-stages"
                  >
                    {showClosedStages ? "Hide completed & lost" : "Show completed & lost"}
                  </Button>
                ) : null}
              </div>
            </div>

            {snapshot.summary.activeOrders === 0 ? (
              <p className="shrink-0 border-b border-border px-4 py-2.5 text-sm text-muted-foreground" data-testid="empty-deals">
                No open Print Orders right now.{" "}
                <Link href="/orders" className="hs-link font-medium" data-testid="link-deals-to-intake">
                  Start one in Paid Order Intake
                </Link>
              </p>
            ) : null}

            <div className="min-h-0 flex-1 overflow-x-auto overscroll-contain bg-muted/40 p-3 md:p-4">
              {columns.length === 0 ? (
                <div className="flex h-full min-h-[12rem] items-center justify-center rounded-md border border-dashed border-border bg-card/40 px-4">
                  <p className="text-center text-sm text-muted-foreground">
                    {emptyColumnCount > 0
                      ? "All visible stages are empty — show empty stages to see the full pipeline."
                      : "No stages to show for this pipeline view."}
                  </p>
                </div>
              ) : (
                <div className="flex h-full min-w-full items-stretch gap-3">
                  {columns.map((column) => (
                    <div
                      key={column.id}
                      className="flex h-full min-h-0 min-w-[15.5rem] flex-1 flex-col overflow-hidden rounded-md border border-border bg-muted/30"
                      data-testid={`column-deal-stage-${column.id}`}
                    >
                      <div
                        className={cn(
                          "shrink-0 border-b border-border bg-card px-3 py-2",
                          column.closed && /lost/i.test(column.label) && "bg-destructive/10",
                          column.closed && !/lost/i.test(column.label) && "bg-chart-4/10",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p
                            className={cn(
                              "min-w-0 truncate text-sm font-semibold text-foreground",
                              column.closed && /lost/i.test(column.label) && "text-destructive",
                              column.closed && !/lost/i.test(column.label) && "text-chart-4",
                            )}
                          >
                            {column.label}
                          </p>
                          <span className="numeric shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-muted-foreground">
                            {column.deals.length}
                          </span>
                        </div>
                      </div>

                      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2">
                        {column.deals.length === 0 ? (
                          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-2 py-6">
                            <p className="text-center text-xs text-muted-foreground">No orders</p>
                          </div>
                        ) : (
                          column.deals.map((deal) => (
                            <DealCard
                              key={deal.dealId}
                              deal={deal}
                              portalId={portalId}
                              partsSummary={summaryByDeal.get(deal.dealId) ?? null}
                              onOpenOps={() => setOpsDealId(deal.dealId)}
                              onOpenParts={() =>
                                setPartsDeal({ dealId: deal.dealId, dealName: deal.dealName })
                              }
                            />
                          ))
                        )}
                      </div>

                      <div className="shrink-0 border-t border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <span>Total</span>
                          <span className="numeric font-semibold text-foreground">{formatMoney(column.totalAmount)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {opsDealId ? (
        <DealOpsPanel dealId={opsDealId} headers={headers} onClose={() => setOpsDealId(null)} />
      ) : null}

      <OrderPartsDialog
        dealId={partsDeal?.dealId ?? null}
        dealName={partsDeal?.dealName ?? ""}
        open={Boolean(partsDeal)}
        onOpenChange={(next) => {
          if (!next) setPartsDeal(null);
        }}
        headers={headers}
      />
    </div>
  );
}

function DealCard({
  deal,
  portalId,
  partsSummary,
  onOpenOps,
  onOpenParts,
}: {
  deal: BoardDeal;
  portalId: string | null;
  partsSummary: OrderPartSummary | null;
  onOpenOps: () => void;
  onOpenParts: () => void;
}) {
  const closeLabel = formatLocalDate(deal.closeDate);
  const href = hubspotDealHref(deal.dealId, portalId);

  return (
    <article
      className="group shrink-0 rounded-md border border-border bg-card p-2.5 shadow-xs transition-colors hover:border-accent/40"
      data-testid={`card-deal-${deal.dealId}`}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="hs-link block text-sm font-semibold leading-snug"
        data-testid={`link-deal-title-${deal.dealId}`}
      >
        {deal.dealName}
      </a>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-semibold text-foreground numeric">
          <CircleDollarSign className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {formatMoney(deal.amount)}
        </span>
        {deal.contactName ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 truncate">
            <UserRound className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className="truncate">{deal.contactName}</span>
          </span>
        ) : null}
        {closeLabel ? (
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {closeLabel}
          </span>
        ) : null}
      </div>

      {(deal.needsPlates || deal.needsCosts || partsSummary) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {deal.needsPlates ? (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary">
              Needs plates
            </span>
          ) : null}
          {deal.needsCosts ? (
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
              Costs incomplete
            </span>
          ) : null}
          {partsSummary && partsSummary.total > 0 ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide",
                partsSummary.remaining === 0
                  ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
                  : "border-border bg-muted text-muted-foreground",
              )}
              data-testid={`badge-deal-parts-${deal.dealId}`}
            >
              {formatPartsBadge(partsSummary)}
            </span>
          ) : null}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-1.5">
        <button
          type="button"
          onClick={onOpenOps}
          className="hs-link inline-flex items-center gap-1 text-xs font-medium"
          data-testid={`button-deal-ops-${deal.dealId}`}
        >
          Ops / stage
        </button>
        <button
          type="button"
          onClick={onOpenParts}
          className="hs-link inline-flex items-center gap-1 text-xs font-medium"
          data-testid={`button-deal-parts-${deal.dealId}`}
        >
          <Package className="h-3 w-3" />
          Parts
        </button>
        {deal.needsPlates ? (
          <Link
            href={printsDealHref(deal.dealId)}
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-attach-${deal.dealId}`}
          >
            <FileUp className="h-3 w-3" />
            Attach plates
          </Link>
        ) : null}
        {deal.needsCosts ? (
          <Link
            href={queueDealHref(deal.dealId)}
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-costs-${deal.dealId}`}
          >
            Enter costs
          </Link>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          data-testid={`link-deal-hubspot-${deal.dealId}`}
        >
          HubSpot
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </article>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="skeleton-deals">
      <Skeleton className="h-10 w-full shrink-0 rounded-md" />
      <Skeleton className="min-h-0 flex-1 rounded-lg" />
    </div>
  );
}
