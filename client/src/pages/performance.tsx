import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  Unlock,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader, ThemeToggle } from "@/components/shell";
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

function LockedPanel({
  codeDraft,
  setCodeDraft,
  onUnlock,
  pending,
}: {
  codeDraft: string;
  setCodeDraft: (value: string) => void;
  onUnlock: () => void;
  pending: boolean;
}) {
  return (
    <section
      className="mx-auto max-w-lg rounded-lg border border-card-border bg-card p-5 md:p-6"
      aria-labelledby="performance-unlock-title"
      data-testid="panel-performance-unlock"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
        <KeyRound className="h-4 w-4" />
      </div>
      <p className="mt-4 rule-label">Owner access</p>
      <h2 id="performance-unlock-title" className="mt-1 text-lg font-semibold tracking-tight">
        Unlock your live business metrics
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Enter your owner access code to pull read-only order, pipeline, margin, and supply-spend data. The code stays only in this page while it is open.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onUnlock();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="performance-owner-code">Owner access code</Label>
          <Input
            id="performance-owner-code"
            type="password"
            autoComplete="off"
            value={codeDraft}
            onChange={(event) => setCodeDraft(event.target.value)}
            placeholder="Enter your code"
            data-testid="input-performance-owner-code"
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending || codeDraft.trim().length === 0} data-testid="button-unlock-performance">
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
          Unlock performance
        </Button>
      </form>
    </section>
  );
}

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
  const [codeDraft, setCodeDraft] = useState("");
  const [ownerCode, setOwnerCode] = useState("");
  const headers = useMemo(() => ({ "x-paid-order-access-code": ownerCode }), [ownerCode]);

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: ownerCode.length > 0,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const unlock = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("GET", "/api/performance", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return { code, snapshot: (await response.json()) as PerformanceResponse };
    },
    onSuccess: ({ code, snapshot }) => {
      setOwnerCode(code);
      setCodeDraft("");
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

      <div className="space-y-5 px-4 py-5 md:px-6">
        {!ownerCode ? (
          <LockedPanel
            codeDraft={codeDraft}
            setCodeDraft={setCodeDraft}
            onUnlock={() => unlock.mutate(codeDraft.trim())}
            pending={unlock.isPending}
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
                description="The highest-impact active orders to check first."
                actions={
                  <a
                    href="https://app.hubspot.com/"
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
                    {snapshot.attention.map((item) => (
                      <article
                        key={`${item.dealId}-${item.issue}`}
                        className={cn("rounded-md border p-3", ISSUE_TONE[item.severity])}
                        data-testid={`row-attention-${item.dealId}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-medium">{item.dealName}</h3>
                            <p className="mt-0.5 text-xs text-muted-foreground">{item.stage}</p>
                          </div>
                          <StatusPill
                            tone={item.severity}
                            icon={item.severity === "bad" ? AlertTriangle : ClipboardList}
                            label={item.issue}
                          />
                        </div>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/50 p-4" data-testid="empty-performance-attention">
                    <p className="text-sm font-medium">Your active orders look clear.</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      This panel will highlight low margins, stale deals, or incomplete cost details as they appear.
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
                title="Supply spend"
                description="Receipt totals are operational spend, separate from per-order actual costs."
                actions={
                  <Link href="/supplies" className="text-xs font-medium text-primary hover:underline" data-testid="link-performance-supplies">
                    Log a purchase
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
                <p className="mt-4 text-xs leading-5 text-muted-foreground">
                  Do not subtract this total from gross profit here. Add an actual material, labor, packaging, or shipping cost on the individual HubSpot deal when it belongs to that order.
                </p>
              </Panel>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
