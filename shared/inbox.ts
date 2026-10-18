/**
 * Client inbox cards pushed from the Mac (Hermes `~/.hermes/data/inbox/marketplace.json`).
 *
 * The normalizer is deliberately tolerant: unknown keys are kept under `extra`,
 * missing keys fall back to safe defaults, and the Hermes `analysis` block
 * (summary, stage, agreed terms, risk flags, confidence, ...) may grow fields
 * without breaking the push.
 */

/** Photo / video / sticker / file on a message. `thumb` is a (short-lived) FB CDN thumbnail when the Mac captured one. */
export type InboxAttachment = { kind: "image" | "video" | "sticker" | "file" | "attachment"; thumb: string; url: string; label: string };
export type InboxMessage = { who: string; when: string; at: string | null; text: string; attachments?: InboxAttachment[] };

export type InboxAnalysis = {
  summary: string;
  stage: string;
  clientWants: Record<string, string>;
  agreed: Record<string, string>;
  openQuestions: string[];
  nextMoveOwner: string;
  nextMoveWhy: string;
  nextAction: string;
  riskFlags: string[];
  riskNote: string;
  confidence: number | null;
  unclear: string;
  suggestedReply: string;
  replyRejected: boolean;
  model: string;
  /** Any analysis keys this version does not know about yet. */
  extra: Record<string, unknown>;
};

export type InboxCard = {
  id: string;
  source: string;
  name: string;
  listing: string;
  listingUrl: string;
  lastMessage: string;
  lastMessageAt: string | null;
  timeLabel: string;
  lastSpeaker: string;
  owesReply: boolean;
  needsYou: boolean;
  category: string;
  stage: string;
  nextAction: string;
  suggestedReply: string;
  threadUrl: string;
  threadHint: string;
  risk: string | null;
  recent: InboxMessage[];
  /** Full thread history (oldest first) when the Mac pushes it; empty on older Mac scripts. */
  history: InboxMessage[];
  analysis: InboxAnalysis | null;
  firstSeen: string | null;
  lastScraped: string | null;
  /** The chat was not in the Mac's latest FB list read; this is the last-known copy (kept because it owes a reply or is recent). */
  notInLatestRead: boolean;
  /** When the chat was last seen in the FB list (Mac's naive Pacific time). */
  lastSeenInList: string | null;
};

export type InboxCardStatus = "open" | "replied" | "handled";

export type InboxCardView = InboxCard & {
  status: InboxCardStatus;
  editedReply: string | null;
  replyVersion: number;
  replyEditedAt: string | null;
  statusChangedAt: string | null;
};

export type FollowupStatus = "open" | "done" | "snoozed";

export type Followup = {
  id: string;
  cardId: string | null;
  client: string;
  listing: string;
  listingUrl: string;
  channel: "Marketplace" | "OfferUp" | "Other";
  said: string;
  nextAction: string;
  reminderDate: string | null;
  status: FollowupStatus;
  outcome: "replied" | "handled";
  stage: string;
  hubspotUrl: string;
  notionPageId: string | null;
  notionUrl: string | null;
  notionError: string | null;
  createdAt: string;
  updatedAt: string;
};

const MAX_TEXT = 4000;
const MAX_RECENT = 20;
export const MAX_HISTORY = 600;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function str(value: unknown, max = MAX_TEXT): string {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}
function optStr(value: unknown, max = 200): string | null {
  const s = str(value, max).trim();
  return s ? s : null;
}
function strList(value: unknown, maxItems = 20): string[] {
  if (Array.isArray(value)) return value.map((v) => str(v, 400).trim()).filter(Boolean).slice(0, maxItems);
  const single = str(value, 400).trim();
  return single ? [single] : [];
}
function strMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === "string" && value.trim()) return { note: value.slice(0, 400) };
  for (const [k, v] of Object.entries(rec(value)).slice(0, 30)) {
    const s = Array.isArray(v) ? strList(v).join(", ") : str(v, 400);
    out[k.slice(0, 60)] = s;
  }
  return out;
}
function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}
function confidence(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.max(0, Math.min(1, scaled));
}

const KNOWN_ANALYSIS = new Set([
  "summary", "stage", "client_wants", "agreed", "agreed_terms", "open_questions", "next_move_owner",
  "next_move_why", "next_action", "risk_flags", "risk_note", "confidence", "unclear", "suggested_reply",
  "reply_rejected", "model",
]);

export function normalizeInboxAnalysis(value: unknown): InboxAnalysis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = rec(value);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (!KNOWN_ANALYSIS.has(k) && JSON.stringify(v ?? null).length <= 2000) extra[k] = v;
  }
  return {
    summary: str(a.summary),
    stage: str(a.stage, 80),
    clientWants: strMap(a.client_wants),
    agreed: strMap(a.agreed ?? a.agreed_terms),
    openQuestions: strList(a.open_questions),
    nextMoveOwner: str(a.next_move_owner, 40),
    nextMoveWhy: str(a.next_move_why, 600),
    nextAction: str(a.next_action, 600),
    riskFlags: strList(a.risk_flags),
    riskNote: str(a.risk_note, 600),
    confidence: confidence(a.confidence),
    unclear: str(a.unclear, 600),
    suggestedReply: str(a.suggested_reply),
    replyRejected: bool(a.reply_rejected),
    model: str(a.model, 80),
    extra,
  };
}

const ATT_KINDS = new Set(["image", "video", "sticker", "file", "attachment"]);
export function normalizeAttachments(value: unknown): InboxAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((v) => {
    const a = rec(v);
    const kind = str(a.kind, 20).toLowerCase();
    return {
      kind: (ATT_KINDS.has(kind) ? kind : "attachment") as InboxAttachment["kind"],
      thumb: safeUrl(a.thumb ?? a.src),
      url: safeUrl(a.url ?? a.href),
      label: str(a.label ?? a.alt, 120),
    };
  });
}

