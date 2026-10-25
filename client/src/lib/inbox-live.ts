/**
 * Pure helpers for Inbox > Chats (eBay, Etsy, MyMiniFactory cards from /api/inbox/cards).
 * No DOM, no fetch: unit-tested in tests/inbox-live.test.ts.
 */
import type { InboxCardView, InboxMessage, InboxOutboundView, InboxRefreshView } from "@shared/inbox";
import type { ChatMessage, ChatThreadRow } from "./nerve-chat";

const MINE = new Set(["miguel", "me", "us"]);
export const isMine = (who: string) => MINE.has(who);

/** Hermes stores naive local (Pacific) times like "2026-10-17T14:37"; treat them as PT, not the viewer's zone. */
export function parsePacific(at: string | null | undefined): number | null {
  if (!at) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(at)) {
    const v = Date.parse(at);
    return Number.isFinite(v) ? v : null;
  }
  const m = at.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
  // Offset of America/Los_Angeles at that instant (handles PDT/PST).
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcGuess));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asPt = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return utcGuess - (asPt - utcGuess);
}

/** Card history (or `recent` from an older Mac script) -> chat messages for buildChatItems. */
export function cardMessages(card: Pick<InboxCardView, "history" | "recent"> & { threadUrl?: string }): ChatMessage[] {
  const src: InboxMessage[] = card.history?.length ? card.history : card.recent ?? [];
  return src.map((m, i) => {
    const out: ChatMessage = { id: `h-${i}`, who: isMine(m.who) ? "me" : "them", when: m.when, at: parsePacific(m.at), text: m.text };
    if (m.attachments?.length) {
      // Thumbnail when the ingest captured one; otherwise a placeholder that links to the thread.
      out.attachments = m.attachments.map((a) => ({ kind: a.kind, label: a.label, thumb: a.thumb || undefined, href: a.url || card.threadUrl || undefined }));
    }
    return out;
  });
}

export type LiveThreadRow = ChatThreadRow & { card: InboxCardView };

export function cardRows(cards: readonly InboxCardView[]): LiveThreadRow[] {
  return cards.map((c) => {
    const t = parsePacific(c.lastMessageAt);
    const iso = t != null ? new Date(t).toISOString() : null;
    return {
      uid: c.id, name: c.name, listing: c.listing, when: c.timeLabel, at: iso, sortAt: iso, owes: c.owesReply && c.status === "open",
      last: c.lastMessage, lastSpeaker: isMine(c.lastSpeaker) ? "me" : c.lastSpeaker, card: c,
    };
  });
}

/** Outbound rows for one chat that should still show as pending bubbles (hide `sent` once the history has them). */
export function outboundForCard(card: Pick<InboxCardView, "id" | "history" | "recent">, outbound: readonly InboxOutboundView[]): InboxOutboundView[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const src = card.history?.length ? card.history : card.recent ?? [];
  const mine = src.filter((m) => isMine(m.who)).slice(-30).map((m) => norm(m.text));
  return outbound.filter((o) => o.cardId === card.id && !(o.status === "sent" && mine.includes(norm(o.text))));
}

export function outboundLabel(o: Pick<InboxOutboundView, "status" | "detail" | "attempt">): { text: string; tone: "muted" | "good" | "bad" | "warn"; canRetry: boolean } {
  switch (o.status) {
    case "queued":
      return { text: o.attempt > 1 ? `Queued (retry ${o.attempt - 1})` : "Queued — waiting for the Mac", tone: "muted", canRetry: false };
    case "sending":
      return { text: "Sending…", tone: "muted", canRetry: false };
    case "sent":
      return { text: "Sent", tone: "good", canRetry: false };
    case "unverified":
      return { text: `Not confirmed${o.detail ? `: ${o.detail}` : ""}`, tone: "warn", canRetry: true };
    default:
      return { text: `Failed${o.detail ? `: ${o.detail}` : ""}`, tone: "bad", canRetry: true };
  }
}

export function refreshBusy(r: InboxRefreshView | null | undefined): boolean {
  return !!r && (r.status === "queued" || r.status === "running");
}

const t = (iso: string | null | undefined) => {
  const v = Date.parse(iso || "");
  return Number.isFinite(v) ? new Date(v).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }) + " PT" : "";
};

export function refreshLabel(r: InboxRefreshView | null | undefined): string {
  if (!r) return "";
  if (r.status === "queued") return /^Waiting:/.test(r.detail || "") ? `Queued. ${r.detail.replace(/^Waiting:\s*/, "Waiting for the FB browser: ")}` : "Refreshing… waiting for the Mac";
  if (r.status === "running") return "Refreshing… reading Facebook";
  if (r.status === "done") return `Refreshed ${t(r.finishedAt)}`;
  return `Refresh failed${r.detail ? `: ${r.detail}` : ""}`;
}

/** Ingest heartbeat: last watcher check-in, not last data change. Offline after 10 min of silence. */
export function heartbeatLabel(lastCheckinAt: string | null | undefined, lastPushAt: string | null | undefined, now = Date.now()): { text: string; stale: boolean } {
  const at = lastCheckinAt || lastPushAt;
  if (!at) return { text: "Ingest: never", stale: true };
  const age = now - Date.parse(at);
  const stale = !Number.isFinite(age) || age > 10 * 60_000;
  return { text: `Ingest: ${stale ? "offline since" : "checked in"} ${t(at)}`, stale };
}

/** Idempotency key for one Send press (kept across network retries of that same press). */
export function newIdempotencyKey(rand: () => string = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`)): string {
  return `send-${rand().replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 80);
}

/** Suggested-reply "Use this" -> composer prefill, per chat (fills the box only; never sends). */
const DRAFT_KEY = (id: string) => `printops.inbox.draft.${id}`;
export function saveComposerDraft(id: string, text: string, storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
  if (!storage) return;
  if (text) storage.setItem(DRAFT_KEY(id), text);
  else storage.removeItem(DRAFT_KEY(id));
}
export function loadComposerDraft(id: string, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string {
  return storage?.getItem(DRAFT_KEY(id)) ?? "";
}

/** "Needs me": open, not spam, and owes a reply or needs Miguel. One predicate for the filter and every count. */
export function needsMe(card: Pick<InboxCardView, "status" | "category" | "needsYou" | "owesReply">): boolean {
  return card.status === "open" && card.category !== "spam" && (card.needsYou || card.owesReply);
}

/** Risk text for a chat (card risk + analysis flags + note), or "" when there is none. */
export function riskText(card: Pick<InboxCardView, "risk" | "analysis">): string {
  const a = card.analysis;
  return [card.risk, ...(a?.riskFlags ?? []), a?.riskNote].filter(Boolean).join(" · ");
}
