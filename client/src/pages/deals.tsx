import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
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

/**
 * Left-nav Orders page: a read-only transcript of the Print Orders pipeline
 * stages, laid out like the HubSpot CRM board. Stage moves still happen in HubSpot.
 */
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
        description: `${snapshot.summary.activeOrders} open Print Order${snapshot.summary.activeOrders === 1 ? "" : "s"} on the board.`,
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
        subtitle="Where each print sits in the pipeline — same stages as your HubSpot Print Orders board."
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
            <ThemeToggle />
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the Orders board"
            description="Same owner code as Daily Work. Shows live HubSpot pipeline stages and which print is in each one."
            buttonLabel="Unlock Orders"
            testIdPrefix="deals"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <Skeleton className="h-[32rem] rounded-lg" data-testid="skeleton-deals" />
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
            className="rounded-lg border border-border bg-muted/30"
            data-testid="panel-deals-board"
            aria-label="Print Orders pipeline board"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <p className="text-sm font-medium">
                Print Orders
                <span className="ml-2 text-xs font-normal text-muted-foreground numeric">
                  {snapshot.summary.activeOrders} open
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Read-only here · move stages in HubSpot
              </p>
            </div>

            <div className="overflow-x-auto">
              <div className="flex min-w-max items-stretch gap-0">
                {columns.map((column, index) => (
                  <div
                    key={column.id}
                    className={cn(
                      "flex w-[16rem] shrink-0 flex-col border-border",
                      index > 0 && "border-l",
                    )}
                    data-testid={`column-deal-stage-${column.id}`}
                  >
                    <div
                      className={cn(
                        "border-b border-border px-3 py-2.5",
                        column.closed && /lost/i.test(column.label)
                          ? "bg-destructive/10"
                          : column.closed
                            ? "bg-emerald-500/10"
                            : "bg-background/80",
                      )}
                    >
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
                        {column.deals.length}
                      </p>
                    </div>

                    <div className="flex min-h-[22rem] flex-1 flex-col gap-2 bg-muted/20 p-2">
                      {column.deals.length === 0 ? (
                        <p className="px-1 py-8 text-center text-xs text-muted-foreground">—</p>
                      ) : (
                        column.deals.map((deal) => (
                          <article
                            key={deal.dealId}
                            className="rounded-md border border-border bg-card p-3"
                            data-testid={`card-deal-${deal.dealId}`}
                          >
                            <p className="text-sm font-medium leading-snug">{deal.dealName}</p>
                            <p className="mt-1.5 text-base font-semibold numeric tracking-tight">
                              {money(deal.amount)}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-2">
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
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </article>
                        ))
                      )}
                    </div>

                    <div className="border-t border-border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                      <div className="flex justify-between gap-2">
                        <span>Total amount</span>
                        <span className="numeric font-medium text-foreground">{money(column.totalAmount)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
