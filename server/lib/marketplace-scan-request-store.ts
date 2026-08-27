/**
 * Persistent one-slot trigger for an on-demand Marketplace inbox scan.
 *
 * It deliberately shares the Marketplace brief database selection so the
 * request survives the same process restarts and deployments as the brief.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MarketplaceScanRequest = {
  requested: boolean;
  id: number;
};

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS marketplace_scan_request (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  requested INTEGER NOT NULL CHECK (requested IN (0, 1)),
  request_id INTEGER NOT NULL CHECK (request_id >= 0)
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

export function getMarketplaceScanRequest(): MarketplaceScanRequest {
  const row = getSqlite()
    .prepare("SELECT requested, request_id FROM marketplace_scan_request WHERE singleton = 1")
    .get() as { requested: number; request_id: number } | undefined;
  return { requested: row?.requested === 1, id: row?.request_id ?? 0 };
}

export function setMarketplaceScanRequest(requested: boolean): MarketplaceScanRequest {
  const db = getSqlite();
  if (requested) {
    db.prepare(
      `INSERT INTO marketplace_scan_request (singleton, requested, request_id)
       VALUES (1, 1, 1)
       ON CONFLICT(singleton) DO UPDATE SET requested = 1, request_id = request_id + 1`,
    ).run();
  } else {
    db.prepare("UPDATE marketplace_scan_request SET requested = 0 WHERE singleton = 1").run();
  }
  return getMarketplaceScanRequest();
}

/** Test helper: clear the one-slot request without changing the database configuration. */
export function clearMarketplaceScanRequest(): void {
  getSqlite().prepare("DELETE FROM marketplace_scan_request").run();
}

/** Test helper: release the SQLite handle to emulate a process restart. */
export function resetMarketplaceScanRequestStore(): void {
  sqlite?.close();
  sqlite = null;
}
