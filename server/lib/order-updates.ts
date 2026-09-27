/**
 * Append-only update log for Stack orders.
 * Rows live in the same SQLite file as off-book orders and stack edits.
 * Nothing here is written to HubSpot.
 */
import { desc, eq } from "drizzle-orm";
import {
  orderUpdateLog,
  type OrderUpdateEntry,
  type OrderUpdateSource,
} from "../../shared/schema";
import { getDb, getSqlite } from "./order-links";

function toEntry(row: typeof orderUpdateLog.$inferSelect): OrderUpdateEntry {
  return {
    id: row.id,
    orderKey: row.orderKey,
    createdAt: row.createdAt,
    text: row.entryText,
    source: row.source as OrderUpdateSource,
    author: row.author,
  };
}

export function listOrderUpdates(orderKey: string): OrderUpdateEntry[] {
  return getDb()
    .select()
    .from(orderUpdateLog)
    .where(eq(orderUpdateLog.orderKey, orderKey))
    .orderBy(desc(orderUpdateLog.id))
    .all()
    .map(toEntry);
}

function ensureAppliedColumn(): void {
  const columns = getSqlite().prepare(`PRAGMA table_info(order_update_log)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "applied_at")) {
    getSqlite().exec(`ALTER TABLE order_update_log ADD COLUMN applied_at TEXT`);
  }
}

/** Stamp a log row only after the HubSpot write it describes has succeeded. */
export function markOrderUpdateApplied(id: number, at = new Date().toISOString()): void {
  ensureAppliedColumn();
  getSqlite().prepare(`UPDATE order_update_log SET applied_at = ? WHERE id = ?`).run(at, id);
}

export function orderUpdateAppliedAt(id: number): string | null {
  ensureAppliedColumn();
  const row = getSqlite().prepare(`SELECT applied_at FROM order_update_log WHERE id = ?`).get(id) as
    | { applied_at: string | null }
    | undefined;
  const value = row?.applied_at?.trim() ?? "";
  return value || null;
}

export function appendOrderUpdate(input: {
  orderKey: string;
  text: string;
  source: OrderUpdateSource;
  author: string;
  now?: Date;
}): OrderUpdateEntry {
  const createdAt = (input.now ?? new Date()).toISOString();
  const inserted = getDb()
    .insert(orderUpdateLog)
    .values({
      orderKey: input.orderKey,
      createdAt,
      entryText: input.text,
      source: input.source,
      author: input.author,
    })
    .returning()
    .get();
  return toEntry(inserted);
}
