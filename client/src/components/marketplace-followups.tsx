import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageSquareWarning, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import type { ConversationFollowUp } from "@shared/schema";

type WatchlistResponse = {
  ok: true;
  count: number;
  waitingOnYou: number;
  followUps: ConversationFollowUp[];
};

export function MarketplaceFollowUpsPanel({ headers }: { headers: Record<string, string> }) {
  const query = useQuery<WatchlistResponse>({
    queryKey: ["/api/conversation-watchlist", "waitingOnYou"],
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        "/api/conversation-watchlist?waitingOnYou=1",
        undefined,
        { headers },
      );
      return (await response.json()) as WatchlistResponse;
    },
    refetchInterval: 60_000,
  });

  const snooze = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/conversation-watchlist/${id}/snooze`, { hours: 24 }, { headers });
    },
    onSuccess: () => query.refetch(),
  });

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/conversation-watchlist/${id}/dismiss`, {}, { headers });
    },
    onSuccess: () => query.refetch(),
  });

  const rows = query.data?.followUps ?? [];

  return (
    <section
      className="rounded-lg border border-card-border bg-card p-5"
      aria-labelledby="marketplace-followups-title"
      data-testid="panel-marketplace-followups"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="rule-label text-primary">Marketplace</p>
          <h2 id="marketplace-followups-title" className="mt-1 text-lg font-semibold tracking-tight">
            Chat follow-ups
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            From the Chrome helper watchlist — buried buyers waiting on your reply, payment claims, and
            intake nudges. Full threads are not stored.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          data-testid="button-refresh-marketplace-followups"
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {query.isError ? (
        <p className="mt-4 text-sm text-destructive" data-testid="text-marketplace-followups-error">
          Could not load Marketplace follow-ups.
        </p>
      ) : null}

      {rows.length === 0 && !query.isLoading ? (
        <div className="mt-4 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No chats waiting on you yet. Install{" "}
          <code className="text-xs">chrome-extension/marketplace-scan</code>, scan an open Marketplace
          thread, and it will show up here (and in the Telegram digest).
        </div>
      ) : null}

      <ul className="mt-4 space-y-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-md border border-border bg-background/60 px-4 py-3"
            data-testid={`marketplace-followup-${row.id}`}
          >
            <div className="flex flex-wrap items-start gap-2">
              <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-5">{row.reminder}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.stageLabel}
                  {row.hoursWaiting != null ? ` · ~${Math.round(row.hoursWaiting)}h since last activity` : ""}
                </p>
                {row.suggestedReply ? (
                  <p className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-foreground">
                    {row.suggestedReply}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {row.threadUrl ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={row.threadUrl} target="_blank" rel="noopener noreferrer">
                        Open thread
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={snooze.isPending}
                    onClick={() => snooze.mutate(row.id)}
                  >
                    Snooze 24h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(row.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
