/**
 * Idempotent shipped-email log so the same deal+tracking is never emailed twice.
 * Shares the marketplace brief DB file (same volume) for persistence across deploys.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS shipped_email_sent (
  shipment_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  resend_id TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
`;

let sqlite: Database.Database | null = null;

function databaseFile(): string {
  const configured =
    process.env.SHIPPED_EMAIL_DB_FILE?.trim() ||
    process.env.MARKETPLACE_INBOX_BRIEF_DB_FILE?.trim() ||
    process.env.ORDER_LINKS_DB_FILE?.trim();
  return configured === ":memory:" ? configured : path.resolve(configured || "/data/marketplace-inbox-brief.db");
}

function getSqlite(): Database.Database {
  if (sqlite) return sqlite;
  const file = databaseFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(CREATE_SQL);
  return sqlite;
}

export function shippedEmailShipmentKey(dealId: string, trackingNumber: string): string {
  return `${dealId.trim()}:${trackingNumber.trim().toUpperCase()}`;
}

export function wasShippedEmailSent(dealId: string, trackingNumber: string): boolean {
  const key = shippedEmailShipmentKey(dealId, trackingNumber);
  const row = getSqlite()
    .prepare("SELECT 1 FROM shipped_email_sent WHERE shipment_key = ?")
    .get(key);
  return Boolean(row);
}

export function recordShippedEmailSent(input: {
  dealId: string;
  trackingNumber: string;
  email: string;
  resendId?: string;
}): void {
  const key = shippedEmailShipmentKey(input.dealId, input.trackingNumber);
  getSqlite()
    .prepare(
      `INSERT OR IGNORE INTO shipped_email_sent (shipment_key, email, resend_id, sent_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(key, input.email.trim(), input.resendId ?? "", new Date().toISOString());
}

/** Test helper. */
export function clearShippedEmailSent(): void {
  getSqlite().prepare("DELETE FROM shipped_email_sent").run();
}

/** Test helper. */
export function resetShippedEmailStore(): void {
  sqlite?.close();
  sqlite = null;
}
