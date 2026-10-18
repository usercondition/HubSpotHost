import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { FollowupDialog, type FollowupDraft } from "@/components/followup-dialog";
import type { Followup, InboxCardView, InboxOutboundView, InboxRefreshView } from "@shared/inbox";
import { InboxChat } from "@/components/inbox-chat";
import { heartbeatLabel, needsMe, refreshBusy } from "@/lib/inbox-live";

type CardsResponse = {
  ok: boolean;
  cards: InboxCardView[];
  lastPushAt: string | null;
  lastCheckinAt?: string | null;
  liveMirror?: boolean;
  sourceUpdatedAt: string | null;
  refresh?: InboxRefreshView | null;
  outbound?: InboxOutboundView[];
  pushConfigured: boolean;
  notionConfigured: boolean;
};

/** Query string inside the hash route (`#/inbox?tab=chats&thread=…`), reactive to hash changes. */
function useHashSearch(): string {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      window.addEventListener("popstate", cb);
      return () => {
        window.removeEventListener("hashchange", cb);
        window.removeEventListener("popstate", cb);
      };
    },
    () => window.location.hash,
    () => "",
  );
  const i = hash.indexOf("?");
  return i >= 0 ? hash.slice(i + 1) : window.location.search.replace(/^\?/, "");
}


function fmtTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT`;
}

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}


function FollowupRow({ f, headers }: { f: Followup; headers: Record<string, string> }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [date, setDate] = useState(f.reminderDate ?? "");
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/followups/${f.id}`, body, { headers })).json(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/followups"] }),
    onError: (e: Error) => toast({ title: "Could not update", description: e.message, variant: "destructive" }),
  });
  const overdue = f.status === "open" && f.reminderDate && f.reminderDate <= todayPT();
  return (
    <article className="rounded-md border border-border bg-card px-3 py-2.5" data-testid={`followup-${f.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{f.client}</strong>
          <span className="truncate text-xs text-muted-foreground">{f.listing}</span>
          <StatusPill tone={overdue ? "bad" : f.status === "done" ? "good" : "neutral"} label={overdue ? "due" : f.status} />
          {f.notionUrl ? (
            <a className="hs-link text-xs" href={f.notionUrl} target="_blank" rel="noreferrer">Notion</a>
          ) : (
            <span className="text-xs text-muted-foreground" title={f.notionError ?? ""}>local only</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Input type="date" className="h-8 w-40" value={date} onChange={(e) => setDate(e.target.value)} onBlur={() => date !== (f.reminderDate ?? "") && patch.mutate({ reminderDate: date || null })} />
          {f.status !== "done" ? (
            <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: "done" })}>Done</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => patch.mutate({ status: "open" })}>Reopen</Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm"><span className="text-muted-foreground">Next: </span>{f.nextAction || "—"}</p>
      {f.said ? <p className="mt-0.5 text-xs text-muted-foreground">Said: {f.said}</p> : null}
    </article>
  );
}

export default function InboxPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({ successTitle: "Inbox unlocked" });
  const search = useHashSearch();
  const [, navigate] = useLocation();
  const sp = new URLSearchParams(search);
  const rawTab = sp.get("tab");
  // Chats (live mirror, with suggested drafts, risk flags and Replied/Handled) is the default view.
  // The old Replies tab (`tab=cards`) was merged into Chats; old links land there.
  const tab: "chats" | "followups" = rawTab === "followups" ? "followups" : "chats";
  const chatThread = sp.get("thread");
  const openThread = (uid: string | null) => navigate(uid ? `/inbox?tab=chats&thread=${encodeURIComponent(uid)}` : "/inbox?tab=chats");
  const [marking, setMarking] = useState<{ card: InboxCardView; status: "replied" | "handled"; reply: string } | null>(null);

  const cardsQuery = useQuery<CardsResponse>({
    queryKey: ["/api/inbox/cards"],
    enabled: isUnlocked,
    // Poll fast only while a refresh or a send is in flight; otherwise every 30 s.
    refetchInterval: (query) => {
      const d = query.state.data as CardsResponse | undefined;
      const inFlight = refreshBusy(d?.refresh) || (d?.outbound ?? []).some((o) => o.status === "queued" || o.status === "sending");
      return inFlight ? 3_000 : 30_000;
    },
    refetchOnWindowFocus: true,
    queryFn: async () => (await apiRequest("GET", "/api/inbox/cards", undefined, { headers })).json(),
  });

  // Ask the Mac for an FB read: once when the Inbox opens (server skips it if data is < 15 min old), and on Refresh taps.
  const refreshMutation = useMutation({
    mutationFn: async (reason: "open" | "manual") =>
      (await apiRequest("POST", "/api/inbox/refresh", { reason }, { headers })).json() as Promise<{
        queued: boolean;
        reason?: string;
        retryAfterMs?: number;
      }>,
    onSuccess: (r, reason) => {
      if (reason === "manual" && !r.queued && r.reason === "cooldown") {
        toast({ title: "Just refreshed", description: `Try again in ${Math.ceil((r.retryAfterMs ?? 0) / 1000)} s.` });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/inbox/cards"] });
    },
    onError: (e: Error, reason) => reason === "manual" && toast({ title: "Could not start a refresh", description: e.message, variant: "destructive" }),
  });
  const openedRef = useRef(false);
  useEffect(() => {
    if (!isUnlocked || openedRef.current) return;
    openedRef.current = true;
    refreshMutation.mutate("open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked]);
  const followupsQuery = useQuery<{ followups: Followup[] }>({
    queryKey: ["/api/followups"],
    enabled: isUnlocked,
    queryFn: async () => (await apiRequest("GET", "/api/followups", undefined, { headers })).json(),
  });

  const markMutation = useMutation({
    mutationFn: async (draft: FollowupDraft & { cardId: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/inbox/cards/${encodeURIComponent(draft.cardId)}/status`,
        { status: draft.status, followup: { said: draft.said, nextAction: draft.nextAction, reminderDate: draft.reminderDate, hubspotUrl: draft.hubspotUrl } },
        { headers },
      );
      return res.json() as Promise<{ followup: Followup | null }>;
    },
    onSuccess: (data) => {
      setMarking(null);
      const f = data.followup;
      toast({
        title: "Follow-up logged",
        description: f?.notionUrl ? "Saved to Notion and Print Ops." : `Saved in Print Ops. ${f?.notionError ?? ""}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/inbox/cards"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/followups"] });
    },
    onError: (e: Error) => toast({ title: "Could not log follow-up", description: e.message, variant: "destructive" }),
  });

  const needCount = (cardsQuery.data?.cards ?? []).filter(needsMe).length;
  const followups = followupsQuery.data?.followups ?? [];
  const heartbeat = heartbeatLabel(cardsQuery.data?.lastCheckinAt, cardsQuery.data?.lastPushAt);
  const dueCount = followups.filter((f) => f.status === "open" && f.reminderDate && f.reminderDate <= todayPT()).length;

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Client chats with suggested drafts, and follow-ups. A message goes out only when you press Send."
        actions={
          isUnlocked ? (
            <Button
              size="sm"
              variant="outline"
              disabled={refreshMutation.isPending || refreshBusy(cardsQuery.data?.refresh)}
              onClick={() => {
                refreshMutation.mutate("manual");
                void followupsQuery.refetch();
              }}
              data-testid="button-inbox-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshBusy(cardsQuery.data?.refresh) ? "animate-spin" : ""}`} />
              {refreshBusy(cardsQuery.data?.refresh) ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null
        }
      />
      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Inbox"
            description="Same owner code as Manual / Daily Work."
            buttonLabel="Unlock"
            testIdPrefix="inbox"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" role="tablist">
              <Button size="sm" variant={tab === "chats" ? "default" : "outline"} onClick={() => navigate("/inbox?tab=chats")} data-testid="tab-inbox-chats">
                <MessagesSquare className="h-4 w-4" /> Chats{needCount ? ` (${needCount})` : ""}
              </Button>
              <Button size="sm" variant={tab === "followups" ? "default" : "outline"} onClick={() => navigate("/inbox?tab=followups")} data-testid="tab-inbox-followups">
                Follow-ups{dueCount ? ` (${dueCount} due)` : ""}
              </Button>
              <span
                className={`ml-auto text-xs max-sm:w-full max-sm:ml-0 ${heartbeat.stale && cardsQuery.data ? "text-destructive" : "text-muted-foreground"}`}
                title={`Last data push: ${fmtTime(cardsQuery.data?.lastPushAt ?? null)}`}
                data-testid="text-mac-sync"
              >
                {heartbeat.text}
                {cardsQuery.data && !cardsQuery.data.pushConfigured ? " · push not configured" : ""}
                {cardsQuery.data && !cardsQuery.data.notionConfigured ? " · Notion not configured (local only)" : ""}
              </span>
            </div>

            {tab === "chats" ? (
              <InboxChat
                data={
                  cardsQuery.data
                    ? {
                        cards: cardsQuery.data.cards,
                        sourceUpdatedAt: cardsQuery.data.sourceUpdatedAt,
                        refresh: cardsQuery.data.refresh ?? null,
                        outbound: cardsQuery.data.outbound ?? [],
                        liveMirror: !!cardsQuery.data.liveMirror,
                      }
                    : undefined
                }
                loading={cardsQuery.isLoading}
                headers={headers}
                selected={chatThread}
                onSelect={openThread}
                onRefresh={() => refreshMutation.mutate("manual")}
                refreshPending={refreshMutation.isPending}
                onMark={(c, status, reply) => setMarking({ card: c, status, reply })}
              />
            ) : (
              <Panel title={`Follow-ups (${followups.length})`} description="Mirrors the Notion Client Follow-ups database. Due items go out in the morning Telegram digest.">
                {followups.length === 0 ? <p className="text-sm text-muted-foreground">No open follow-ups.</p> : null}
                <div className="grid gap-2">
                  {followups.map((f) => <FollowupRow key={`${f.id}:${f.updatedAt}`} f={f} headers={headers} />)}
                </div>
              </Panel>
            )}
          </>
        )}
      </div>
      {marking ? (
        <FollowupDialog
          open
          onOpenChange={(o) => !o && setMarking(null)}
          status={marking.status}
          clientName={marking.card.name}
          listing={marking.card.listing}
          defaultSaid={marking.status === "replied" ? marking.reply : ""}
          defaultNextAction={marking.card.nextAction}
          pending={markMutation.isPending}
          onSubmit={(draft) => markMutation.mutate({ ...draft, cardId: marking.card.id })}
        />
      ) : null}
    </>
  );
}
