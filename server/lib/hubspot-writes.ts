/**
 * Outbound HubSpot writes survive a timeout or a 429.
 * The pending row is what Print Ops shows until the PATCH succeeds.
 * Automatic repairs stay blank-only at their own call sites.
 */
import type { HubSpotDealRecord } from "./hubspot";
import { getSqlite } from "./order-links";

const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface HubspotWriteResult {
  wrote: boolean;
  pending: boolean;
  error?: string;
}

interface WriteRow {
  deal_id: string;
  fields_json: string;
  status: string;
  attempts: number;
  retryable: number;
  last_error: string | null;
  not_before: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function backoffMs(attempts: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null && retryAfterMs >= 0) return retryAfterMs;
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 15 * 60 * 1000);
}

export function mergePendingHubspotWrite(dealId: string, properties: Record<string, string>): void {
  const sqlite = getSqlite();
  const existing = sqlite.prepare(`SELECT fields_json FROM pending_hubspot_writes WHERE deal_id = ?`).get(dealId) as
    | { fields_json: string }
    | undefined;
  const merged: Record<string, string> = existing ? { ...JSON.parse(existing.fields_json) } : {};
  Object.assign(merged, properties);
  const now = nowIso();
  sqlite
    .prepare(
      `INSERT INTO pending_hubspot_writes (deal_id, fields_json, status, attempts, retryable, last_error, not_before, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, 1, NULL, NULL, ?, ?)
       ON CONFLICT(deal_id) DO UPDATE SET
         fields_json = excluded.fields_json,
         status = 'pending',
         attempts = 0,
         retryable = 1,
         last_error = NULL,
         not_before = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(dealId, JSON.stringify(merged), now, now);
}

export async function submitHubspotWrite(dealId: string, properties: Record<string, string>): Promise<HubspotWriteResult> {
  if (Object.keys(properties).length === 0) return { wrote: false, pending: false, error: "Nothing to write." };
  mergePendingHubspotWrite(dealId, properties);
  const outcome = await attemptDealWrite(dealId, new Date());
  if (!outcome.wrote && outcome.pending) {
    const { enqueueHubspotWriteJob } = await import("./print-ops-jobs");
    enqueueHubspotWriteJob(outcome.retryAfterMs ?? null);
  }
  return outcome;
}

async function attemptDealWrite(dealId: string, now: Date): Promise<HubspotWriteResult & { retryAfterMs?: number | null }> {
  const sqlite = getSqlite();
  const row = sqlite.prepare(`SELECT * FROM pending_hubspot_writes WHERE deal_id = ?`).get(dealId) as WriteRow | undefined;
  if (!row) return { wrote: true, pending: false };
  if (row.not_before && row.not_before > now.toISOString()) {
    return { wrote: false, pending: true };
  }
  const properties = JSON.parse(row.fields_json) as Record<string, string>;
  const { hubspotRequest, invalidatePrintOrderDealsCache, HubSpotError } = await import("./hubspot");
  try {
    await hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    sqlite.prepare(`DELETE FROM pending_hubspot_writes WHERE deal_id = ?`).run(dealId);
    invalidatePrintOrderDealsCache();
    return { wrote: true, pending: false };
  } catch (error) {
    const retryable = error instanceof HubSpotError ? RETRYABLE.has(error.status) : true;
    const attempts = row.attempts + 1;
    const message = error instanceof Error ? error.message : "HubSpot write failed";
    const retryAfterMs = error instanceof HubSpotError ? error.retryAfterMs : null;
    const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
    sqlite
      .prepare(
        `UPDATE pending_hubspot_writes
         SET status = ?, attempts = ?, retryable = ?, last_error = ?, not_before = ?, updated_at = ?
         WHERE deal_id = ?`,
      )
      .run(
        giveUp ? "failed" : "pending",
        attempts,
        retryable ? 1 : 0,
        message.slice(0, 500),
        giveUp ? null : new Date(Date.now() + backoffMs(attempts, retryAfterMs)).toISOString(),
        nowIso(),
        dealId,
      );
    return {
      wrote: false,
      pending: !giveUp,
      error: message,
      retryAfterMs,
    };
  }
}

export async function processPendingHubspotWrites(now = new Date()): Promise<{ wrote: number; pending: number; failed: number }> {
  const rows = getSqlite()
    .prepare(`SELECT deal_id FROM pending_hubspot_writes WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?)`)
    .all(now.toISOString()) as Array<{ deal_id: string }>;
  let wrote = 0;
  let pending = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await attemptDealWrite(row.deal_id, now);
    if (outcome.wrote) wrote += 1;
    else if (outcome.pending) pending += 1;
    else failed += 1;
  }
  return { wrote, pending, failed };
}

export function overlayPendingHubspotWrites(deals: HubSpotDealRecord[]): HubSpotDealRecord[] {
  const rows = getSqlite()
    .prepare(`SELECT deal_id, fields_json FROM pending_hubspot_writes WHERE status IN ('pending', 'failed')`)
    .all() as Array<{ deal_id: string; fields_json: string }>;
  if (rows.length === 0) return deals;
  const byDeal = new Map<string, Record<string, string>>();
  for (const row of rows) {
    try {
      byDeal.set(row.deal_id, JSON.parse(row.fields_json) as Record<string, string>);
    } catch {
      continue;
    }
  }
  return deals.map((deal) => {
    const extra = byDeal.get(deal.id);
    if (!extra) return deal;
    return { ...deal, properties: { ...deal.properties, ...extra } };
  });
}

export function hubspotWriteCounts(): { pending: number; failed: number } {
  const rows = getSqlite()
    .prepare(`SELECT status, COUNT(*) AS n FROM pending_hubspot_writes GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const counts = { pending: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === "pending") counts.pending = row.n;
    if (row.status === "failed") counts.failed = row.n;
  }
  return counts;
}

export function listFailedHubspotWrites(): Array<{ dealId: string; lastError: string | null }> {
  return (
    getSqlite()
      .prepare(`SELECT deal_id, last_error FROM pending_hubspot_writes WHERE status = 'failed' ORDER BY updated_at`)
      .all() as Array<{ deal_id: string; last_error: string | null }>
  ).map((row) => ({ dealId: row.deal_id, lastError: row.last_error }));
}

export function reopenFailedHubspotWrites(): void {
  getSqlite()
    .prepare(
      `UPDATE pending_hubspot_writes
       SET status = 'pending', attempts = 0, not_before = NULL, updated_at = ?
       WHERE status = 'failed' AND retryable = 1`,
    )
    .run(nowIso());
}
