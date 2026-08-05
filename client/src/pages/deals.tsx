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
  RefreshCw,
  Store,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, hubspotDealsListHref, printsDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { formatMoney, formatLocalDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

type BoardDeal = PerformanceResponse["activeDeals"][number] & {
  needsCosts: boolean;
  needsPlates: boolean;
  alerts: PerformanceResponse["attention"];
};

/**
 * Orders board — at-a-glance Print Orders pipeline, HubSpot-style columns.
 * Stage moves stay in HubSpot; this page is the owner’s daily glance.
 */
export default function DealsPage() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Orders unlocked",
    successDescription: "Live HubSpot stages and open print jobs, without leaving Print Operations.",
  });
  const [showClosedStages, setShowClosedStages] = useState(false);

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const snapshot = performance.data;
  const portalId = snapshot?.hubspotPortalId ?? null;

  const { columns, openValue, closedColumnCount } = useMemo(() => {
    if (!snapshot) {
      return { columns: [], openValue: 0, closedColumnCount: 0 };
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

    const allColumns = snapshot.pipeline.map((stage) => {
      const deals = byStage.get(stage.id) ?? [];
      const totalAmount = deals.reduce((sum, deal) => sum + deal.amount, 0);
      return { ...stage, deals, totalAmount };
    });

    const closedColumnCount = allColumns.filter((column) => column.closed).length;
    const columns = showClosedStages ? allColumns : allColumns.filter((column) => !column.closed);

    return { columns, openValue, closedColumnCount };
  }, [snapshot, showClosedStages]);

  return (
    <div className="mx-auto flex max-w-[100rem] flex-col">
      <PageHeader
        title="Orders"
        subtitle="At-a-glance Print Orders board — same stages as HubSpot."
        actions={
          <>
            {isUnlocked ? (
              <>
                <Button asChild size="sm" variant="outline" data-testid="button-open-hubspot-deals">
                  <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
                    <Store className="mr-2 h-3.5 w-3.5" />
                    HubSpot board
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

      <div className="page-stack">
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
          <>
            <section
              className="grid gap-3 sm:grid-cols-3"
              aria-label="Orders summary"
              data-testid="panel-deals-summary"
            >
              <SummaryStat
                label="Open orders"
                value={String(snapshot.summary.activeOrders)}
                hint="Deals still moving through Print Orders"
                testId="metric-orders-open"
              />
              <SummaryStat
                label="Open pipeline value"
                value={formatMoney(openValue)}
                hint="Sum of amounts on open board cards"
                testId="metric-orders-value"
              />
              <SummaryStat
                label="Needs attention"
                value={String(snapshot.summary.attentionCount)}
                hint={
                  snapshot.summary.attentionCount > 0
                    ? "Plates, costs, or other alerts — see card badges"
                    : "No open alerts on this board"
                }
                warn={snapshot.summary.attentionCount > 0}
                testId="metric-orders-alerts"
              />
            </section>

            <section
              className="overflow-hidden rounded-md border border-card-border bg-card"
              data-testid="panel-deals-board"
              aria-label="Print Orders pipeline board"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <p className="text-sm font-semibold tracking-tight">Print Orders</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Read-only glance · drag stages in HubSpot
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                  <StatusPill
                    tone={snapshot.summary.attentionCount > 0 ? "warn" : "good"}
                    icon={snapshot.summary.attentionCount > 0 ? AlertTriangle : CircleDollarSign}
                    label={`${snapshot.summary.activeOrders} open · ${formatMoney(openValue)}`}
                    testId="status-orders-board"
                  />
                </div>
              </div>

              <div className="overflow-x-auto bg-muted/40 p-3 md:p-4">
                <div className="flex min-h-[28rem] min-w-max items-stretch gap-3">
                  {columns.map((column) => (
                    <div
                      key={column.id}
                      className="flex w-[17rem] shrink-0 flex-col rounded-md border border-border bg-muted/30"
                      data-testid={`column-deal-stage-${column.id}`}
                    >
                      <div
                        className={cn(
                          "rounded-t-md border-b border-border bg-card px-3 py-2.5",
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

                      <div className="flex flex-1 flex-col gap-2 p-2">
                        {column.deals.length === 0 ? (
                          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-2 py-10">
                            <p className="text-center text-xs text-muted-foreground">No orders</p>
                          </div>
                        ) : (
                          column.deals.map((deal) => (
                            <DealCard key={deal.dealId} deal={deal} portalId={portalId} />
                          ))
                        )}
                      </div>

                      <div className="mt-auto space-y-1 rounded-b-md border-t border-border bg-card/80 px-3 py-2 text-xs text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <span>Total</span>
                          <span className="numeric font-semibold text-foreground">{formatMoney(column.totalAmount)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {snapshot.summary.activeOrders === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="empty-deals">
                No open Print Orders right now.{" "}
                <Link href="/orders" className="hs-link font-medium" data-testid="link-deals-to-intake">
                  Start one in Paid Order Intake
                </Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  hint,
  warn,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
  testId: string;
}) {
  return (
    <div className="rounded-md border border-card-border bg-card px-4 py-3" data-testid={testId}>
      <p className="rule-label">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight numeric", warn && "text-primary")}>{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

function DealCard({
  deal,
  portalId,
}: {
  deal: BoardDeal;
  portalId: string | null;
}) {
  const closeLabel = formatLocalDate(deal.closeDate);
  const href = hubspotDealHref(deal.dealId, portalId);

  return (
    <article
      className="group rounded-md border border-border bg-card p-3 shadow-xs transition-colors hover:border-accent/40"
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

      <dl className="mt-2.5 space-y-1.5 text-xs text-muted-foreground">
        {closeLabel ? (
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <dt className="sr-only">Close date</dt>
            <dd>{closeLabel}</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <CircleDollarSign className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <dt className="sr-only">Amount</dt>
          <dd className="font-semibold text-foreground numeric">{formatMoney(deal.amount)}</dd>
        </div>
        {deal.contactName ? (
          <div className="flex items-center gap-2">
            <UserRound className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <dt className="sr-only">Contact</dt>
            <dd className="truncate">{deal.contactName}</dd>
          </div>
        ) : null}
      </dl>

      {(deal.needsPlates || deal.needsCosts) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
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
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-2">
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
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-costs-${deal.dealId}`}
          >
            Update costs
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          data-testid={`link-deal-hubspot-${deal.dealId}`}
        >
          Open in HubSpot
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </article>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-3" data-testid="skeleton-deals">
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-[4.5rem] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-[28rem] rounded-lg" />
    </div>
  );
}
