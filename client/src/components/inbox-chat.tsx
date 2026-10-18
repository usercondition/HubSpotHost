import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Save, Image as ImageIcon, Link2, Loader2, RefreshCw, RotateCcw, Search, Send } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { InboxCardView, InboxOutboundView, InboxRefreshView } from "@shared/inbox";
import { buildChatItems, initialOf, listTime, splitLinks, visibleThreads, attachmentLabel } from "@/lib/nerve-chat";
import type { ChatItem } from "@/lib/nerve-chat";
import {
  cardMessages,
  cardRows,
  loadComposerDraft,
  needsMe,
  riskText,
  newIdempotencyKey,
  outboundForCard,
  outboundLabel,
  parsePacific,
  refreshBusy,
  refreshLabel,
  saveComposerDraft,
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
 * Inbox > Chats: iMessage-style mirror of the FB Marketplace Selling chats, from Print Ops' own store (the Mac mini
 * pushes the full history). Personal chats are filtered on the Mac and never reach Print Ops.
 * Sending: only when the owner presses Send. The message is queued here and the Mac sends it through its FB browser.
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
  // "Needs me" is on by default (as it was in the old Replies tab).
  const [filter, setFilter] = useState<"needs" | "all">("needs");
  const rows = useMemo(() => visibleThreads(cardRows(data?.cards ?? [])), [data]);
  const needCount = useMemo(() => rows.filter((t) => needsMe(t.card)).length, [rows]);
  const threads = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = filter === "needs" ? rows.filter((t) => needsMe(t.card)) : rows;
    return s ? base.filter((t) => `${t.name} ${t.listing}`.toLowerCase().includes(s)) : base;
  }, [rows, q, filter]);
  const current = rows.find((t) => t.uid === selected) ?? null;
  const uid = current ? selected : null;

  if (loading && !data) return <Skeleton className="h-[60vh] w-full" />;
  const busy = refreshPending || refreshBusy(data?.refresh);
  const rl = refreshLabel(data?.refresh);

  return (
    <div className="imsg grid overflow-hidden rounded-lg border border-border bg-card md:h-[calc(100dvh-15rem)] md:min-h-[28rem] md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" data-testid="inbox-chat">
      <section className={cn("flex min-h-0 flex-col border-border md:border-r", uid && "max-md:hidden")} aria-label="Conversations">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight">Messages</h2>
            <p className="text-xs text-muted-foreground" data-testid="text-chat-synced">
              {needCount ? `${needCount} need${needCount === 1 ? "s" : ""} you` : "All caught up"} · FB read {listTime(data?.sourceUpdatedAt ? sourceIso(data.sourceUpdatedAt) : null) || "—"}
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
            aria-label="Refresh from Facebook"
            title="Read Facebook now"
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
        <div className="mx-4 mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-0.5 text-sm" role="group" aria-label="Filter chats">
          {([["needs", `Needs me (${needCount})`], ["all", `All (${rows.length})`]] as const).map(([id, label]) => (
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
            <li className="px-4 py-6 text-sm text-muted-foreground">
              {rows.length && filter === "needs" && !q ? "Nothing needs you right now." : rows.length ? "No matches." : "No conversations yet. They appear after the Mac pushes the inbox."}
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
            liveMirror={!!data?.liveMirror}
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
              {riskText(t.card) ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Risk flagged" data-testid={`icon-chat-risk-${t.uid}`} /> : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{listTime(t.sortAt || t.at) || t.when}</span>
          </span>
          {t.listing ? <span className="block truncate text-xs text-[hsl(var(--text-3))]" data-private="text">{t.listing}</span> : null}
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
  liveMirror,
  onBack,
  onMark,
}: {
  row: LiveThreadRow;
  outbound: InboxOutboundView[];
  headers: Record<string, string>;
  liveMirror: boolean;
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
        {partial ? <p className="pb-2 text-center text-[11px] text-muted-foreground">Showing recent messages (full history arrives with the next Mac push)</p> : null}
        {items.map((it) => (
          <Row key={it.key} it={it} meta={it === lastBubble && it.kind === "bubble" && it.mine && outbound.length === 0 ? "Sent" : ""} />
        ))}
        {outbound.map((o) => (
          <PendingBubble key={o.id} o={o} headers={headers} />
        ))}
        <div ref={end} />
      </div>
      <Composer card={card} headers={headers} liveMirror={liveMirror} onMark={onMark} />
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
  liveMirror,
  onMark,
}: {
  card: InboxCardView;
  headers: Record<string, string>;
  liveMirror: boolean;
  onMark: (card: InboxCardView, status: "replied" | "handled", reply: string) => void;
}) {
  const cardId = card.id;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState(() => loadComposerDraft(cardId));
  // One key per Send press; a network retry of the same press reuses it so the server never queues twice.
  const keyRef = useRef<string | null>(null);
  useEffect(() => saveComposerDraft(cardId, text), [cardId, text]);
  const send = useMutation({
    mutationFn: async (body: { text: string; idempotencyKey: string }) =>
      (await apiRequest("POST", `/api/inbox/cards/${encodeURIComponent(cardId)}/send`, body, { headers })).json(),
    onSuccess: () => {
      keyRef.current = null;
      setText("");
      saveComposerDraft(cardId, "");
      void qc.invalidateQueries({ queryKey: ["/api/inbox/cards"] });
    },
    onError: (e: Error) => toast({ title: "Not queued", description: `${e.message}. Nothing was sent.`, variant: "destructive" }),
  });
  const submit = () => {
    const t = text.trim();
    if (!t || send.isPending) return;
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    send.mutate({ text: t, idempotencyKey: keyRef.current });
  };
  return (
    <footer className="border-t border-border px-3 py-2" data-testid="chat-composer">
      <SuggestedDraft
        card={card}
        headers={headers}
        onUse={(reply) => {
          // Fill the message box only. Sending still needs a Send press.
          keyRef.current = null;
          setText(reply);
        }}
        onMark={(status) => onMark(card, status, text.trim() || card.editedReply || card.suggestedReply)}
      />
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => {
            keyRef.current = null;
            setText(e.target.value);
          }}
          rows={Math.min(5, Math.max(1, text.split("\n").length))}
          maxLength={2000}
          placeholder="Message"
          aria-label="Message"
          className="min-h-11 min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background px-3 py-2.5 text-base outline-none focus:ring-2 focus:ring-ring sm:text-sm"
          data-testid="input-chat-message"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim() || send.isPending}
          className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="button-chat-send"
        >
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span>Send</span>
        </button>
      </div>
      <p className="mt-1 text-center text-[11px] text-muted-foreground" data-testid="text-composer-note">
        {liveMirror
          ? "Sends from the Mac mini's Facebook only when you press Send. Nothing is ever sent automatically."
          : "Sending turns on once the Mac mini live sync is enabled. Messages you queue wait until then."}
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
        <div key={i} className={cn("imsg-bubble imsg-att", side, it.text ? "mt-[2px]" : "", it.last && i === it.attachments.length - 1 && "imsg-tail")}>
          <ImageIcon className="h-4 w-4 shrink-0" />
          <span>{attachmentLabel(a)}</span>
        </div>
      ))}
      {meta ? <span className="mt-0.5 px-1 text-[11px] text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

/**
 * Suggested reply as an editable draft above the message box (moved here from the old Replies tab).
 * Save stores the edit on the server; "Use this" only fills the message box. Nothing here sends.
 */
function SuggestedDraft({
  card,
  headers,
  onUse,
  onMark,
}: {
  card: InboxCardView;
  headers: Record<string, string>;
  onUse: (reply: string) => void;
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
              disabled={!reply.trim()}
              onClick={() => onUse(reply)}
              className="inline-flex min-h-9 items-center gap-1 rounded-full bg-secondary px-3 text-xs font-medium text-secondary-foreground disabled:opacity-50"
              data-testid="button-draft-use"
            >
              Use this (fills the box)
            </button>
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
