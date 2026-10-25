import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Save, Image as ImageIcon, Link2, Loader2, RefreshCw, RotateCcw, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { sellerChannelLabel, sellerInboxChannel, type SellerInboxChannel } from "@shared/inbox";
import type { InboxCardView, InboxOutboundView, InboxRefreshView } from "@shared/inbox";
import { buildChatItems, initialOf, listTime, splitLinks, visibleThreads, attachmentLabel } from "@/lib/nerve-chat";
import type { ChatAttachment, ChatItem } from "@/lib/nerve-chat";
import {
  cardMessages,
  cardRows,
  needsMe,
  riskText,
  outboundForCard,
  outboundLabel,
  parsePacific,
  refreshBusy,
  refreshLabel,
} from "@/lib/inbox-live";
import type { LiveThreadRow } from "@/lib/inbox-live";

export type LiveInboxData = {
  cards: InboxCardView[];
  sourceUpdatedAt: string | null;
  refresh: InboxRefreshView | null;
  outbound: InboxOutboundView[];
  liveMirror: boolean;
};

/**
 * Inbox > Chats: eBay, Etsy, and MyMiniFactory buyer threads.
 * Facebook Marketplace stays paused and is filtered out. Sending is off;
 * suggested drafts and Replied / Handled follow-ups still save.
 */
