import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  WalletCards,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useDismissAttention } from "@/hooks/use-dismiss-attention";
import { apiRequest } from "@/lib/queryClient";
import { attentionNextStep, hubspotDealsListHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession } from "@/hooks/use-owner-session";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { BooksBalancePanel } from "@/components/books-balance";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function updatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Updated just now";
  return `Updated ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

const ISSUE_TONE = {
  neutral: "border-border bg-muted/45",
  warn: "border-primary/35 bg-primary/5",
  bad: "border-destructive/35 bg-destructive/5",
} as const;

function LoadingMetrics() {
  return (
    <div className="space-y-5" data-testid="skeleton-performance">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    </div>
  );
}

export default function Performance() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers, unlock: setSessionUnlocked } = useOwnerSession();

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const dismissAttention = useDismissAttention("performance");

  const unlock = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("GET", "/api/performance", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return { code, snapshot: (await response.json()) as PerformanceResponse };
    },
    onSuccess: ({ code, snapshot }) => {
      setSessionUnlocked(code);
      toast({
        title: "Performance unlocked",
        description: `${snapshot.summary.activeOrders} active print order${snapshot.summary.activeOrders === 1 ? "" : "s"} are in view.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "That owner code was not accepted",
        description: error.message.startsWith("401")
          ? "Check the code and try again. Nothing was unlocked."
          : "The performance service could not be reached. Check the HubSpot connection and try again.",
        variant: "destructive",
      });
    },
  });

  const snapshot = performance.data;
  const maxPipelineCount = Math.max(1, ...(snapshot?.pipeline.map((stage) => stage.count) ?? [0]));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Performance"
        subtitle="A read-only daily view of orders, margins, workload, and supply spending."
        actions={
          <>
            {ownerCode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => performance.refetch()}
                disabled={performance.isFetching}
                data-testid="button-refresh-performance"
              >
                {performance.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
            <ThemeToggle />
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock your live business metrics"
            description="Enter your owner access code to pull read-only order, pipeline, margin, and supply-spend data."
            buttonLabel="Unlock performance"
            testIdPrefix="performance"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <LoadingMetrics />
        ) : performance.isError || !snapshot ? (
          <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-performance-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <h2 className="text-base font-semibold tracking-tight">Performance is not available right now</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  The command center could not read the Print Orders pipeline. Refresh after checking your HubSpot connection or access code.
                </p>
                <Button className="mt-4" size="sm" onClick={() => performance.refetch()} data-testid="button-retry-performance">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3" data-testid="summary-performance-status">
              <div>
                <p className="rule-label">Decision view</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Last {snapshot.period.days} days of new Print Orders. {updatedAt(snapshot.generatedAt)}.
                </p>
              </div>
              <StatusPill
                tone={snapshot.summary.attentionCount > 0 ? "warn" : "good"}
                icon={snapshot.summary.attentionCount > 0 ? AlertTriangle : ShieldCheck}
                label={snapshot.summary.attentionCount > 0 ? `${snapshot.summary.attentionCount} item${snapshot.summary.attentionCount === 1 ? "" : "s"} need attention` : "No active alerts"}
                testId="status-performance-attention"
              />
            </section>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Performance summary">
              <StatCard
                label="Revenue"
                value={money(snapshot.summary.revenue)}
                hint={`New orders in the last ${snapshot.period.days} days`}
                icon={CircleDollarSign}
                testId="metric-revenue"
              />
              <StatCard
                label="Gross profit"
                value={money(snapshot.summary.grossProfit)}
                hint="From actual cost fields on your HubSpot deals"
                icon={WalletCards}
                tone={snapshot.summary.grossProfit >= 0 ? "good" : "bad"}
                testId="metric-gross-profit"
              />
              <StatCard
                label="Weighted margin"
                value={percent(snapshot.summary.weightedMarginPercent)}
                hint={`Watch orders below ${snapshot.thresholds.marginPercent}%`}
                icon={TrendingUp}
                tone={snapshot.summary.weightedMarginPercent < snapshot.thresholds.marginPercent ? "warn" : "good"}
                testId="metric-margin"
              />
              <StatCard
                label="Orders"
                value={String(snapshot.summary.orders)}
                hint={`Average order value ${money(snapshot.summary.averageOrderValue)}`}
                icon={ClipboardList}
                testId="metric-orders"
              />
              <StatCard
                label="Supply spend"
                value={money(snapshot.supplySpend.total)}
                hint={`${snapshot.supplySpend.purchases} receipt${snapshot.supplySpend.purchases === 1 ? "" : "s"} logged in ${snapshot.supplySpend.periodDays} days`}
                icon={Package}
                tone="neutral"
                testId="metric-supply-spend"
              />
              <StatCard
                label="Active print orders"
                value={String(snapshot.summary.activeOrders)}
                hint="Deals still moving through your Print Orders pipeline"
                icon={Boxes}
                testId="metric-active-orders"
              />
            </section>

            <section className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
              <Panel
                title="Needs attention"
                description="Same inbox as the bell next to Print Operations. Skip steps that don’t apply to legacy orders."
                actions={
                  <a
                    href={hubspotDealsListHref(snapshot.hubspotPortalId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-primary hover:underline"
                    data-testid="link-performance-hubspot"
                  >
                    Open HubSpot
                  </a>
                }
              >
                {snapshot.attention.length > 0 ? (
                  <div className="space-y-2">
                    {snapshot.attention.map((item) => {
                      const next = attentionNextStep({
                        ...item,
                        portalId: snapshot.hubspotPortalId,
                      });
                      return (
                        <article
                          key={`${item.dealId}-${item.issueKey}`}
                          className={cn("rounded-md border p-3", ISSUE_TONE[item.severity])}
                          data-testid={`row-attention-${item.dealId}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <h3 className="text-sm font-medium">{item.dealName}</h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">{item.stage}</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill
                                tone={item.severity}
                                icon={item.severity === "bad" ? AlertTriangle : ClipboardList}
                                label={item.issue}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                disabled={dismissAttention.isPending}
                                onClick={() =>
                                  dismissAttention.mutate({ dealId: item.dealId, issueKey: item.issueKey })
                                }
                                data-testid={`button-dismiss-attention-${item.dealId}-${item.issueKey}`}
                              >
                                <X className="mr-1 h-3 w-3" />
                                Skip
                              </Button>
                            </div>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                          <div className="mt-2">
                            {next.external ? (
                              <a
                                href={next.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                data-testid={`link-attention-action-${item.dealId}`}
                              >
                                {next.label}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <Link
                                href={next.href}
                                className="text-xs font-medium text-primary hover:underline"
                                data-testid={`link-attention-action-${item.dealId}`}
                              >
                                {next.label}
                              </Link>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/50 p-4" data-testid="empty-performance-attention">
                    <p className="text-sm font-medium">Your active orders look clear.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Closed HubSpot deals leave this list automatically. Skip plate or cost reminders for older orders that don’t need them.
                    </p>
                  </div>
                )}
              </Panel>

              <Panel title="Pipeline workload" description="Live count by Print Orders stage.">
                <div className="space-y-3">
                  {snapshot.pipeline.map((stage) => (
                    <div key={stage.id} data-testid={`row-pipeline-${stage.id}`}>
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate font-medium">{stage.label}</span>
                        <span className="numeric shrink-0 text-muted-foreground">
                          {stage.count} {stage.closed ? "closed" : "active"}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn("h-full rounded-full", stage.closed ? "bg-muted-foreground/45" : "bg-primary")}
                          style={{ width: `${(stage.count / maxPipelineCount) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </section>

            <BooksBalancePanel books={snapshot.books} showSuppliesLink />

            <section className="grid gap-5 lg:grid-cols-2">
              <Panel title="Paid order intake" description="Your queue before an order becomes a HubSpot deal.">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Awaiting buyer", snapshot.intake.awaitingClient],
                    ["Needs review", snapshot.intake.pendingReview],
                    ["Approved", snapshot.intake.approved],
                  ].map(([label, count]) => (
                    <div key={String(label)} className="rounded-md bg-muted/50 p-3" data-testid={`metric-intake-${String(label).toLowerCase().replaceAll(" ", "-")}`}>
                      <p className="rule-label">{label}</p>
                      <p className="mt-1 text-base font-semibold">{count}</p>
                    </div>
                  ))}
                </div>
                <Link href="/orders" className="mt-4 inline-flex text-sm font-medium text-primary hover:underline" data-testid="link-performance-order-intake">
                  Open paid order intake
                </Link>
              </Panel>

              <Panel
                title="Supply spend detail"
                description="Receipt totals by category from the Supply Spend ledger."
                actions={
                  <Link href="/supplies" className="text-xs font-medium text-primary hover:underline" data-testid="link-performance-supplies">
                    Open supply spend
                  </Link>
                }
              >
                {snapshot.supplySpend.byCategory.length > 0 ? (
                  <div className="space-y-2">
                    {snapshot.supplySpend.byCategory.map((bucket) => (
                      <div key={bucket.category} className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2" data-testid={`row-supply-category-${bucket.category}`}>
                        <span className="text-sm">{bucket.label}</span>
                        <span className="numeric text-sm font-medium">
                          {money(bucket.total)} <span className="text-xs font-normal text-muted-foreground">({bucket.count})</span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/50 p-4" data-testid="empty-supply-spend">
                    <p className="text-sm font-medium">No supply receipts logged yet.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Add resin, gloves, packaging, and maintenance purchases as they happen to establish a useful monthly baseline.
                    </p>
                  </div>
                )}
              </Panel>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
