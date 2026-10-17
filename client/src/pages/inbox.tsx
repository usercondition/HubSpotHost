import { useMemo, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Inbox as InboxIcon, Loader2, MessagesSquare, RefreshCw, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatusPill } from "@/components/primitives";
import { FollowupDialog, type FollowupDraft } from "@/components/followup-dialog";
import type { Followup, InboxCardView } from "@shared/inbox";
import { InboxChat } from "@/components/inbox-chat";
import { NERVE_SECTION_ENABLED } from "@/lib/nerve";

type CardsResponse = {
  ok: boolean;
  cards: InboxCardView[];
  lastPushAt: string | null;
  sourceUpdatedAt: string | null;
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

const CATEGORY_ORDER: Record<string, number> = { hot: 0, question: 1, waiting: 2, spam: 9 };

function fmtTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT`;
}

function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

function categoryTone(category: string): "good" | "warn" | "bad" | "neutral" {
  if (category === "hot") return "bad";
  if (category === "question") return "warn";
  return "neutral";
}

function InboxCardItem({
  card,
  headers,
  onMark,
}: {
  card: InboxCardView;
  headers: Record<string, string>;
  onMark: (card: InboxCardView, status: "replied" | "handled", reply: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const baseReply = card.editedReply ?? card.suggestedReply;
  const [reply, setReply] = useState(baseReply);
  const [showThread, setShowThread] = useState(false);
  const dirty = reply !== baseReply;
  const a = card.analysis;

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/inbox/cards/${encodeURIComponent(card.id)}/reply`, { reply, version: card.replyVersion }, { headers });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reply saved", description: "Hermes picks it up on the next Mac sync." });
      void queryClient.invalidateQueries({ queryKey: ["/api/inbox/cards"] });
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const reopen = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/inbox/cards/${encodeURIComponent(card.id)}/reopen`, undefined, { headers })).json(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/inbox/cards"] }),
  });

  const agreed = a ? Object.entries(a.agreed).filter(([, v]) => v) : [];

  return (
    <article className="rounded-md border border-border bg-card px-3 py-3" data-testid={`inbox-card-${card.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{card.name}</h3>
            <StatusPill tone={categoryTone(card.category)} label={card.category} />
            {card.stage ? <StatusPill tone="neutral" label={card.stage.replace(/_/g, " ")} /> : null}
            {card.status !== "open" ? <StatusPill tone="good" icon={CheckCircle2} label={card.status} /> : null}
            {card.owesReply && card.status === "open" ? <StatusPill tone="bad" label="owes reply" /> : null}
            {a?.confidence != null ? <span className="text-xs text-muted-foreground">conf {Math.round(a.confidence * 100)}%</span> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={card.listing}>{card.listing || "No listing"}</p>
        </div>
        <span className="text-xs text-muted-foreground">{card.timeLabel || card.lastMessageAt}</span>
      </div>

      {a?.summary ? <p className="mt-2 text-sm">{a.summary}</p> : null}
      {card.risk || (a?.riskFlags.length ?? 0) > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-[hsl(var(--destructive))]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{[card.risk, ...(a?.riskFlags ?? []), a?.riskNote].filter(Boolean).join(" · ")}</span>
        </p>
      ) : null}
      {agreed.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Agreed: {agreed.map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
      ) : null}
      <p className="mt-2 text-sm"><span className="text-muted-foreground">Last: </span>{card.lastMessage}</p>
      {card.nextAction ? <p className="mt-1 text-sm"><span className="text-muted-foreground">Next: </span>{card.nextAction}</p> : null}

      <div className="mt-3 grid gap-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`reply-${card.id}`}>
          Suggested reply {card.editedReply != null ? "(edited)" : ""}
        </label>
        <Textarea id={`reply-${card.id}`} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} data-testid={`input-reply-${card.id}`} />
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(reply);
              toast({ title: "Copied", description: "Paste it into Messenger yourself — Print Ops never sends." });
            }}
          >
            <Copy className="h-4 w-4" /> Copy
          </Button>
          {card.threadUrl ? (
            <Button size="sm" variant="outline" asChild>
              <a href={card.threadUrl} target="_blank" rel="noreferrer" title={card.threadHint}>
                <ExternalLink className="h-4 w-4" /> Open chat
              </a>
            </Button>
          ) : null}
          {card.status === "open" ? (
            <>
              <Button size="sm" onClick={() => onMark(card, "replied", reply)} data-testid={`button-replied-${card.id}`}>Replied</Button>
              <Button size="sm" variant="secondary" onClick={() => onMark(card, "handled", reply)}>Handled</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => reopen.mutate()}><RotateCcw className="h-4 w-4" /> Reopen</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowThread((v) => !v)}>{showThread ? "Hide" : "Recent"} messages</Button>
        </div>
      </div>
      {showThread ? (
        <ol className="mt-2 grid gap-1 border-l border-border pl-3 text-sm">
          {card.recent.map((m, i) => (
            <li key={i}><span className="text-xs text-muted-foreground">{m.when} · </span>{m.text}</li>
          ))}
        </ol>
      ) : null}
    </article>
  );
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
  // Chats (read-only, from the Mac mini) is the default Inbox view when the Nerve link is enabled; Cards + Follow-ups stay as before.
  const tab: "chats" | "cards" | "followups" =
    rawTab === "followups" ? "followups" : rawTab === "cards" || !NERVE_SECTION_ENABLED ? "cards" : "chats";
  const chatThread = sp.get("thread");
  const openThread = (uid: string | null) => navigate(uid ? `/inbox?tab=chats&thread=${encodeURIComponent(uid)}` : "/inbox?tab=chats");
  const [filter, setFilter] = useState<"needs" | "all">("needs");
  const [marking, setMarking] = useState<{ card: InboxCardView; status: "replied" | "handled"; reply: string } | null>(null);

  const cardsQuery = useQuery<CardsResponse>({
    queryKey: ["/api/inbox/cards"],
    enabled: isUnlocked,
    refetchInterval: 60_000,
    queryFn: async () => (await apiRequest("GET", "/api/inbox/cards", undefined, { headers })).json(),
  });
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

  const cards = useMemo(() => {
    const list = cardsQuery.data?.cards ?? [];
    const visible = filter === "needs" ? list.filter((c) => c.status === "open" && c.category !== "spam" && (c.needsYou || c.owesReply)) : list;
    return [...visible].sort((a, b) => (CATEGORY_ORDER[a.category] ?? 5) - (CATEGORY_ORDER[b.category] ?? 5));
  }, [cardsQuery.data, filter]);
  const followups = followupsQuery.data?.followups ?? [];
  const dueCount = followups.filter((f) => f.status === "open" && f.reminderDate && f.reminderDate <= todayPT()).length;

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Client chats, suggested replies and follow-ups. Sending stays manual."
        actions={
          isUnlocked ? (
            <Button size="sm" variant="outline" onClick={() => { void cardsQuery.refetch(); void followupsQuery.refetch(); }}>
              <RefreshCw className="h-4 w-4" /> Refresh
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
              {NERVE_SECTION_ENABLED ? (
                <Button size="sm" variant={tab === "chats" ? "default" : "outline"} onClick={() => navigate("/inbox?tab=chats")} data-testid="tab-inbox-chats">
                  <MessagesSquare className="h-4 w-4" /> Chats
                </Button>
              ) : null}
              <Button size="sm" variant={tab === "cards" ? "default" : "outline"} onClick={() => navigate("/inbox?tab=cards")} data-testid="tab-inbox-cards">
                <InboxIcon className="h-4 w-4" /> Replies
              </Button>
              <Button size="sm" variant={tab === "followups" ? "default" : "outline"} onClick={() => navigate("/inbox?tab=followups")} data-testid="tab-inbox-followups">
                Follow-ups{dueCount ? ` (${dueCount} due)` : ""}
              </Button>
              <span className="ml-auto text-xs text-muted-foreground max-sm:w-full max-sm:ml-0">
                Mac sync: {fmtTime(cardsQuery.data?.lastPushAt ?? null)}
                {cardsQuery.data && !cardsQuery.data.pushConfigured ? " · push not configured" : ""}
                {cardsQuery.data && !cardsQuery.data.notionConfigured ? " · Notion not configured (local only)" : ""}
              </span>
            </div>

            {tab === "chats" ? (
              <InboxChat selected={chatThread} onSelect={openThread} />
            ) : tab === "cards" ? (
              <Panel
                title={`Cards (${cards.length})`}
                actions={
                  <div className="flex gap-1">
                    <Button size="sm" variant={filter === "needs" ? "default" : "ghost"} onClick={() => setFilter("needs")}>Needs me</Button>
                    <Button size="sm" variant={filter === "all" ? "default" : "ghost"} onClick={() => setFilter("all")}>All</Button>
                  </div>
                }
              >
                {cardsQuery.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                {cardsQuery.error ? <p className="text-sm text-destructive">{(cardsQuery.error as Error).message}</p> : null}
                {!cardsQuery.isLoading && cards.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing waiting. Cards appear after the Mac pushes its inbox.</p>
                ) : null}
                <div className="grid gap-2">
                  {cards.map((card) => (
                    <InboxCardItem key={`${card.id}:${card.replyVersion}:${card.status}`} card={card} headers={headers} onMark={(c, status, reply) => setMarking({ card: c, status, reply })} />
                  ))}
                </div>
              </Panel>
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
