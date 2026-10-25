/**
 * Persistent store for Mac-pushed inbox cards, owner reply edits, and
 * follow-up notes (local mirror of the Notion "Client Follow-ups" database).
 * Lives next to the other SQLite files on the Railway `/data` volume.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Followup,
  FollowupStatus,
  InboxCard,
  InboxCardStatus,
  InboxCardView,
  InboxMessage,
  InboxOutboundStatus,
  InboxOutboundView,
  InboxRefreshView,
} from "../../shared/inbox";
import { MAX_HISTORY, inboxReplaceScope, isPausedFacebookInboxSource } from "../../shared/inbox";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_cards (
  id TEXT PRIMARY KEY,
  card_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_message_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  status_changed_at TEXT,
  status_last_message_at TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_reply_edits (
  card_id TEXT PRIMARY KEY,
  reply TEXT NOT NULL,
  version INTEGER NOT NULL,
  edited_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  card_id TEXT,
  client TEXT NOT NULL,
  listing TEXT NOT NULL DEFAULT '',
  listing_url TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'Marketplace',
  said TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  reminder_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  hubspot_url TEXT NOT NULL DEFAULT '',
  notion_page_id TEXT,
  notion_url TEXT,
  notion_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS followups_reminder ON followups(status, reminder_date);
CREATE TABLE IF NOT EXISTS inbox_refresh_requests (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS inbox_outbound (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  claimed_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_outbound_status ON inbox_outbound(status, created_at);
`;

let sqlite: Database.Database | null = null;

function databaseFile(): string {
  const configured = process.env.INBOX_DB_FILE?.trim();
  if (configured === ":memory:") return configured;
  if (configured) return path.resolve(configured);
  const orderLinks = process.env.ORDER_LINKS_DB_FILE?.trim();
  if (orderLinks === ":memory:") return ":memory:";
  return path.resolve(orderLinks ? path.dirname(orderLinks) : "/data", "inbox.db");
}

function db(): Database.Database {
  if (sqlite) return sqlite;
  const file = databaseFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(SCHEMA);
  return sqlite;
}

/** Test hook: drop the in-memory handle so the next call starts fresh. */
export function resetInboxStoreForTests(): void {
  sqlite?.close();
  sqlite = null;
}

function hashCard(card: InboxCard): string {
  return crypto.createHash("sha256").update(JSON.stringify(card)).digest("hex").slice(0, 32);
}

export type PushResult = { received: number; changed: number; reopened: number; removed: number };

/**
 * Replace the card set with the Mac's latest file. Cards that disappear are
 * kept but marked not-present. A handled/replied card reopens when a newer
 * buyer message arrives.
 */
export function upsertInboxCards(cards: InboxCard[], sourceUpdatedAt: string | null, now = new Date()): PushResult {
  const at = now.toISOString();
  const d = db();
  const result: PushResult = { received: cards.length, changed: 0, reopened: 0, removed: 0 };
  const get = d.prepare("SELECT content_hash, status, status_last_message_at FROM inbox_cards WHERE id = ?");
  const insert = d.prepare(
    `INSERT INTO inbox_cards (id, card_json, content_hash, last_message_at, status, present, updated_at)
     VALUES (@id, @json, @hash, @lastAt, 'open', 1, @at)`,
  );
  const update = d.prepare(
    `UPDATE inbox_cards SET card_json=@json, content_hash=@hash, last_message_at=@lastAt, present=1, updated_at=@at,
       status = CASE WHEN @reopen = 1 THEN 'open' ELSE status END,
       status_changed_at = CASE WHEN @reopen = 1 THEN @at ELSE status_changed_at END
     WHERE id=@id`,
  );
  const tx = d.transaction(() => {
    const ids = new Set<string>();
    const scopes = new Set<string>();
    for (const card of cards) {
      ids.add(card.id);
      scopes.add(inboxReplaceScope(card.source));
      const hash = hashCard(card);
      const row = get.get(card.id) as { content_hash: string; status: string; status_last_message_at: string | null } | undefined;
      const params = { id: card.id, json: JSON.stringify(card), hash, lastAt: card.lastMessageAt, at };
      if (!row) {
        insert.run(params);
        result.changed += 1;
        continue;
      }
      const reopen =
        row.status !== "open" &&
        card.owesReply &&
        Boolean(card.lastMessageAt) &&
        card.lastMessageAt !== row.status_last_message_at
          ? 1
          : 0;
      if (row.content_hash !== hash || reopen) {
        update.run({ ...params, reopen });
        result.changed += 1;
        result.reopened += reopen;
      } else {
        d.prepare("UPDATE inbox_cards SET present=1 WHERE id=?").run(card.id);
      }
    }
    const present = d.prepare("SELECT id, card_json FROM inbox_cards WHERE present=1").all() as Array<{ id: string; card_json: string }>;
    const gone = d.prepare("UPDATE inbox_cards SET present=0 WHERE id=?");
    for (const row of present) {
      if (ids.has(row.id) || scopes.size === 0) continue;
      let scope = "source:";
      try {
        scope = inboxReplaceScope(String((JSON.parse(row.card_json) as { source?: string }).source ?? ""));
      } catch {
        scope = "source:";
      }
      if (!scopes.has(scope)) continue;
      gone.run(row.id);
      result.removed += 1;
    }
    setMeta("last_push_at", at);
    setMeta("last_checkin_at", at);
    if (sourceUpdatedAt) {
      if (getMeta("source_updated_at") !== sourceUpdatedAt) setMeta("source_changed_at", at);
      setMeta("source_updated_at", sourceUpdatedAt);
    }
  });
  tx();
  return result;
}

