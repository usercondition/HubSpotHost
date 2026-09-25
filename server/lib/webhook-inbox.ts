/**
 * Durable HubSpot webhook inbox.
 * The HTTP handler verifies the signature, stores each event, and acks.
 * A worker (or the in-process fallback) recalculates and retries.
 */
import { createHash } from "node:crypto";
import { summarizeEvents } from "./events";
import { isHubspotNotFound } from "./hubspot";
import { getSqlite } from "./order-links";

const MAX_ATTEMPTS = 5;

export interface AcceptedWebhookBatch {
  received: number;
  matched: number;
  lifecycle: number;
  ignoredOutputEvents: number;
  ignoredOther: number;
  deals: number;
  stored: number;
  duplicates: number;
  cacheBust: boolean;
}

interface EventRow {
  event_id: string;
  payload: string;
  attempts: number;
  live_write: number;
}

let chain: Promise<void> = Promise.resolve();

export function webhookEventId(event: Record<string, unknown>): string {
  const raw = event.eventId ?? event.event_id;
  if (typeof raw === "number" && Number.isFinite(raw)) return `hs:${raw}`;
  if (typeof raw === "string" && raw.trim()) return `hs:${raw.trim()}`;
  const stable = JSON.stringify({
    subscriptionType: event.subscriptionType ?? event.subscription_type ?? "",
    objectId: event.objectId ?? event.dealId ?? "",
    propertyName: event.propertyName ?? event.property ?? event.propertyname ?? "",
    propertyValue: event.propertyValue ?? "",
    occurredAt: event.occurredAt ?? event.occurred_at ?? "",
  });
  return `hash:${createHash("sha256").update(stable).digest("hex")}`;
}

function asEvents(payload: unknown): Record<string, unknown>[] {
  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["events", "eventList", "data", "payload"]) {
      if (Array.isArray(obj[key])) {
        list = obj[key] as unknown[];
        break;
      }
    }
    if (list.length === 0) list = [payload];
  }
  return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

