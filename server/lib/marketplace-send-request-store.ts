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
  message_text TEXT NOT NULL,
  shipment_key TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS marketplace_sent_shipments (
  shipment_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
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
  // Existing deployments created the one-slot table before shipment identity
  // was needed. SQLite has no ADD COLUMN IF NOT EXISTS.
  try {
    sqlite.exec("ALTER TABLE marketplace_send_request ADD COLUMN shipment_key TEXT NOT NULL DEFAULT ''");
  } catch {
    // The column already exists.
  }
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
  request?: { text: string; to: string; shipmentKey?: string },
): MarketplaceSendRequest {
  const db = getSqlite();
  if (pending) {
    db.prepare(
      `INSERT INTO marketplace_send_request (singleton, pending, request_id, recipient, message_text, shipment_key)
       VALUES (1, 1, 1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         pending = 1,
         request_id = request_id + 1,
         recipient = excluded.recipient,
         message_text = excluded.message_text,
         shipment_key = excluded.shipment_key`,
    ).run(request?.to ?? "", request?.text ?? "", request?.shipmentKey ?? "");
  } else {
    const current = db
      .prepare("SELECT shipment_key FROM marketplace_send_request WHERE singleton = 1 AND pending = 1")
      .get() as { shipment_key: string } | undefined;
    if (current?.shipment_key) {
      db.prepare(
        "INSERT OR IGNORE INTO marketplace_sent_shipments (shipment_key, sent_at) VALUES (?, ?)",
      ).run(current.shipment_key, new Date().toISOString());
    }
    db.prepare(
      `INSERT INTO marketplace_send_request (singleton, pending, request_id, recipient, message_text)
       VALUES (1, 0, 0, '', '')
       ON CONFLICT(singleton) DO UPDATE SET pending = 0, recipient = '', message_text = '', shipment_key = ''`,
    ).run();
  }
  return getMarketplaceSendRequest();
}

/**
 * Put one shipment notice in the replacement-only slot. A shipment is keyed
 * by deal and tracking so retries cannot re-message a buyer after it sent.
 */
export function enqueueMarketplaceShipmentSendRequest(request: {
  dealId: string;
  trackingNumber: string;
  to: string;
  text: string;
}): { queued: boolean; request: MarketplaceSendRequest } {
  const shipmentKey = `${request.dealId.trim()}:${request.trackingNumber.trim().toUpperCase()}`;
  const db = getSqlite();
  const current = db
    .prepare("SELECT pending, shipment_key FROM marketplace_send_request WHERE singleton = 1")
    .get() as { pending: number; shipment_key: string } | undefined;
  const sent = db
    .prepare("SELECT 1 FROM marketplace_sent_shipments WHERE shipment_key = ?")
    .get(shipmentKey);
  if ((current?.pending === 1 && current.shipment_key === shipmentKey) || sent) {
    return { queued: false, request: getMarketplaceSendRequest() };
  }
  return {
    queued: true,
    request: setMarketplaceSendRequest(true, { to: request.to, text: request.text, shipmentKey }),
  };
}

/** Test helper: clear the one-slot request without changing database configuration. */
export function clearMarketplaceSendRequest(): void {
  const db = getSqlite();
  db.prepare("DELETE FROM marketplace_send_request").run();
  db.prepare("DELETE FROM marketplace_sent_shipments").run();
}

/** Test helper: release the SQLite handle to emulate a process restart. */
export function resetMarketplaceSendRequestStore(): void {
  sqlite?.close();
  sqlite = null;
}
