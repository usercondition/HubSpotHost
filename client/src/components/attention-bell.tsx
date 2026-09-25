import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AttentionAlertCard } from "@/components/attention-alert-card";
import { HubspotSyncDialog, syncChipLabel } from "@/components/hubspot-sync-chip";
import { useToast } from "@/hooks/use-toast";
import { useShopCounts } from "@/hooks/use-shop-counts";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { HealthResponse, PerformanceResponse } from "@shared/schema";

export function AttentionBell({ rail = false }: { rail?: boolean }) {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();

  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const shop = useShopCounts();
  const syncCount = health.data?.hubspotSync?.issueCount ?? 0;
  const syncPending = health.data?.hubspotSync?.writes?.pending ?? 0;
  const syncFailed = health.data?.hubspotSync?.writes?.failed ?? 0;
  const syncVisible = syncCount > 0 || syncPending > 0 || syncFailed > 0;
  const webhook = health.data?.hubspotSync?.webhook;
  const webhookQuietNote = webhook && webhook.configured && webhook.arriving === false ? webhook.note : "";

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const dismiss = useMutation({
    mutationFn: async (input: { dealId: string; issueKey: string }) => {
      const response = await apiRequest(
        "POST",
        "/api/attention/dismiss",
        { dealId: input.dealId, issueKey: input.issueKey, note: "Skipped from alerts" },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      toast({
        title: "Alert skipped",
        description: "This reminder won’t show again for that order. Closed HubSpot deals also clear automatically.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not skip that alert",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 160),
        variant: "destructive",
      });
    },
  });

  if (!isUnlocked) return null;

  const count = shop.needsYou ?? 0;
  const items = performance.data?.attention ?? [];
  const portalId = performance.data?.hubspotPortalId;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            rail
              ? "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              : "relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          }
          aria-label={count > 0 ? `${count} alerts need attention` : "No alerts"}
          data-testid="button-attention-bell"
        >
          {performance.isFetching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Bell className="h-4 w-4 shrink-0" />}
          {rail ? <span className="truncate">Alerts</span> : null}
          {count > 0 ? (
            <span
              className={
                rail
                  ? "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-chart-4/20 px-1.5 text-xs font-semibold text-chart-4"
                  : "status-alert absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold"
              }
              data-testid="badge-attention-count"
            >
              {count > 9 ? "9+" : count}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={rail ? "right" : "bottom"}
        align="end"
        className="w-[22rem] max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
        data-testid="panel-attention-bell"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Alerts</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Same count as Needs you on Floor.
            </p>
          </div>
          <Link href="/" className="text-xs font-medium text-primary hover:underline" data-testid="link-attention-bell-all">
            Floor
          </Link>
        </div>

        {syncCount === 0 && webhookQuietNote ? (
          <p className="text-xs leading-5 text-muted-foreground" data-testid="text-webhook-sync-note">
            {webhookQuietNote}
          </p>
        ) : null}

        {syncVisible ? (
          <HubspotSyncDialog
            trigger={
              <button
                type="button"
                className="w-full rounded-md bg-chart-4/10 px-3 py-2 text-left"
                data-testid="row-attention-bell-hubspot-sync"
              >
                <p className="text-sm font-semibold text-chart-4">{syncChipLabel(health.data?.hubspotSync)}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {health.data?.hubspotSync?.webhook.note || "Open the list of drifted deals."}
                </p>
              </button>
            }
          />
        ) : null}

        {performance.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading alerts…
          </div>
        ) : shop.needs.length === 0 && !syncVisible ? (
          <div className="rounded-md bg-muted/45 p-3" data-testid="empty-attention-bell">
            <p className="text-sm font-medium">You’re clear</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Closed HubSpot deals drop off automatically. Skip individual alerts when an older order doesn’t need that step.
            </p>
          </div>
        ) : (
          <div className="max-h-[22rem] space-y-2 overflow-y-auto pr-0.5">
            {shop.needs.map((need) => {
              const item = items.find((entry) => entry.dealId === need.dealId && entry.issueKey === need.issueKey);
              if (item) {
                return (
                  <AttentionAlertCard
                    key={need.key}
                    item={item}
                    portalId={portalId}
                    dense
                    dismissPending={dismiss.isPending}
                    onDismiss={() => dismiss.mutate({ dealId: item.dealId, issueKey: item.issueKey })}
                    testId={`row-attention-bell-${item.dealId}-${item.issueKey}`}
                  />
                );
              }
              return (
                <Link
                  key={need.key}
                  href={need.href}
                  className="block rounded-md bg-muted/45 px-3 py-2"
                  data-testid={need.testId}
                >
                  <p className="text-sm font-medium">{need.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{need.problem}</p>
                </Link>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