/**
 * Personal / hidden threads the Mac excludes: delete every stored trace (card, reply edit, queued sends)
 * so nothing personal stays on the server. Returns how many cards were removed.
 */
/** Delete stored Facebook Marketplace cards. Seller-channel cards stay. */
export function purgePausedFacebookCards(): number {
  const rows = db().prepare("SELECT id, card_json FROM inbox_cards").all() as Array<{ id: string; card_json: string }>;
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const source = String((JSON.parse(row.card_json) as { source?: string }).source ?? "");
      if (isPausedFacebookInboxSource(source)) ids.push(row.id);
    } catch {
      /* leave a row we cannot read */
    }
  }
  return purgeInboxCards(ids);
}

function combineHistory(prev: InboxCard, incoming: InboxCard): InboxCard {
  const key = (m: InboxMessage) => `${m.who}|${m.at ?? ""}|${m.text.replace(/\s+/g, " ").trim()}`;
  const seen = new Set((Array.isArray(prev.history) ? prev.history : []).map(key));
  const history = [...(Array.isArray(prev.history) ? prev.history : [])];
  for (const message of incoming.history ?? []) {
    const id = key(message);
    if (seen.has(id)) continue;
    seen.add(id);
    history.push(message);
  }
  history.sort((a, b) => (a.at && b.at && a.at !== b.at ? (a.at < b.at ? -1 : 1) : 0));
  const trimmed = history.slice(-MAX_HISTORY);
  const last = trimmed[trimmed.length - 1];
  return {
    ...incoming,
    history: trimmed,
    recent: trimmed.slice(-8),
    lastMessage: last?.text || incoming.lastMessage,
    lastMessageAt: last?.at || incoming.lastMessageAt,
    lastSpeaker: last?.who || incoming.lastSpeaker,
    owesReply: last ? last.who === "buyer" : incoming.owesReply,
    firstSeen: prev.firstSeen ?? incoming.firstSeen,
  };
}

/**
 * Insert or update these cards only. Other channels and other threads stay.
 * Used by Gmail ingest, which is a stream of notifications, not a full snapshot.
 */
