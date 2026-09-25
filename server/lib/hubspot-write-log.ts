/**
 * One timestamp for every successful HubSpot mutation, not only profit recalcs.
 */
import { getSqlite } from "./order-links";

export function recordHubspotWriteSuccess(at = new Date().toISOString()): void {
  getSqlite()
    .prepare(
      `INSERT INTO hubspot_write_log (id, succeeded_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET succeeded_at = excluded.succeeded_at
       WHERE excluded.succeeded_at >= hubspot_write_log.succeeded_at`,
    )
    .run(at);
}

export function lastHubspotWriteSuccessAt(): string | null {
  const row = getSqlite().prepare(`SELECT succeeded_at FROM hubspot_write_log WHERE id = 1`).get() as
    | { succeeded_at: string }
    | undefined;
  return row?.succeeded_at ?? null;
}
