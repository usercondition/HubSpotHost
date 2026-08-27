/**
 * Persistent single-slot store for the Marketplace inbox secretary brief.
 *
 * The configured order-links SQLite database normally lives on `/data`; using
 * it here keeps the brief available after a process restart or deployment.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MarketplaceInboxBrief, MarketplaceThreadInput } from "./marketplace-inbox-brief";
import { buildMarketplaceInboxBrief } from "./marketplace-inbox-brief";

const MAX_THREADS = 40;
const LATEST_BRIEF_ID = "latest";
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS marketplace_inbox_brief (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  brief_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

let sqlite: Database.Database | null = null;

function databaseFile(): string {
  const configured = process.env.MARKETPLACE_INBOX_BRIEF_DB_FILE?.trim() || process.env.ORDER_LINKS_DB_FILE?.trim();
  return configured === ":memory:" ? configured : path.resolve(configured || "/data/marketplace-inbox-brief.db");
}

function getSqlite(): Database.Database {
  if (sqlite) return sqlite;
  const file = databaseFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(CREATE_TABLE_SQL);
  return sqlite;
}

export function createMarketplaceInboxBrief(threads: MarketplaceThreadInput[]): {
  id: string;
  brief: MarketplaceInboxBrief;
} {
  if (!Array.isArray(threads) || threads.length === 0) {
    throw new Error("Scan at least one Marketplace conversation");
  }
  const clipped = threads.slice(0, MAX_THREADS).map((thread, index) => ({
    id: String(thread.id || `t-${index}`).slice(0, 160),
    title: String(thread.title || `Thread ${index + 1}`).slice(0, 200),
    conversation: String(thread.conversation || "").slice(0, 40_000),
    unread: Boolean(thread.unread),
    lastActivityAt: thread.lastActivityAt ? String(thread.lastActivityAt).slice(0, 80) : null,
  }));
  if (!clipped.some((t) => t.conversation.trim().length >= 20)) {
    throw new Error("Scanned threads did not include enough message text");
  }
  const brief = buildMarketplaceInboxBrief(clipped);
  getSqlite()
    .prepare(
      `INSERT INTO marketplace_inbox_brief (singleton, brief_json, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET brief_json = excluded.brief_json, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(brief), new Date().toISOString());
  return { id: LATEST_BRIEF_ID, brief };
}

/** The historic capability id is intentionally ignored: only one latest brief exists. */
export function getMarketplaceInboxBrief(_id?: string): MarketplaceInboxBrief | null {
  const row = getSqlite()
    .prepare("SELECT brief_json FROM marketplace_inbox_brief WHERE singleton = 1")
    .get() as { brief_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.brief_json) as MarketplaceInboxBrief;
  } catch {
    return null;
  }
}

export function clearMarketplaceInboxBriefs(): void {
  getSqlite().prepare("DELETE FROM marketplace_inbox_brief").run();
}

/** Test helper: release the SQLite handle before deleting or changing its file. */
export function resetMarketplaceInboxBriefStore(): void {
  sqlite?.close();
  sqlite = null;
}