export function mergeInboxCards(cards: InboxCard[], now = new Date()): PushResult {
  const at = now.toISOString();
  const d = db();
  const result: PushResult = { received: cards.length, changed: 0, reopened: 0, removed: 0 };
  const get = d.prepare("SELECT card_json, content_hash, status, status_last_message_at FROM inbox_cards WHERE id = ?");
  const insert = d.prepare(
    `INSERT INTO inbox_cards (id, card_json, content_hash, last_message_at, status, present, updated_at)
     VALUES (@id, @json, @hash, @lastAt, 'open', 1, @at)`,
  );
  const update = d.prepare(
    `UPDATE inbox_cards SET card_json=@json, content_hash=@hash, last_message_at=@lastAt, present=1, updated_at=@at,
       status = CASE WHEN @reopen = 1 THEN 'open' ELSE status END,
       status_changed_at = CASE WHEN @reopen = 1 THEN @at ELSE status_changed_at END
     WHERE id=@id`,
  );
  const tx = d.transaction(() => {
    for (const incoming of cards) {
      const row = get.get(incoming.id) as
        | { card_json: string; content_hash: string; status: string; status_last_message_at: string | null }
        | undefined;
      const card = row ? combineHistory(JSON.parse(row.card_json) as InboxCard, incoming) : incoming;
      const hash = hashCard(card);
      const params = { id: card.id, json: JSON.stringify(card), hash, lastAt: card.lastMessageAt, at };
      if (!row) {
        insert.run(params);
        result.changed += 1;
        continue;
      }
      const reopen =
        row.status !== "open" && card.owesReply && Boolean(card.lastMessageAt) && card.lastMessageAt !== row.status_last_message_at
          ? 1
          : 0;
      if (row.content_hash !== hash || reopen) {
        update.run({ ...params, reopen });
        result.changed += 1;
        result.reopened += reopen;
      }
    }
  });
  tx();
  return result;
}

export function purgeInboxCards(ids: string[]): number {
  if (ids.length === 0) return 0;
  const d = db();
  let n = 0;
  d.transaction(() => {
    for (const id of ids) {
      n += d.prepare("DELETE FROM inbox_cards WHERE id=?").run(id).changes;
      d.prepare("DELETE FROM inbox_reply_edits WHERE card_id=?").run(id);
      d.prepare("DELETE FROM inbox_outbound WHERE card_id=?").run(id);
    }
  })();
  return n;
}

/**
 * Merge a fresh single-thread read (after a send) into the stored history: keeps everything already stored and
 * appends only the tail messages that are not there yet. Never shortens history.
 */
