/**
 * Non-sensitive webhook diagnostics for deployment troubleshooting.
 * Never store signature values, request bodies, headers, or secrets.
 * The latest delivery is in SQLite so a deploy does not wipe it.
 */
import { getSqlite } from "./order-links";

export interface WebhookDiagnostic {
  receivedAt: string;
  result: "accepted" | "rejected";
  version: "v1" | "v3" | null;
  reason: string;
  eventCount: number;
}

let latest: WebhookDiagnostic | null = null;

function persist(diagnostic: WebhookDiagnostic): void {
  getSqlite()
    .prepare(
      `INSERT INTO webhook_delivery_log (id, received_at, event_count, result, version, reason)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         received_at = excluded.received_at,
         event_count = excluded.event_count,
         result = excluded.result,
         version = excluded.version,
         reason = excluded.reason`,
    )
    .run(
      diagnostic.receivedAt,
      diagnostic.eventCount,
      diagnostic.result,
      diagnostic.version,
      diagnostic.reason,
    );
}

function load(): WebhookDiagnostic | null {
  const row = getSqlite()
    .prepare(`SELECT received_at, event_count, result, version, reason FROM webhook_delivery_log WHERE id = 1`)
    .get() as
    | { received_at: string; event_count: number; result: string; version: string | null; reason: string }
    | undefined;
  if (!row) return null;
  const result = row.result === "rejected" ? "rejected" : "accepted";
  const version = row.version === "v1" || row.version === "v3" ? row.version : null;
  return {
    receivedAt: row.received_at,
    result,
    version,
    reason: row.reason,
    eventCount: row.event_count,
  };
}

export function recordWebhookDiagnostic(
  diagnostic: Omit<WebhookDiagnostic, "receivedAt" | "eventCount"> & { eventCount?: number },
): WebhookDiagnostic {
  latest = {
    receivedAt: new Date().toISOString(),
    eventCount: diagnostic.eventCount ?? 0,
    result: diagnostic.result,
    version: diagnostic.version,
    reason: diagnostic.reason,
  };
  try {
    persist(latest);
  } catch (error) {
    console.warn(
      `[webhook] could not persist delivery log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return latest;
}

export function getLatestWebhookDiagnostic(): WebhookDiagnostic | null {
  if (latest) return latest;
  try {
    latest = load();
  } catch {
    latest = null;
  }
  return latest;
}

/** Test helper. Does not delete the SQLite row of another database file. */
export function clearWebhookDiagnosticMemory(): void {
  latest = null;
}

/**
 * True when PUBLIC_BASE_URL's host equals the live request host.
 * Null when the variable is unset. Host strings are not returned.
 */
export function publicBaseHostMatches(liveHost: string | undefined): boolean | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim() ?? "";
  if (!raw) return null;
  let configured = "";
  try {
    configured = new URL(raw).host.toLowerCase();
  } catch {
    return false;
  }
  const live = String(liveHost ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase() ?? "";
  if (!configured || !live) return false;
  return configured === live;
}
