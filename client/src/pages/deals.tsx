import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Boxes,
  ExternalLink,
  FileUp,
  Loader2,
  RefreshCw,
  Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, hubspotDealsListHref, printsDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession } from "@/hooks/use-owner-session";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

function money(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

type BoardDeal = PerformanceResponse["activeDeals"][number] & {
  needsCosts: boolean;
};

export default function DealsPage() {
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
        title: "Orders unlocked",
        description: `${snapshot.summary.activeOrders} open Print Order${snapshot.summary.activeOrders === 1 ? "" : "s"} in view.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "That owner code was not accepted",
        description: error.message.startsWith("401")
          ? "Check the code and try again. Nothing was unlocked."
          : "Could not reach HubSpot order data. Try again shortly.",
        variant: "destructive",
      });
    },
  });

  const snapshot = performance.data;
  const portalId = snapshot?.hubspotPortalId ?? null;

  const columns = useMemo(() => {
    if (!snapshot) return [];
    const costs = new Set(
      snapshot.attention.filter((item) => item.issueKey === "costs_incomplete").map((item) => item.dealId),
    );
    const byStage = new Map<string, BoardDeal[]>();
    for (const deal of snapshot.activeDeals) {
      const key = deal.stageId || deal.stage;
      const list = byStage.get(key) ?? [];
      list.push({ ...deal, needsCosts: costs.has(deal.dealId) });
      byStage.set(key, list);
    }

    return snapshot.pipeline.map((stage) => {
      const deals = byStage.get(stage.id) ?? [];
      const totalAmount = deals.reduce((sum, deal) => sum + deal.amount, 0);
      return { ...stage, deals, totalAmount };
    });
  }, [snapshot]);

  return (
    <div className="mx-auto max-w-[100rem]">
      <PageHeader
        title="Orders"
        subtitle="Your Print Orders pipeline board — same stages as HubSpot, with plate and cost actions in this hub."
        actions={
          <>
            {isUnlocked ? (
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
            ) : null}
            <ThemeToggle />
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock your Print Orders board"
            description="Same owner code as the rest of Daily Work. Pulls live HubSpot pipeline stages and open deals."
            buttonLabel="Unlock Orders"
            testIdPrefix="deals"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <Skeleton className="h-[28rem] rounded-lg" data-testid="skeleton-deals" />
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
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-card-border bg-card px-5 py-4"
              data-testid="panel-deals-hubspot-escape"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="rule-label">Print Orders pipeline</p>
                  <StatusPill
                    tone={snapshot.summary.attentionCount > 0 ? "warn" : "good"}
                    icon={Boxes}
                    label={`${snapshot.summary.activeOrders} open`}
                    testId="status-deals-attention"
                  />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Board mirrors your HubSpot stages. Dragging between stages still happens in HubSpot.
                </p>
              </div>
              <Button asChild data-testid="button-open-hubspot-deals">
                <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
                  <Store className="mr-2 h-4 w-4" />
                  Open board in HubSpot
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            </section>

            <section
              className="overflow-x-auto rounded-lg border border-card-border bg-card"
              data-testid="panel-deals-board"
              aria-label="Print Orders pipeline board"
            >
              <div className="flex min-w-max gap-3 p-4">
                {columns.map((column) => (
                  <div
                    key={column.id}
                    className="flex w-[15.5rem] shrink-0 flex-col"
                    data-testid={`column-deal-stage-${column.id}`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2 px-1">
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "truncate text-sm font-semibold",
                            column.closed && /lost/i.test(column.label)
                              ? "text-destructive"
                              : column.closed
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-foreground",
                          )}
                        >
                          {column.label}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground numeric">
                          {column.deals.length} deal{column.deals.length === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>

                    <div
                      className={cn(
                        "flex min-h-[18rem] flex-1 flex-col gap-2 rounded-md border border-border/80 bg-muted/35 p-2",
                        column.closed && "bg-muted/20",
                      )}
                    >
                      {column.deals.length === 0 ? (
                        <p className="px-1 py-6 text-center text-xs text-muted-foreground">No deals</p>
                      ) : (
                        column.deals.map((deal) => (
                          <article
                            key={deal.dealId}
                            className="rounded-md border border-border bg-card p-3 shadow-sm"
                            data-testid={`card-deal-${deal.dealId}`}
                          >
                            <p className="text-sm font-medium leading-5">{deal.dealName}</p>
                            <p className="mt-1 text-sm font-semibold numeric">{money(deal.amount)}</p>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                              {!deal.hasPlates ? (
                                <Link
                                  href={printsDealHref(deal.dealId)}
                                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                  data-testid={`link-deal-attach-${deal.dealId}`}
                                >
                                  <FileUp className="h-3 w-3" />
                                  Attach plates
                                </Link>
                              ) : null}
                              {deal.needsCosts ? (
                                <a
                                  href={hubspotDealHref(deal.dealId, portalId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                  data-testid={`link-deal-costs-${deal.dealId}`}
                                >
                                  Update costs
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : null}
                              <a
                                href={hubspotDealHref(deal.dealId, portalId)}
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
                        ))
                      )}
                    </div>

                    <div className="mt-2 space-y-0.5 px-1 text-xs text-muted-foreground">
                      <p className="flex justify-between gap-2">
                        <span>Total</span>
                        <span className="numeric font-medium text-foreground">{money(column.totalAmount)}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {snapshot.summary.activeOrders === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="empty-deals">
                No open Print Orders right now.{" "}
                <Link href="/orders" className="font-medium text-primary hover:underline" data-testid="link-deals-to-intake">
                  Open Paid Order Intake
                </Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