export function mergeThreadRead(cardId: string, fresh: InboxMessage[], now = new Date()): { ok: boolean; added: number } {
  const row = db().prepare("SELECT card_json FROM inbox_cards WHERE id=?").get(cardId) as { card_json: string } | undefined;
  if (!row) return { ok: false, added: 0 };
  const card = JSON.parse(row.card_json) as InboxCard;
  const history = Array.isArray(card.history) ? card.history : [];
  const key = (m: InboxMessage) => `${m.who}|${m.text.replace(/\s+/g, " ").trim()}`;
  // Find the longest suffix of `history` that is a prefix of `fresh` (overlap), then append the rest.
  const hk = history.map(key);
  const fk = fresh.map(key);
  let overlap = 0;
  for (let n = Math.min(hk.length, fk.length); n > 0; n--) {
    if (hk.slice(hk.length - n).join("\n") === fk.slice(0, n).join("\n")) {
      overlap = n;
      break;
    }
  }
  let add = fresh.slice(overlap);
  if (overlap === 0) {
    // No clean overlap (popup shows only a window): append only messages not already in the last 60 stored.
    const recent = new Set(hk.slice(-60));
    add = fresh.filter((m) => !recent.has(key(m)));
  }
  if (add.length === 0) return { ok: true, added: 0 };
  const merged = [...history, ...add].slice(-MAX_HISTORY);
  const last = merged[merged.length - 1];
  const next: InboxCard = {
    ...card,
    history: merged,
    recent: merged.slice(-8),
    lastMessage: last?.text ?? card.lastMessage,
    lastSpeaker: last?.who ?? card.lastSpeaker,
    owesReply: last ? last.who === "buyer" : card.owesReply,
  };
  db()
    .prepare("UPDATE inbox_cards SET card_json=?, content_hash=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(next), hashCard(next), now.toISOString(), cardId);
  return { ok: true, added: add.length };
}

/* ------------------------------------------------------- refresh requests --- */

export const REFRESH_MANUAL_COOLDOWN_MS = 60_000;
export const REFRESH_OPEN_COOLDOWN_MS = 15 * 60_000;
export const REFRESH_STALE_MS = 10 * 60_000;
export const OUTBOUND_STALE_MS = 10 * 60_000;

type RefreshRow = {
  id: string; reason: string; status: string; detail: string; requested_at: string; started_at: string | null; finished_at: string | null;
};
function refreshView(r: RefreshRow): InboxRefreshView {
  return {
    id: r.id, reason: r.reason === "open" ? "open" : "manual", status: r.status as InboxRefreshView["status"], detail: r.detail,
    requestedAt: r.requested_at, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

/** A claimed refresh with no result for 10 min is failed (the Mac died or went offline mid-read). */
function expireStale(now: Date): void {
  const cut = new Date(now.getTime() - REFRESH_STALE_MS).toISOString();
  db()
    .prepare("UPDATE inbox_refresh_requests SET status='failed', detail='No result from the Mac within 10 min', finished_at=? WHERE status='running' AND started_at < ?")
    .run(now.toISOString(), cut);
  // Queued and never picked up: failed after 30 min, or after 4 h when it is waiting for a busy FB browser
  // (the Mac marked it "Waiting: ..." via fbBusy; it is handed out as soon as the browser is free).
  const qcut = new Date(now.getTime() - 30 * 60_000).toISOString();
  const wcut = new Date(now.getTime() - 4 * 60 * 60_000).toISOString();
  db()
    .prepare(
      `UPDATE inbox_refresh_requests SET status='failed', detail=CASE WHEN detail LIKE 'Waiting:%' THEN 'FB browser stayed busy for 4 h; tap Refresh again' ELSE 'Mac did not pick this up within 30 min' END, finished_at=?
       WHERE status='queued' AND ((detail NOT LIKE 'Waiting:%' AND requested_at < ?) OR requested_at < ?)`,
    )
    .run(now.toISOString(), qcut, wcut);
  const ocut = new Date(now.getTime() - OUTBOUND_STALE_MS).toISOString();
  db()
    .prepare(
      `UPDATE inbox_outbound SET status='unverified', detail='No result from the Mac within 10 min. Check Messenger before retrying.', updated_at=?
       WHERE status='sending' AND claimed_at < ?`,
    )
    .run(now.toISOString(), ocut);
}

export function latestRefresh(now = new Date()): InboxRefreshView | null {
  expireStale(now);
  const r = db().prepare("SELECT * FROM inbox_refresh_requests ORDER BY requested_at DESC, rowid DESC LIMIT 1").get() as RefreshRow | undefined;
  return r ? refreshView(r) : null;
}

export type RefreshRequestResult =
  | { queued: true; refresh: InboxRefreshView }
  | { queued: false; reason: "in_progress" | "cooldown" | "fresh"; refresh: InboxRefreshView | null; retryAfterMs?: number };

/**
 * Ask the Mac for an FB inbox read. `open` (page opened): skipped when the data or the last request is under 15 min old.
 * `manual` (Refresh tap): bypasses the 15 min rule but keeps a 60 s anti-spam cooldown. One request in flight at a time.
 */
export function requestInboxRefresh(reason: "open" | "manual", now = new Date()): RefreshRequestResult {
  const last = latestRefresh(now);
  if (last && (last.status === "queued" || last.status === "running")) return { queued: false, reason: "in_progress", refresh: last };
  const nowMs = now.getTime();
  if (last) {
    const age = nowMs - Date.parse(last.requestedAt);
    const cooldown = reason === "manual" ? REFRESH_MANUAL_COOLDOWN_MS : REFRESH_OPEN_COOLDOWN_MS;
    if (age < cooldown) return { queued: false, reason: "cooldown", refresh: last, retryAfterMs: cooldown - age };
  }
  if (reason === "open") {
    // Server time when fresh FB data last arrived (source_updated_at is the Mac's naive local time, so not compared directly).
    const changed = getMeta("source_changed_at");
    if (changed && nowMs - Date.parse(changed) < REFRESH_OPEN_COOLDOWN_MS) {
      return { queued: false, reason: "fresh", refresh: last };
    }
  }
  const id = crypto.randomUUID();
  db()
    .prepare("INSERT INTO inbox_refresh_requests (id, reason, status, requested_at) VALUES (?, ?, 'queued', ?)")
    .run(id, reason, now.toISOString());
  return { queued: true, refresh: latestRefresh(now)! };
}

/**
 * The Mac reports whether its FB browser is busy (fb_browser_lifecycle lock held / CDP :9333 in use by another job).
 * While busy, a queued refresh stays queued (with a "waiting" detail) instead of being handed out.
 */
export function noteFbBusy(busy: boolean, detail: string, now = new Date()): void {
  setMeta("fb_busy_at", busy ? now.toISOString() : "");
  setMeta("fb_busy_detail", busy ? detail.slice(0, 120) : "");
  if (busy) {
    db()
      .prepare("UPDATE inbox_refresh_requests SET detail=? WHERE status='queued'")
      .run(`Waiting: ${detail.slice(0, 120) || "FB browser busy with another job"}`);
  }
}

/** Mac claims the queued refresh (at most one). */
export function claimRefresh(now = new Date()): InboxRefreshView | null {
  expireStale(now);
  const r = db().prepare("SELECT * FROM inbox_refresh_requests WHERE status='queued' ORDER BY requested_at LIMIT 1").get() as RefreshRow | undefined;
  if (!r) return null;
  db().prepare("UPDATE inbox_refresh_requests SET status='running', started_at=?, detail='' WHERE id=? AND status='queued'").run(now.toISOString(), r.id);
  return refreshView({ ...r, status: "running", detail: "", started_at: now.toISOString() });
}

export function finishRefresh(id: string, ok: boolean, detail: string, now = new Date()): boolean {
  const res = db()
    .prepare("UPDATE inbox_refresh_requests SET status=?, detail=?, finished_at=? WHERE id=? AND status IN ('running','queued')")
    .run(ok ? "done" : "failed", detail.slice(0, 300), now.toISOString(), id);
  return res.changes > 0;
}

/* ------------------------------------------------------------ send queue --- */

type OutboundRow = {
  id: string; card_id: string; text: string; idempotency_key: string; status: string; detail: string; attempt: number;
  claimed_at: string | null; sent_at: string | null; created_at: string; updated_at: string;
};
function outboundView(r: OutboundRow): InboxOutboundView {
  return {
    id: r.id, cardId: r.card_id, text: r.text, idempotencyKey: r.idempotency_key, status: r.status as InboxOutboundStatus,
    detail: r.detail, attempt: r.attempt, createdAt: r.created_at, updatedAt: r.updated_at, sentAt: r.sent_at,
  };
}

export class OutboundKeyConflictError extends Error {
  constructor() {
    super("That idempotency key was already used for a different message.");
  }
}

/**
 * Queue one owner-pressed Send. The idempotency key makes a double tap / network retry return the same row
 * instead of a second message. Reusing a key with different text or card is rejected.
 */
export function queueOutbound(cardId: string, text: string, idempotencyKey: string, now = new Date()): { created: boolean; outbound: InboxOutboundView } {
  const d = db();
  const existing = d.prepare("SELECT * FROM inbox_outbound WHERE idempotency_key=?").get(idempotencyKey) as OutboundRow | undefined;
  if (existing) {
    if (existing.card_id !== cardId || existing.text !== text) throw new OutboundKeyConflictError();
    return { created: false, outbound: outboundView(existing) };
  }
  const id = crypto.randomUUID();
  const at = now.toISOString();
  d.prepare(
    "INSERT INTO inbox_outbound (id, card_id, text, idempotency_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
  ).run(id, cardId, text, idempotencyKey, at, at);
  return { created: true, outbound: getOutbound(id)! };
}

export function getOutbound(id: string): InboxOutboundView | null {
  const r = db().prepare("SELECT * FROM inbox_outbound WHERE id=?").get(id) as OutboundRow | undefined;
  return r ? outboundView(r) : null;
}

/** Recent sends for the UI: anything not final, plus final ones from the last 3 days. */
export function listOutbound(now = new Date()): InboxOutboundView[] {
  expireStale(now);
  const cut = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const rows = db()
    .prepare("SELECT * FROM inbox_outbound WHERE status IN ('queued','sending') OR updated_at >= ? ORDER BY created_at LIMIT 300")
    .all(cut) as OutboundRow[];
  return rows.map(outboundView);
}

/** Mac claims queued sends (oldest first). A claimed row is never handed out again unless the owner taps Retry. */
export function claimOutbound(limit = 3, now = new Date()): InboxOutboundView[] {
  expireStale(now);
  const d = db();
  const at = now.toISOString();
  const out: InboxOutboundView[] = [];
  d.transaction(() => {
    const rows = d.prepare("SELECT * FROM inbox_outbound WHERE status='queued' ORDER BY created_at LIMIT ?").all(limit) as OutboundRow[];
    for (const r of rows) {
      const res = d.prepare("UPDATE inbox_outbound SET status='sending', claimed_at=?, updated_at=? WHERE id=? AND status='queued'").run(at, at, r.id);
      if (res.changes) out.push(outboundView({ ...r, status: "sending", claimed_at: at, updated_at: at }));
    }
  })();
  return out;
}

/** Mac reports the result for one claimed attempt. Ignored unless the row is `sending` on that same attempt. */
export function finishOutbound(
  id: string,
  attempt: number,
  status: "sent" | "failed" | "unverified",
  detail: string,
  now = new Date(),
): InboxOutboundView | null {
  const at = now.toISOString();
  const res = db()
    .prepare("UPDATE inbox_outbound SET status=?, detail=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END, updated_at=? WHERE id=? AND attempt=? AND status='sending'")
    .run(status, detail.slice(0, 300), status, at, at, id, attempt);
  return res.changes ? getOutbound(id) : null;
}

/** Owner tapped Retry on a failed/unverified send: same row, next attempt, back in the queue. */
export function retryOutbound(id: string, now = new Date()): InboxOutboundView | null {
  const at = now.toISOString();
  const res = db()
    .prepare("UPDATE inbox_outbound SET status='queued', detail='', attempt=attempt+1, claimed_at=NULL, updated_at=? WHERE id=? AND status IN ('failed','unverified')")
    .run(at, id);
  return res.changes ? getOutbound(id) : null;
}

function setMeta(key: string, value: string): void {
  db().prepare("INSERT INTO inbox_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function getMeta(key: string): string | null {
  const row = db().prepare("SELECT value FROM inbox_meta WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setInboxMeta(key: string, value: string): void {
  setMeta(key, value);
}

type CardRow = {
  id: string;
  card_json: string;
  status: InboxCardStatus;
  status_changed_at: string | null;
  reply: string | null;
  version: number | null;
  edited_at: string | null;
};

function toView(row: CardRow): InboxCardView {
  const card = JSON.parse(row.card_json) as InboxCard;
  return {
    ...card,
    history: Array.isArray(card.history) ? card.history : [],
    status: row.status,
    statusChangedAt: row.status_changed_at,
    editedReply: row.reply,
    replyVersion: row.version ?? 0,
    replyEditedAt: row.edited_at,
  };
}

const CARD_SELECT = `SELECT c.id, c.card_json, c.status, c.status_changed_at, e.reply, e.version, e.edited_at
  FROM inbox_cards c LEFT JOIN inbox_reply_edits e ON e.card_id = c.id`;

export function listInboxCards(): InboxCardView[] {
  const rows = db().prepare(`${CARD_SELECT} WHERE c.present = 1 ORDER BY c.last_message_at DESC`).all() as CardRow[];
  return rows.map(toView);
}

export function getInboxCard(id: string): InboxCardView | null {
  const row = db().prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) as CardRow | undefined;
  return row ? toView(row) : null;
}

export class VersionConflictError extends Error {
  constructor(public current: number) {
    super("This reply was changed elsewhere. Reload and try again.");
  }
}

/** Save an owner edit. `expectedVersion` (optional) guards against overwriting a newer edit. */
export function saveReplyEdit(cardId: string, reply: string, expectedVersion?: number, now = new Date()) {
  const d = db();
  const row = d.prepare("SELECT version FROM inbox_reply_edits WHERE card_id=?").get(cardId) as { version: number } | undefined;
  const current = row?.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== current) throw new VersionConflictError(current);
  const version = current + 1;
  const editedAt = now.toISOString();
  d.prepare(
    `INSERT INTO inbox_reply_edits (card_id, reply, version, edited_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(card_id) DO UPDATE SET reply=excluded.reply, version=excluded.version, edited_at=excluded.edited_at`,
  ).run(cardId, reply, version, editedAt);
  return { cardId, reply, version, editedAt };
}

/** Edits since an ISO time, for the Mac to pull back into Hermes. */
export function listReplyEditsSince(since: string | null) {
  const rows = db()
    .prepare("SELECT card_id, reply, version, edited_at FROM inbox_reply_edits WHERE (? IS NULL OR edited_at > ?) ORDER BY edited_at")
    .all(since, since) as Array<{ card_id: string; reply: string; version: number; edited_at: string }>;
  return rows.map((r) => ({ cardId: r.card_id, reply: r.reply, version: r.version, editedAt: r.edited_at }));
}

export function setCardStatus(cardId: string, status: InboxCardStatus, now = new Date()): boolean {
  const row = db().prepare("SELECT last_message_at FROM inbox_cards WHERE id=?").get(cardId) as { last_message_at: string | null } | undefined;
  if (!row) return false;
  db()
    .prepare("UPDATE inbox_cards SET status=?, status_changed_at=?, status_last_message_at=? WHERE id=?")
    .run(status, now.toISOString(), row.last_message_at, cardId);
  return true;
}

/* ------------------------------------------------------------ follow-ups --- */

type FollowupRow = {
  id: string; card_id: string | null; client: string; listing: string; listing_url: string; channel: string;
  said: string; next_action: string; reminder_date: string | null; status: string; outcome: string; stage: string;
  hubspot_url: string; notion_page_id: string | null; notion_url: string | null; notion_error: string | null;
  created_at: string; updated_at: string;
};

function followupFromRow(r: FollowupRow): Followup {
  return {
    id: r.id, cardId: r.card_id, client: r.client, listing: r.listing, listingUrl: r.listing_url,
    channel: r.channel as Followup["channel"], said: r.said, nextAction: r.next_action, reminderDate: r.reminder_date,
    status: r.status as FollowupStatus, outcome: r.outcome as Followup["outcome"], stage: r.stage,
    hubspotUrl: r.hubspot_url, notionPageId: r.notion_page_id, notionUrl: r.notion_url, notionError: r.notion_error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export type NewFollowup = Omit<Followup, "id" | "notionPageId" | "notionUrl" | "notionError" | "createdAt" | "updatedAt" | "status"> & {
  status?: FollowupStatus;
};

export function createFollowup(input: NewFollowup, now = new Date()): Followup {
  const at = now.toISOString();
  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO followups (id, card_id, client, listing, listing_url, channel, said, next_action, reminder_date, status,
        outcome, stage, hubspot_url, created_at, updated_at)
       VALUES (@id, @cardId, @client, @listing, @listingUrl, @channel, @said, @nextAction, @reminderDate, @status,
        @outcome, @stage, @hubspotUrl, @at, @at)`,
    )
    .run({ ...input, id, status: input.status ?? "open", at });
  return getFollowup(id)!;
}

export function getFollowup(id: string): Followup | null {
  const row = db().prepare("SELECT * FROM followups WHERE id=?").get(id) as FollowupRow | undefined;
  return row ? followupFromRow(row) : null;
}

export function listFollowups(opts: { includeDone?: boolean } = {}): Followup[] {
  const rows = db()
    .prepare(
      `SELECT * FROM followups ${opts.includeDone ? "" : "WHERE status != 'done'"}
       ORDER BY CASE WHEN reminder_date IS NULL THEN 1 ELSE 0 END, reminder_date, created_at DESC LIMIT 500`,
    )
    .all() as FollowupRow[];
  return rows.map(followupFromRow);
}

export function updateFollowup(
  id: string,
  patch: Partial<Pick<Followup, "status" | "reminderDate" | "nextAction">>,
  now = new Date(),
): Followup | null {
  const existing = getFollowup(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  db()
    .prepare("UPDATE followups SET status=?, reminder_date=?, next_action=?, updated_at=? WHERE id=?")
    .run(next.status, next.reminderDate, next.nextAction, now.toISOString(), id);
  return getFollowup(id);
}

export function setFollowupNotion(id: string, result: { pageId?: string | null; url?: string | null; error?: string | null }): void {
  db()
    .prepare(
      "UPDATE followups SET notion_page_id=COALESCE(?, notion_page_id), notion_url=COALESCE(?, notion_url), notion_error=? WHERE id=?",
    )
    .run(result.pageId ?? null, result.url ?? null, result.error ?? null, id);
}

/** Open follow-ups whose reminder date is on/before `today` (YYYY-MM-DD). */
export function listDueFollowups(today: string): Followup[] {
  const rows = db()
    .prepare("SELECT * FROM followups WHERE status='open' AND reminder_date IS NOT NULL AND reminder_date <= ? ORDER BY reminder_date")
    .all(today) as FollowupRow[];
  return rows.map(followupFromRow);
}

/** Follow-ups whose Notion write failed or never ran (retried by the cron). */
export function listUnsyncedFollowups(): Followup[] {
  const rows = db().prepare("SELECT * FROM followups WHERE notion_page_id IS NULL ORDER BY created_at LIMIT 25").all() as FollowupRow[];
  return rows.map(followupFromRow);
}