function normalizeMessages(value: unknown, max = MAX_RECENT): InboxMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-max)
    .map((m) => {
      const r = rec(m);
      const msg: InboxMessage = { who: str(r.who, 40) || "unknown", when: str(r.when, 80), at: optStr(r.at, 40), text: str(r.text, 2000) };
      const attachments = normalizeAttachments(r.attachments);
      if (attachments.length) msg.attachments = attachments;
      return msg;
    })
    // Keep photo/attachment-only messages (empty text) when the Mac flags them; drop truly blank rows.
    .filter((m) => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0);
}

export function normalizeInboxCard(value: unknown, fallbackId = ""): InboxCard | null {
  const c = rec(value);
  const id = (str(c.id, 160) || fallbackId).trim();
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  const analysis = normalizeInboxAnalysis(c.analysis);
  const riskRaw = c.risk;
  const risk = typeof riskRaw === "string" && riskRaw.trim() ? riskRaw.slice(0, 600) : null;
  return {
    id,
    source: str(c.source, 60) || "facebook_marketplace",
    name: str(c.name, 160) || "Unknown",
    listing: str(c.listing, 300),
    listingUrl: safeUrl(c.listing_url),
    lastMessage: str(c.last_message, 2000),
    lastMessageAt: optStr(c.last_message_at, 40),
    timeLabel: str(c.time_label, 60),
    lastSpeaker: str(c.last_speaker, 40),
    owesReply: bool(c.owes_reply),
    needsYou: bool(c.needs_you),
    category: str(c.category, 40) || "question",
    stage: str(c.stage, 80) || analysis?.stage || "",
    nextAction: str(c.next_action, 600) || analysis?.nextAction || "",
    suggestedReply: str(c.suggested_reply) || analysis?.suggestedReply || "",
    threadUrl: safeUrl(c.thread_url),
    threadHint: str(c.thread_hint, 300),
    risk,
    recent: normalizeMessages(Array.isArray(c.recent) ? c.recent : c.thread),
    history: normalizeMessages(c.full_history === true || c.full_history === 1 ? c.thread : [], MAX_HISTORY),
    analysis,
    firstSeen: optStr(c.first_seen, 40),
    lastScraped: optStr(c.last_scraped, 40),
    notInLatestRead: bool(c.not_in_latest),
    lastSeenInList: optStr(c.last_seen_in_list ?? (bool(c.not_in_latest) ? c.last_scraped : null), 40),
  };
}

function safeUrl(value: unknown): string {
  const s = str(value, 1000).trim();
  return /^https:\/\//i.test(s) ? s : "";
}

/**
 * Accepts the raw Hermes file (`{ threads: { [id]: card }, updated_at, version }`),
 * `{ threads: [...] }`, or a bare array.
 */
export function normalizeInboxPayload(value: unknown): {
  cards: InboxCard[];
  updatedAt: string | null;
  rejected: number;
  /** Thread ids the Mac marks personal/hidden: never stored, and purged if already stored. */
  excludeIds: string[];
} {
  const root = rec(value);
  const threads = Array.isArray(value) ? value : root.threads;
  const entries: Array<[string, unknown]> = Array.isArray(threads)
    ? threads.map((t, i) => [String(i), t])
    : Object.entries(rec(threads));
  const cards: InboxCard[] = [];
  let rejected = 0;
  for (const [key, raw] of entries.slice(0, 500)) {
    const card = normalizeInboxCard(raw, Array.isArray(threads) ? "" : key);
    if (card) cards.push(card);
    else rejected += 1;
  }
  const excludeIds = (Array.isArray(root.exclude_ids) ? root.exclude_ids : [])
    .map((v) => str(v, 160).trim())
    .filter((v) => /^[A-Za-z0-9._:-]+$/.test(v))
    .slice(0, 500);
  const excluded = new Set(excludeIds);
  return { cards: cards.filter((c) => !excluded.has(c.id)), updatedAt: optStr(root.updated_at, 40), rejected, excludeIds };
}

/* ------------------------------------------------- live mirror: refresh + send queue --- */

export type InboxRefreshStatus = "queued" | "running" | "done" | "failed";
export type InboxRefreshView = {
  id: string;
  reason: "open" | "manual";
  status: InboxRefreshStatus;
  detail: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** queued -> sending (claimed by the Mac) -> sent | failed | unverified. Retry (owner tap only) puts failed/unverified back to queued. */
export type InboxOutboundStatus = "queued" | "sending" | "sent" | "failed" | "unverified";
export type InboxOutboundView = {
  id: string;
  cardId: string;
  text: string;
  idempotencyKey: string;
  status: InboxOutboundStatus;
  detail: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

/** Messages the owner sent from Print Ops that the pushed history does not show yet (match by text, mine only). */
export function pendingOutbound(history: InboxMessage[], outbound: InboxOutboundView[]): InboxOutboundView[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const mine = history.filter((m) => m.who === "miguel" || m.who === "me" || m.who === "us").map((m) => norm(m.text));
  return outbound.filter((o) => !(o.status === "sent" && mine.slice(-30).includes(norm(o.text))));
}

/** YYYY-MM-DD for "today" in the shop's zone. */
export function shopToday(now = new Date(), timeZone = "America/Los_Angeles"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function channelForSource(source: string): Followup["channel"] {
  if (/offerup/i.test(source)) return "OfferUp";
  if (/marketplace|facebook|messenger/i.test(source)) return "Marketplace";
  return "Other";
}