/** Persist one row per HubSpot event. Repeats of the same event id are dropped. */
export function acceptWebhookBatch(payload: unknown, liveWrite: boolean): AcceptedWebhookBatch {
  const summary = summarizeEvents(payload);
  const sqlite = getSqlite();
  const insert = sqlite.prepare(
    `INSERT INTO webhook_events (event_id, payload, status, attempts, live_write, received_at)
     VALUES (?, ?, 'pending', 0, ?, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  );
  const now = new Date().toISOString();
  let stored = 0;
  const events = asEvents(payload);
  const write = sqlite.transaction(() => {
    for (const event of events) {
      const result = insert.run(webhookEventId(event), JSON.stringify(event), liveWrite ? 1 : 0, now);
      if (result.changes > 0) stored += 1;
    }
  });
  write();
  return {
    received: summary.received,
    matched: summary.matched,
    lifecycle: summary.lifecycle,
    ignoredOutputEvents: summary.ignoredOutputEvents,
    ignoredOther: summary.ignoredOther,
    deals: summary.dealIds.length,
    stored,
    duplicates: Math.max(0, events.length - stored),
    cacheBust: summary.cacheBust,
  };
}

function markDone(eventId: string): void {
  getSqlite()
    .prepare(`UPDATE webhook_events SET status = 'done', processed_at = ?, last_error = NULL WHERE event_id = ?`)
    .run(new Date().toISOString(), eventId);
}

/** A missing deal is finished. The reason stays on the row and it is never retried. */
function markDropped(eventId: string, reason: string): void {
  getSqlite()
    .prepare(
      `UPDATE webhook_events
       SET status = 'dropped', last_error = ?, processed_at = ?, not_before = NULL
       WHERE event_id = ?`,
    )
    .run(reason.slice(0, 500), new Date().toISOString(), eventId);
}

function markRetry(eventId: string, attempts: number, message: string, retryAfterMs: number | null, retryable: boolean): void {
  const failed = !retryable || attempts >= MAX_ATTEMPTS;
  const notBefore = failed ? null : new Date(Date.now() + (retryAfterMs ?? Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 15 * 60 * 1000))).toISOString();
  getSqlite()
    .prepare(
      `UPDATE webhook_events
       SET status = ?, attempts = ?, last_error = ?, not_before = ?, processed_at = NULL
       WHERE event_id = ?`,
    )
    .run(failed ? "failed" : "pending", attempts, message.slice(0, 500), notBefore, eventId);
}

export async function processWebhookInbox(now = new Date()): Promise<{ processed: number; failed: number }> {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(
      `SELECT event_id, payload, attempts, live_write FROM webhook_events
       WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?)
       ORDER BY received_at`,
    )
    .all(now.toISOString()) as EventRow[];
  if (rows.length === 0) return { processed: 0, failed: 0 };

  const { recalculateDeal } = await import("./service");
  const { invalidatePrintOrderDealsCache } = await import("./hubspot");
  const { HubSpotError } = await import("./hubspot");

  let cacheBust = false;
  const bustIds: string[] = [];
  const recalc = new Map<string, EventRow[]>();
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    let event: Record<string, unknown> = {};
    try {
      event = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      markDone(row.event_id);
      processed += 1;
      continue;
    }
    const summary = summarizeEvents([event]);
    if (summary.cacheBust) {
      cacheBust = true;
      if (summary.dealIds.length === 0) {
        bustIds.push(row.event_id);
        continue;
      }
    }
    const dealId = summary.dealIds[0];
    if (!dealId) {
      markDone(row.event_id);
      processed += 1;
      continue;
    }
    const group = recalc.get(dealId) ?? [];
    group.push(row);
    recalc.set(dealId, group);
  }

  if (cacheBust) {
    invalidatePrintOrderDealsCache();
    const { enqueueSyncHealthSoon } = await import("./print-ops-jobs");
    enqueueSyncHealthSoon();
    for (const eventId of bustIds) {
      markDone(eventId);
      processed += 1;
    }
  }

  for (const [dealId, group] of Array.from(recalc.entries())) {
    const liveWrite = group.some((row) => row.live_write === 1);
    try {
      const outcome = await recalculateDeal({
        dealId,
        origin: "webhook",
        requestWantsLiveWrite: liveWrite,
      });
      if (outcome.status === "error") {
        const message = outcome.error || "Recalculation failed";
        if (isHubspotNotFound(message)) {
          for (const row of group) markDropped(row.event_id, message);
          continue;
        }
        const retryAfterMs = outcome.retryAfterMs ?? null;
        const retryable = outcome.retryable !== false;
        for (const row of group) {
          markRetry(row.event_id, row.attempts + 1, message, retryAfterMs, retryable);
          if (!retryable || row.attempts + 1 >= MAX_ATTEMPTS) failed += 1;
        }
        continue;
      }
      for (const row of group) markDone(row.event_id);
      processed += group.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook processing failed";
      const status = error instanceof HubSpotError ? error.status : undefined;
      if (isHubspotNotFound(message, status)) {
        for (const row of group) markDropped(row.event_id, message);
        continue;
      }
      const retryAfterMs = error instanceof HubSpotError ? error.retryAfterMs : null;
      const retryable = !(error instanceof HubSpotError) || error.status >= 500 || error.status === 429;
      for (const row of group) {
        markRetry(row.event_id, row.attempts + 1, message, retryAfterMs, retryable);
        if (!retryable || row.attempts + 1 >= MAX_ATTEMPTS) failed += 1;
      }
    }
  }

  return { processed, failed };
}

/** Ack path. Does not wait for HubSpot. Repeats share one in-flight pass. */
export function scheduleWebhookProcessing(): void {
  chain = chain
    .then(async () => {
      const { enqueueWebhookInboxJob } = await import("./print-ops-jobs");
      await enqueueWebhookInboxJob();
    })
    .catch((error) => {
      console.warn(`[webhook] inbox processing failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

export function webhookProcessingSettled(): Promise<void> {
  return chain;
}

export function listFailedWebhookEvents(): Array<{ eventId: string; dealId: string | null; lastError: string | null }> {
  const rows = getSqlite()
    .prepare(`SELECT event_id, payload, last_error FROM webhook_events WHERE status = 'failed' ORDER BY received_at`)
    .all() as Array<{ event_id: string; payload: string; last_error: string | null }>;
  return rows.map((row) => {
    let dealId: string | null = null;
    try {
      const summary = summarizeEvents([JSON.parse(row.payload)]);
      dealId = summary.dealIds[0] ?? null;
    } catch {
      dealId = null;
    }
    return { eventId: row.event_id, dealId, lastError: row.last_error };
  });
}

export function failedWebhookCount(): number {
  const row = getSqlite().prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'failed'`).get() as { n: number };
  return row.n;
}

/** Turn already-failed 404 deliveries into dropped rows before a retry pass. */
export function dropNotFoundWebhookEvents(): number {
  const rows = getSqlite()
    .prepare(`SELECT event_id, last_error FROM webhook_events WHERE status IN ('failed', 'pending')`)
    .all() as Array<{ event_id: string; last_error: string | null }>;
  let dropped = 0;
  for (const row of rows) {
    if (!isHubspotNotFound(row.last_error)) continue;
    markDropped(row.event_id, row.last_error || "HubSpot API 404: deal not found");
    dropped += 1;
  }
  return dropped;
}

export function reopenFailedWebhookEvents(): void {
  getSqlite()
    .prepare(
      `UPDATE webhook_events
       SET status = 'pending', attempts = 0, not_before = NULL
       WHERE status = 'failed'
         AND IFNULL(last_error, '') NOT LIKE '%404%'
         AND lower(IFNULL(last_error, '')) NOT LIKE '%deal not found%'
         AND lower(IFNULL(last_error, '')) NOT LIKE '%resource not found%'`,
    )
    .run();
}