export function InboxChat({
  data,
  loading,
  headers,
  selected,
  onSelect,
  onRefresh,
  refreshPending,
  onMark,
}: {
  data: LiveInboxData | undefined;
  loading: boolean;
  headers: Record<string, string>;
  selected: string | null;
  onSelect: (uid: string | null) => void;
  onRefresh: () => void;
  refreshPending: boolean;
  /** Replied / Handled: opens the follow-up dialog (logs to Notion). Never sends a message. */
  onMark: (card: InboxCardView, status: "replied" | "handled", reply: string) => void;
}) {
  const [q, setQ] = useState("");
  const [shop, setShop] = useState<"all" | SellerInboxChannel>("all");
  // "Needs me" is on by default (as it was in the old Replies tab).
  const [filter, setFilter] = useState<"needs" | "all">("needs");
  const rows = useMemo(
    () => visibleThreads(cardRows(data?.cards ?? [])).filter((t) => sellerInboxChannel(t.card.source)),
    [data],
  );
  const shopRows = useMemo(
    () => (shop === "all" ? rows : rows.filter((t) => sellerInboxChannel(t.card.source) === shop)),
    [rows, shop],
  );
  const needCount = useMemo(() => shopRows.filter((t) => needsMe(t.card)).length, [shopRows]);
  const threads = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = filter === "needs" ? shopRows.filter((t) => needsMe(t.card)) : shopRows;
    return s ? base.filter((t) => `${t.name} ${t.listing}`.toLowerCase().includes(s)) : base;
  }, [shopRows, q, filter]);
  const current = shopRows.find((t) => t.uid === selected) ?? null;
  const uid = current ? selected : null;

  if (loading && !data) return <Skeleton className="h-[60vh] w-full" />;
  const busy = refreshPending || refreshBusy(data?.refresh);
  const rl = refreshLabel(data?.refresh);

  return (
    <div className="imsg grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-card md:h-[calc(100dvh-15rem)] md:min-h-[28rem] md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" data-testid="inbox-chat">
      <section className={cn("flex min-h-0 min-w-0 flex-col border-border md:border-r", uid && "max-md:hidden")} aria-label="Conversations">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight">Messages</h2>
            <p className="truncate text-xs text-muted-foreground" data-testid="text-chat-synced">
              {needCount ? `${needCount} need${needCount === 1 ? "s" : ""} you` : "All caught up"} · sending off
            </p>
            {rl ? (
              <p className={cn("text-xs", data?.refresh?.status === "failed" ? "text-destructive" : "text-muted-foreground")} data-testid="text-refresh-status">
                {rl}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-muted disabled:opacity-60"
            aria-label="Reload chats"
            title="Reload chats"
            data-testid="button-chat-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
            <span className="max-sm:hidden">{busy ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
        <label className="mx-4 mb-2 flex h-11 items-center gap-2 rounded-lg bg-muted px-2.5 text-sm text-muted-foreground">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm"
            data-testid="input-chat-search"
          />
        </label>
        <div className="mx-4 mb-2 flex gap-1 overflow-x-auto" role="tablist" aria-label="Shops">
          {([
            ["all", "All"],
            ["ebay", "eBay"],
            ["etsy", "Etsy"],
            ["myminifactory", "MMF"],
          ] as const).map(([id, label]) => {
            const count = id === "all" ? rows.length : rows.filter((t) => sellerInboxChannel(t.card.source) === id).length;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={shop === id}
                onClick={() => setShop(id)}
                className={cn(
                  "min-h-11 shrink-0 rounded-full px-3 text-sm font-medium",
                  shop === id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}
                data-testid={`button-chat-shop-${id}`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>
        <div className="mx-4 mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-0.5 text-sm" role="group" aria-label="Filter chats">
          {([["needs", `Needs me (${needCount})`], ["all", `All (${shopRows.length})`]] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn("min-h-11 rounded-md px-2 font-medium", filter === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
              data-testid={`button-chat-filter-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="list-chat-threads">
          {threads.length === 0 ? (
            <li className="px-4 py-6 text-sm text-muted-foreground" data-testid="text-chat-empty-shop">
              {shopRows.length && filter === "needs" && !q
                ? "Nothing needs you right now."
                : shopRows.length
                  ? "No matches."
                  : shop === "all"
                    ? "No eBay, Etsy, or MyMiniFactory chats yet. They show up when message notifications are posted. Sending stays off."
                    : `No ${sellerChannelLabel(shop)} chats yet. Sending stays off.`}
            </li>
          ) : null}
          {threads.map((t) => (
            <ThreadRow key={t.uid} t={t} active={t.uid === uid} onClick={() => onSelect(t.uid)} />
          ))}
        </ul>
      </section>
      <section className={cn("flex min-h-[70vh] min-w-0 flex-col md:min-h-0", !uid && "max-md:hidden")} aria-label="Conversation">
        {current ? (
          <Conversation
            key={current.uid}
            row={current}
            outbound={outboundForCard(current.card, data?.outbound ?? [])}
            headers={headers}
            onBack={() => onSelect(null)}
            onMark={onMark}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" data-testid="chat-empty">
            {selected ? "That conversation is not in the inbox any more." : "Pick a conversation."}
          </div>
        )}
      </section>
    </div>
  );
}

/** The Mac writes naive Pacific time ("2026-10-17T17:34:05"); show it as such. */
function sourceIso(s: string): string | null {
  const v = parsePacific(s);
  return v == null ? null : new Date(v).toISOString();
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-[hsl(var(--imsg-them))] font-semibold text-[hsl(var(--text-2))]"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
      data-private="name"
    >
      {initialOf(name)}
    </span>
  );
}

function ThreadRow({ t, active, onClick }: { t: LiveThreadRow; active: boolean; onClick: () => void }) {
  const mine = t.lastSpeaker === "me";
  const channel = sellerInboxChannel(t.card.source);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={`row-chat-thread-${t.uid}`}
        aria-current={active ? "true" : undefined}
        className={cn("group flex w-full items-center gap-3 py-2.5 pl-2 pr-4 text-left transition-colors hover:bg-muted/60", active && "bg-muted")}
      >
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", t.owes ? "bg-good" : "bg-transparent")} title={t.owes ? "Owes a reply" : undefined} aria-label={t.owes ? "Owes a reply" : undefined} />
        <Avatar name={t.name} />
        <span className="min-w-0 flex-1 border-b border-border/60 pb-2.5 group-last:border-0">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[15px] font-semibold text-foreground" data-private="name">{t.name}</span>
              {channel ? (
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground" data-testid={`text-chat-channel-${t.uid}`}>
                  {sellerChannelLabel(channel)}
                </span>
              ) : null}
              {riskText(t.card) ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Risk flagged" data-testid={`icon-chat-risk-${t.uid}`} /> : null}
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" data-testid={`text-chat-time-${t.uid}`}>{listTime(t.sortAt || t.at) || t.when}</span>
          </span>
          {t.listing ? <span className="block min-w-0 truncate text-xs text-[hsl(var(--text-3))]" data-private="text" data-testid={`text-chat-listing-${t.uid}`}>{t.listing}</span> : null}
          {t.card.notInLatestRead ? (
            <span className="block truncate text-[11px] text-warn" data-testid={`text-chat-not-latest-${t.uid}`}>Not in the latest read{t.card.lastSeenInList ? ` · seen ${listTime(sourceIso(t.card.lastSeenInList)) || ""}` : ""}</span>
          ) : null}
          <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground" data-private="text">
            {mine ? "You: " : ""}
            {t.last || "Photo"}
          </span>
        </span>
      </button>
    </li>
  );
}

function Conversation({
  row,
  outbound,
  headers,
  onBack,
  onMark,
}: {
  row: LiveThreadRow;
  outbound: InboxOutboundView[];
  headers: Record<string, string>;
  onBack: () => void;
  onMark: (card: InboxCardView, status: "replied" | "handled", reply: string) => void;
}) {
  const card = row.card;
  const risk = riskText(card);
  const [showSummary, setShowSummary] = useState(false);
  const items = useMemo(() => buildChatItems(cardMessages(card)), [card]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items.length, outbound.length]);
  const lastBubble = [...items].reverse().find((i) => i.kind === "bubble");
  const summary = card.analysis?.summary || card.nextAction;
  const partial = !card.history?.length;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className="inline-flex h-11 w-11 items-center justify-center rounded-full text-foreground hover:bg-muted md:hidden" aria-label="Back to conversations" data-testid="button-chat-back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar name={card.name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold" data-private="name">{card.name}</p>
          <p className="truncate text-xs text-muted-foreground" data-private="text">{[card.listing, card.stage?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</p>
        </div>
        {row.owes ? <span className="shrink-0 rounded-full bg-good/10 px-2 py-0.5 text-[11px] font-medium text-good">Owes reply</span> : null}
      </header>
      {summary ? (
        <button
          type="button"
          onClick={() => setShowSummary((v) => !v)}
          className="flex w-full items-start gap-2 border-b border-border/60 bg-[hsl(var(--surface))] px-4 py-2 text-left text-xs text-muted-foreground"
          aria-expanded={showSummary}
          data-testid="button-chat-summary"
        >
          <span className="shrink-0 font-semibold text-foreground">Summary</span>
          <span className={cn("min-w-0 flex-1", showSummary ? "whitespace-pre-wrap" : "truncate")} data-private="text">
            {showSummary ? [card.analysis?.summary, card.nextAction ? `Next: ${card.nextAction}` : ""].filter(Boolean).join("\n") : summary}
          </span>
          <ChevronDown className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform", showSummary && "rotate-180")} />
        </button>
      ) : null}
      {risk ? (
        <p className="flex items-start gap-1.5 border-b border-border/60 px-4 py-1.5 text-xs text-destructive" data-testid="text-chat-risk">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words" data-private="text">{risk}</span>
        </p>
      ) : null}
      <div className="imsg-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5" data-testid="list-chat-messages">
        {partial ? <p className="pb-2 text-center text-[11px] text-muted-foreground">Showing recent messages. The full thread arrives with the next ingest.</p> : null}
        {card.notInLatestRead ? (
          <p className="pb-2 text-center text-[11px] text-warn" data-testid="text-chat-not-latest">
            Not in the latest read. Showing the last-known copy{card.lastSeenInList ? ` (seen ${listTime(sourceIso(card.lastSeenInList)) || card.lastSeenInList})` : ""}.
          </p>
        ) : null}
        {items.map((it) => (
          <Row key={it.key} it={it} meta={it === lastBubble && it.kind === "bubble" && it.mine && outbound.length === 0 ? "Sent" : ""} />
        ))}
        {outbound.map((o) => (
          <PendingBubble key={o.id} o={o} headers={headers} />
        ))}
        <div ref={end} />
      </div>
      <Composer card={card} headers={headers} onMark={onMark} />
    </>
  );
}

function PendingBubble({ o, headers }: { o: InboxOutboundView; headers: Record<string, string> }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const l = outboundLabel(o);
  const retry = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/inbox/outbound/${encodeURIComponent(o.id)}/retry`, {}, { headers })).json(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/inbox/cards"] }),
    onError: (e: Error) => toast({ title: "Could not retry", description: e.message, variant: "destructive" }),
  });
  return (
    <div className="mt-2 flex flex-col items-end" data-testid={`outbound-${o.id}`}>
      <div className={cn("imsg-bubble imsg-me imsg-tail", o.status !== "sent" && "opacity-70")} data-private="text">{o.text}</div>
      <span
        className={cn(
          "mt-0.5 flex items-center gap-1 px-1 text-right text-[11px]",
          l.tone === "bad" ? "text-destructive" : l.tone === "warn" ? "text-[hsl(var(--warn,38_92%_50%))]" : "text-muted-foreground",
        )}
        data-testid={`outbound-status-${o.id}`}
      >
        {o.status === "sending" || o.status === "queued" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {l.text}
        {l.canRetry ? (
          <button
            type="button"
            className="ml-1 inline-flex min-h-11 items-center gap-1 rounded px-2 font-medium text-foreground underline-offset-2 hover:underline"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            data-testid={`button-outbound-retry-${o.id}`}
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        ) : null}
      </span>
    </div>
  );
}

function Composer({
  card,
  headers,
  onMark,
}: {
  card: InboxCardView;
  headers: Record<string, string>;
  onMark: (card: InboxCardView, status: "replied" | "handled", reply: string) => void;
}) {
  return (
    <footer className="border-t border-border px-3 py-2" data-testid="chat-composer">
      <SuggestedDraft
        card={card}
        headers={headers}
        onMark={(status) => onMark(card, status, card.editedReply || card.suggestedReply)}
      />
      <p className="mt-1 text-center text-[11px] text-muted-foreground" data-testid="text-composer-note">
        Sending is off for eBay, Etsy, and MyMiniFactory. Drafts stay here. Nothing is sent to the buyer.
      </p>
    </footer>
  );
}

function Row({ it, meta }: { it: ChatItem; meta: string }) {
  if (it.kind === "divider") {
    return (
      <p className="py-2 text-center text-[11px] font-medium text-muted-foreground" data-testid="chat-divider">
        {it.label}
      </p>
    );
  }
  const side = it.mine ? "imsg-me" : "imsg-them";
  return (
    <div className={cn("flex flex-col", it.mine ? "items-end" : "items-start", it.first ? "mt-2" : "mt-[2px]")}>
      {it.text ? (
        <div className={cn("imsg-bubble", side, it.last && !it.attachments.length && "imsg-tail")} data-private="text">
          {splitLinks(it.text).map((p, i) =>
            p.kind === "text" ? (
              <span key={i}>{p.text}</span>
            ) : (
              <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className="imsg-link" title={p.domain}>
                <Link2 className="h-3 w-3 shrink-0" />
                {p.domain}
              </a>
            ),
          )}
        </div>
      ) : null}
      {it.attachments.map((a, i) => (
        <AttachmentBubble key={i} a={a} className={cn("imsg-bubble imsg-att", side, it.text ? "mt-[2px]" : "", it.last && i === it.attachments.length - 1 && "imsg-tail")} />
      ))}
      {meta ? <span className="mt-0.5 px-1 text-[11px] text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

/** Photo thumbnail (FB CDN links expire, so fall back to a labelled placeholder) linking to the chat on Facebook. */
function AttachmentBubble({ a, className }: { a: ChatAttachment; className: string }) {
  const [broken, setBroken] = useState(false);
  const label = attachmentLabel(a);
  const body =
    a.thumb && !broken ? (
      <img
        src={a.thumb}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="block max-h-48 max-w-[min(14rem,70vw)] rounded-lg object-cover"
        data-private="image"
        data-testid="img-chat-attachment"
      />
    ) : (
      <>
        <ImageIcon className="h-4 w-4 shrink-0" />
        <span>{label}</span>
        {a.href ? <span className="text-[11px] underline opacity-80">Open attachment</span> : null}
      </>
    );
  return a.href ? (
    <a href={a.href} target="_blank" rel="noopener noreferrer" className={cn(className, "inline-flex items-center gap-1.5", a.thumb && !broken && "p-1")} data-testid="link-chat-attachment">
      {body}
    </a>
  ) : (
    <div className={cn(className, a.thumb && !broken && "p-1")} data-testid="chat-attachment">{body}</div>
  );
}

/**
 * Suggested reply as an editable draft above the message box (moved here from the old Replies tab).
 * Save stores the edit on the server; "Use this" only fills the message box. Nothing here sends.
 */
function SuggestedDraft({
  card,
  headers,
  onMark,
}: {
  card: InboxCardView;
  headers: Record<string, string>;
  onMark: (status: "replied" | "handled") => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const base = card.editedReply ?? card.suggestedReply ?? "";
  const [reply, setReply] = useState(base);
  const [open, setOpen] = useState(true);
  useEffect(() => setReply(base), [base, card.replyVersion]);
  const dirty = reply !== base;
  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest("PATCH", `/api/inbox/cards/${encodeURIComponent(card.id)}/reply`, { reply, version: card.replyVersion }, { headers })).json(),
    onSuccess: () => {
      toast({ title: "Draft saved", description: "Saved to Print Ops. Nothing was sent." });
      void qc.invalidateQueries({ queryKey: ["/api/inbox/cards"] });
    },
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const reopen = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/inbox/cards/${encodeURIComponent(card.id)}/reopen`, undefined, { headers })).json(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/inbox/cards"] }),
  });
  const hasDraft = base.trim().length > 0 || card.editedReply != null;
  return (
    <div className="mb-2 rounded-xl border border-dashed border-border bg-[hsl(var(--surface))] px-2.5 py-2" data-testid="chat-suggested-draft">
      <div className="flex flex-wrap items-center gap-1.5">
        {hasDraft ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-foreground"
            data-testid="button-draft-toggle"
          >
            Suggested reply{card.editedReply != null ? " (edited)" : ""}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">No suggested reply</span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {card.status === "open" ? (
            <>
              <button type="button" className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-2.5 text-xs font-medium" onClick={() => onMark("replied")} data-testid="button-chat-replied">
                <CheckCircle2 className="h-3.5 w-3.5" /> Replied
              </button>
              <button type="button" className="inline-flex min-h-9 items-center rounded-full border border-border px-2.5 text-xs font-medium" onClick={() => onMark("handled")} data-testid="button-chat-handled">
                Handled
              </button>
            </>
          ) : (
            <button type="button" className="inline-flex min-h-9 items-center gap-1 rounded-full px-2.5 text-xs" onClick={() => reopen.mutate()} data-testid="button-chat-reopen">
              <RotateCcw className="h-3.5 w-3.5" /> Reopen ({card.status})
            </button>
          )}
        </span>
      </div>
      {hasDraft && open ? (
        <div className="mt-1.5 grid gap-1.5">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            maxLength={2000}
            aria-label="Suggested reply draft"
            className="min-w-0 resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:ring-2 focus:ring-ring sm:text-sm"
            data-private="text"
            data-testid="input-draft-reply"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
              className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-3 text-xs disabled:opacity-50"
              data-testid="button-draft-save"
            >
              {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save draft
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
