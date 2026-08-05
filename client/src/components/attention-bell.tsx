import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { attentionNextStep } from "@/lib/workflow";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

const ISSUE_TONE = {
  neutral: "border-border bg-muted/40",
  warn: "border-chart-3/35 bg-chart-3/10",
  bad: "border-destructive/35 bg-destructive/10",
} as const;

export function AttentionBell() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();

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

  const count = performance.data?.summary.attentionCount ?? 0;
  const items = performance.data?.attention ?? [];
  const portalId = performance.data?.hubspotPortalId;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={count > 0 ? `${count} alerts need attention` : "No alerts"}
          data-testid="button-attention-bell"
        >
          {performance.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
          {count > 0 ? (
            <span
              className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold text-primary-foreground"
              data-testid="badge-attention-count"
            >
              {count > 9 ? "9+" : count}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[22rem] max-w-[calc(100vw-1.5rem)] space-y-3 p-3"
        data-testid="panel-attention-bell"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Alerts</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Open Print Orders that need plates, costs, or a margin check.
            </p>
          </div>
          <Link href="/performance" className="text-xs font-medium text-primary hover:underline" data-testid="link-attention-bell-all">
            View all
          </Link>
        </div>

        {performance.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading alerts…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-md bg-muted/45 p-3" data-testid="empty-attention-bell">
            <p className="text-sm font-medium">You’re clear</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Closed HubSpot deals drop off automatically. Skip individual alerts when an older order doesn’t need that step.
            </p>
          </div>
        ) : (
          <div className="max-h-[22rem] space-y-2 overflow-y-auto pr-0.5">
            {items.map((item) => {
              const next = attentionNextStep({ ...item, portalId });
              return (
                <article
                  key={`${item.dealId}-${item.issueKey}`}
                  className={cn("rounded-md border p-2.5", ISSUE_TONE[item.severity])}
                  data-testid={`row-attention-bell-${item.dealId}-${item.issueKey}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.dealName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.stage} · {item.issue}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate({ dealId: item.dealId, issueKey: item.issueKey })}
                      data-testid={`button-dismiss-attention-${item.dealId}-${item.issueKey}`}
                      title="Skip this alert for this order"
                    >
                      <X className="mr-1 h-3 w-3" />
                      Skip
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{item.detail}</p>
                  <div className="mt-2">
                    {next.external ? (
                      <a
                        href={next.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        {next.label}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <Link href={next.href} className="text-xs font-medium text-primary hover:underline">
                        {next.label}
                      </Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
