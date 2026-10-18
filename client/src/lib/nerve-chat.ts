/**
 * Pure helpers for the Inbox chat view (iMessage-style). No DOM, no fetch: unit-tested in tests/nerve-chat.test.ts.
 * Data comes read-only from the Mac mini's Nerve API (GET /api/messages, /api/messages/thread).
 */
export type ChatThreadRow = {
  uid: string;
  name: string;
  listing?: string;
  when?: string;
  at?: string | null;
  sortAt?: string | null;
  owes?: boolean;
  last?: string;
  lastSpeaker?: string;
  archived?: boolean;
  deleted?: boolean;
  softDeleted?: boolean;
};

export type ChatAttachment = { kind?: string; label?: string; thumb?: string; href?: string };
export type ChatMessage = {
  id?: string;
  who: string;
  when?: string;
  at?: number | null;
  text?: string;
  divider?: boolean;
  dividerLabel?: string;
  attachments?: ChatAttachment[];
};

const ts = (t: ChatThreadRow) => {
  const v = Date.parse(t.sortAt || "") || Date.parse(t.at || "") || 0;
  return Number.isFinite(v) ? v : 0;
};

/** Hide archived + deleted (soft or legacy) threads and sort by the real latest message, newest first. Stable for ties. */
export function visibleThreads<T extends ChatThreadRow>(rows: readonly T[] | undefined | null): T[] {
  return (rows ?? [])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !t.archived && !t.deleted && !t.softDeleted)
    .sort((a, b) => ts(b.t) - ts(a.t) || a.i - b.i)
    .map(({ t }) => t);
}

/** Short relative time for list rows, iMessage style: "2:37 PM", "Yesterday", "Fri", "Oct 7". Pacific time. */
export function listTime(iso: string | null | undefined, now: Date = new Date()): string {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return "";
  const tz = "America/Los_Angeles";
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const d = new Date(ms);
  const dayDiff = Math.round((Date.parse(day(now)) - Date.parse(day(d))) / 86_400_000);
  if (dayDiff <= 0) return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  return d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
}

/** Centered divider label: "Today 2:37 PM", "Yesterday 8:33 PM", "Fri 5:19 PM", "Oct 7, 7:07 PM". */
export function dividerTime(ms: number, now: Date = new Date()): string {
  const tz = "America/Los_Angeles";
  const d = new Date(ms);
  const t = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(x);
  const dayDiff = Math.round((Date.parse(day(now)) - Date.parse(day(d))) / 86_400_000);
  if (dayDiff <= 0) return `Today ${t}`;
  if (dayDiff === 1) return `Yesterday ${t}`;
  if (dayDiff < 7) return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${t}`;
  return `${d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })}, ${t}`;
}

export type TextPart = { kind: "text"; text: string } | { kind: "link"; href: string; domain: string };
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
/** Split message text into plain text + link chips (domain only), so long raw URLs never break the layout. */
export function splitLinks(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(URL_RE))) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: text.slice(last, i) });
    const href = m[0].replace(/[.,;:!?]+$/, "");
    let domain = href;
    try {
      domain = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    out.push({ kind: "link", href, domain });
    last = i + href.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.filter((p) => p.kind === "link" || p.text.length > 0);
}

export type ChatItem =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "bubble";
      key: string;
      mine: boolean;
      text: string;
      attachments: ChatAttachment[];
      first: boolean; // first of a same-sender group
      last: boolean; // last of a same-sender group (gets the tail)
      at: number | null;
    };

const GROUP_GAP_MS = 5 * 60_000;
const DIVIDER_GAP_MS = 60 * 60_000;

/**
 * Turn the API message list into iMessage rows: drop blank messages (no text, no attachment),
 * insert centered time dividers on a new day or a gap over an hour, and mark same-sender groups.
 */
export function buildChatItems(messages: readonly ChatMessage[] | undefined | null, now: Date = new Date()): ChatItem[] {
  const msgs = (messages ?? []).filter((m) => {
    const hasText = !!String(m.text ?? "").trim();
    const hasAtt = (m.attachments?.length ?? 0) > 0;
    return hasText || hasAtt;
  });
  const items: ChatItem[] = [];
  const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(ms));
  let prev: ChatMessage | null = null;
  msgs.forEach((m, i) => {
    const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : null;
    const pAt = prev && typeof prev.at === "number" ? prev.at : null;
    const needDivider = at != null && (pAt == null || dayKey(at) !== dayKey(pAt) || at - pAt > DIVIDER_GAP_MS);
    if (needDivider) items.push({ kind: "divider", key: `d-${m.id ?? i}`, label: dividerTime(at!, now) });
    const mine = m.who === "me";
    const startsGroup = needDivider || !prev || (prev.who === "me") !== mine || (at != null && pAt != null && at - pAt > GROUP_GAP_MS);
    if (startsGroup && items.length) {
      const before = items[items.length - (needDivider ? 2 : 1)];
      if (before && before.kind === "bubble") before.last = true;
    }
    const atts = (m.attachments ?? []).filter((a) => a && (a.label || a.kind));
    items.push({ kind: "bubble", key: m.id ?? `m-${i}`, mine, text: String(m.text ?? "").trim(), attachments: atts, first: startsGroup, last: false, at });
    prev = m;
  });
  const lastBubble = [...items].reverse().find((x) => x.kind === "bubble");
  if (lastBubble && lastBubble.kind === "bubble") lastBubble.last = true;
  return items;
}

/** First letter for the avatar circle. */
export function initialOf(name: string | undefined): string {
  const c = String(name ?? "").trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

/** Friendly attachment label: FB scrapes most photos as a bare "Attachment". */
export function attachmentLabel(a: ChatAttachment): string {
  const l = String(a.label || "").trim();
  if (!l && a.kind === "video") return "Video";
  if (!l && a.kind === "sticker") return "Sticker";
  if (!l && a.kind === "file") return "File";
  if (!l && a.kind === "attachment") return "Photo or attachment";
  if (!l || /^attachment$/i.test(l)) return "Photo";
  return l;
}
