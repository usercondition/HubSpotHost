/**
 * Persistent single-slot Marketplace send request for the Comet inbox helper.
 *
 * It shares the Marketplace brief database so the queued message survives
 * process restarts without becoming a history of messages to send.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MarketplaceSendRequest = {
  pending: boolean;
  id: number;
  to: string;
  text: string;
};

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS marketplace_send_request (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pending INTEGER NOT NULL CHECK (pending IN (0, 1)),
  request_id INTEGER NOT NULL CHECK (request_id >= 0),
  recipient TEXT NOT NULL,
  message_text TEXT NOT NULL
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

export function getMarketplaceSendRequest(): MarketplaceSendRequest {
  const row = getSqlite()
    .prepare("SELECT pending, request_id, recipient, message_text FROM marketplace_send_request WHERE singleton = 1")
    .get() as { pending: number; request_id: number; recipient: string; message_text: string } | undefined;
  return {
    pending: row?.pending === 1,
    id: row?.request_id ?? 0,
    to: row?.recipient ?? "",
    text: row?.message_text ?? "",
  };
}

export function setMarketplaceSendRequest(
  pending: boolean,
  request?: { text: string; to: string },
): MarketplaceSendRequest {
  const db = getSqlite();
  if (pending) {
    db.prepare(
      `INSERT INTO marketplace_send_request (singleton, pending, request_id, recipient, message_text)
       VALUES (1, 1, 1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         pending = 1,
         request_id = request_id + 1,
         recipient = excluded.recipient,
         message_text = excluded.message_text`,
    ).run(request?.to ?? "", request?.text ?? "");
  } else {
    db.prepare(
      `INSERT INTO marketplace_send_request (singleton, pending, request_id, recipient, message_text)
       VALUES (1, 0, 0, '', '')
       ON CONFLICT(singleton) DO UPDATE SET pending = 0, recipient = '', message_text = ''`,
    ).run();
  }
  return getMarketplaceSendRequest();
}

/** Test helper: clear the one-slot request without changing database configuration. */
export function clearMarketplaceSendRequest(): void {
  getSqlite().prepare("DELETE FROM marketplace_send_request").run();
}

/** Test helper: release the SQLite handle to emulate a process restart. */
export function resetMarketplaceSendRequestStore(): void {
  sqlite?.close();
  sqlite = null;
}
