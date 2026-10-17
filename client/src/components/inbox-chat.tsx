import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Image as ImageIcon, Link2, RefreshCw, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { nerveGet } from "@/lib/nerve";
import type { NerveError, NerveThread, NerveThreadList, NerveThreadSummary } from "@/lib/nerve";
import { attachmentLabel, buildChatItems, initialOf, listTime, splitLinks, visibleThreads } from "@/lib/nerve-chat";
import type { ChatItem } from "@/lib/nerve-chat";
import { NerveErrorState, NerveUnlock, useNerveAccess } from "@/components/nerve-common";

/**
 * Inbox > Chats: iMessage-style, read-only view of the FB Marketplace threads on the Mac mini.
 * Miguel's bubbles use the Print Ops green accent (--good), buyer bubbles neutral gray. No send/reply here:
 * replies will come later through the approval flow.
 */
export function InboxChat({ selected, onSelect }: { selected: string | null; onSelect: (uid: string | null) => void }) {
  const key = useNerveAccess();
  const [q, setQ] = useState("");
  const list = useQuery<NerveThreadList, NerveError>({
    queryKey: ["nerve", "/api/messages", key],
    queryFn: () => nerveGet<NerveThreadList>("/api/messages", key),
    enabled: !!key,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const threads = useMemo(() => {
    const v = visibleThreads(list.data?.threads);
    const s = q.trim().toLowerCase();
    return s ? v.filter((t) => `${t.name} ${t.listing}`.toLowerCase().includes(s)) : v;
  }, [list.data, q]);
  // A deleted/archived thread that is still in the URL is not shown.
  const hidden = !!selected && !!list.data && !visibleThreads(list.data.threads).some((t) => t.uid === selected);
  const uid = hidden ? null : selected;

  if (!key) return <NerveUnlock title="Unlock Print Ops to see chats" />;
  if (list.isLoading) return <Skeleton className="h-[60vh] w-full" />;
  if (list.error) return <NerveErrorState err={list.error} retry={() => list.refetch()} />;
  const owes = threads.filter((t) => t.owes).length;

  return (
    <div className="imsg grid overflow-hidden rounded-lg border border-border bg-card md:h-[calc(100dvh-15rem)] md:min-h-[28rem] md:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]" data-testid="inbox-chat">
      <section className={cn("flex min-h-0 flex-col border-border md:border-r", uid && "max-md:hidden")} aria-label="Conversations">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-tight">Messages</h2>
            <p className="text-xs text-muted-foreground">
              {owes ? `${owes} owe a reply` : "All caught up"} · synced {listTime(list.data?.updated ? new Date(list.data.updated).toISOString() : null) || "—"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => list.refetch()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            aria-label="Refresh"
            data-testid="button-chat-refresh"
          >
            <RefreshCw className={cn("h-4 w-4", list.isFetching && "animate-spin")} />
          </button>
        </div>
        <label className="mx-4 mb-2 flex h-9 items-center gap-2 rounded-lg bg-muted px-2.5 text-sm text-muted-foreground">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            data-testid="input-chat-search"
          />
        </label>
        <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="list-chat-threads">
          {threads.length === 0 ? <li className="px-4 py-6 text-sm text-muted-foreground">No conversations.</li> : null}
          {threads.map((t) => (
            <ThreadRow key={t.uid} t={t} active={t.uid === uid} onClick={() => onSelect(t.uid)} />
          ))}
        </ul>
      </section>
      <section className={cn("flex min-h-[70vh] min-w-0 flex-col md:min-h-0", !uid && "max-md:hidden")} aria-label="Conversation">
        {uid ? <Conversation uid={uid} onBack={() => onSelect(null)} /> : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" data-testid="chat-empty">
            {hidden ? "That conversation was archived or deleted." : "Pick a conversation."}
          </div>
        )}
      </section>
    </div>
  );
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

function ThreadRow({ t, active, onClick }: { t: NerveThreadSummary; active: boolean; onClick: () => void }) {
  const mine = t.lastSpeaker === "us" || t.lastSpeaker === "me";
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
            <span className="truncate text-[15px] font-semibold text-foreground" data-private="name">{t.name}</span>
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

function Conversation({ uid, onBack }: { uid: string; onBack: () => void }) {
  const key = useNerveAccess();
  const [showSummary, setShowSummary] = useState(false);
  const thread = useQuery<NerveThread, NerveError>({
    queryKey: ["nerve", "/api/messages/thread", uid, key],
    queryFn: () => nerveGet<NerveThread>(`/api/messages/thread?uid=${encodeURIComponent(uid)}&limit=80`, key),
    enabled: !!key,
    refetchInterval: 30_000,
    retry: false,
  });
  const items = useMemo(() => buildChatItems(thread.data?.messages), [thread.data]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [uid, items.length]);
  useEffect(() => setShowSummary(false), [uid]);

  if (thread.isLoading) return <Skeleton className="m-4 h-64" />;
  if (thread.error) return <div className="p-4"><NerveErrorState err={thread.error} retry={() => thread.refetch()} /></div>;
  const t = thread.data;
  if (!t) return null;
  const lastBubble = [...items].reverse().find((i) => i.kind === "bubble");
  const summary = t.summary || t.nextAction;
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" onClick={onBack} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground hover:bg-muted md:hidden" aria-label="Back to conversations" data-testid="button-chat-back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar name={t.name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold" data-private="name">{t.name}</p>
          <p className="truncate text-xs text-muted-foreground" data-private="text">{[t.listing, t.stage?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</p>
        </div>
        {t.owes ? <span className="shrink-0 rounded-full bg-good/10 px-2 py-0.5 text-[11px] font-medium text-good">Owes reply</span> : null}
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
            {showSummary ? [t.summary, t.nextAction ? `Next: ${t.nextAction}` : ""].filter(Boolean).join("\n") : summary}
          </span>
          <ChevronDown className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform", showSummary && "rotate-180")} />
        </button>
      ) : null}
      <div className="imsg-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5" data-testid="list-chat-messages">
        {t.hasMore ? <p className="pb-2 text-center text-[11px] text-muted-foreground">Showing the latest messages</p> : null}
        {items.map((it) => (
          <Row key={it.key} it={it} meta={it === lastBubble && it.kind === "bubble" ? (it.mine ? "Sent" : "") : ""} />
        ))}
        <div ref={end} />
      </div>
      <footer className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground">Read-only. Replies will go through approval.</footer>
    </>
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
