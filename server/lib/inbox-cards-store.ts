/**
 * Persistent store for Mac-pushed inbox cards, owner reply edits, and
 * follow-up notes (local mirror of the Notion "Client Follow-ups" database).
 * Lives next to the other SQLite files on the Railway `/data` volume.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Followup, FollowupStatus, InboxCard, InboxCardStatus, InboxCardView } from "../../shared/inbox";

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
    for (const card of cards) {
      ids.add(card.id);
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
    const present = d.prepare("SELECT id FROM inbox_cards WHERE present=1").all() as Array<{ id: string }>;
    const gone = d.prepare("UPDATE inbox_cards SET present=0 WHERE id=?");
    for (const { id } of present) {
      if (!ids.has(id)) {
        gone.run(id);
        result.removed += 1;
      }
    }
    setMeta("last_push_at", at);
    if (sourceUpdatedAt) setMeta("source_updated_at", sourceUpdatedAt);
  });
  tx();
  return result;
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
