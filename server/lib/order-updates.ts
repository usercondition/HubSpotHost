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
import { getDb } from "./order-links";

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
