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
import { Panel, StatusPill } from "@/components/primitives";
import type { PerformanceResponse } from "@shared/schema";

function money(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  });
}

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
  const deals = snapshot?.activeDeals ?? [];
  const costsByDeal = new Map(
    (snapshot?.attention ?? [])
      .filter((item) => item.issueKey === "costs_incomplete")
      .map((item) => [item.dealId, item] as const),
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Orders"
        subtitle="Open Print Orders from HubSpot — act on plates and costs here, open the full CRM when you need to edit a deal."
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
            title="Unlock your open Print Orders"
            description="Same owner code as the rest of Daily Work. Pulls live HubSpot deals without leaving Print Operations."
            buttonLabel="Unlock Orders"
            testIdPrefix="deals"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <Skeleton className="h-64 rounded-lg" data-testid="skeleton-deals" />
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
                <p className="rule-label">HubSpot CRM</p>
                <p className="mt-1 text-sm font-medium">Need the full deals board?</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  HubSpot can’t open inside this page, so the CRM opens in a new tab when you need stages, notes, or cost fields.
                </p>
              </div>
              <Button asChild data-testid="button-open-hubspot-deals">
                <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
                  <Store className="mr-2 h-4 w-4" />
                  Open deals in HubSpot
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            </section>

            <Panel
              title="Open Print Orders"
              description={`${snapshot.summary.activeOrders} active deal${snapshot.summary.activeOrders === 1 ? "" : "s"} in your Print Orders pipeline.`}
              actions={
                <StatusPill
                  tone={snapshot.summary.attentionCount > 0 ? "warn" : "good"}
                  icon={Boxes}
                  label={
                    snapshot.summary.attentionCount > 0
                      ? `${snapshot.summary.attentionCount} alert${snapshot.summary.attentionCount === 1 ? "" : "s"}`
                      : "Clear"
                  }
                  testId="status-deals-attention"
                />
              }
            >
              {deals.length === 0 ? (
                <div className="rounded-md bg-muted/50 p-4" data-testid="empty-deals">
                  <p className="text-sm font-medium">No open Print Orders right now</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    New deals appear here after you approve a paid order into HubSpot.
                  </p>
                  <Link href="/orders" className="mt-3 inline-flex text-sm font-medium text-primary hover:underline" data-testid="link-deals-to-intake">
                    Open Paid Order Intake
                  </Link>
                </div>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border" data-testid="list-deals">
                  {deals.map((deal) => {
                    const costIssue = costsByDeal.get(deal.dealId);
                    const showAttach = !deal.hasPlates;
                    return (
                      <li
                        key={deal.dealId}
                        className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                        data-testid={`row-deal-${deal.dealId}`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{deal.dealName}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {deal.stage}
                            {deal.amount > 0 ? ` · ${money(deal.amount)}` : ""}
                          </p>
                          {costIssue ? (
                            <p className="mt-1 text-xs text-muted-foreground">{costIssue.detail}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-3">
                          {showAttach ? (
                            <Link
                              href={printsDealHref(deal.dealId)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                              data-testid={`link-deal-attach-${deal.dealId}`}
                            >
                              <FileUp className="h-3 w-3" />
                              Attach plates
                            </Link>
                          ) : null}
                          {costIssue ? (
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
                      </li>
                    );
                  })}
                </ul>
              )}
              {snapshot.summary.activeOrders > deals.length ? (
                <p className="mt-3 text-xs text-muted-foreground" data-testid="text-deals-truncated">
                  Showing {deals.length} of {snapshot.summary.activeOrders} open orders. Open HubSpot for the full list.
                </p>
              ) : null}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
