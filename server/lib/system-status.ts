/**
 * Status tiles for systems Print Ops cannot poll itself.
 * Watchdogs POST a JSON report. Missing reports stay "no data yet".
 */
import { timingSafeEqual } from "node:crypto";
import { SYSTEM_CATALOG, SYSTEM_STATUS_IDS, type SystemStatusId } from "../../shared/system-catalog";
import { getSqlite } from "./order-links";

export { SYSTEM_CATALOG, SYSTEM_STATUS_IDS };
export type { SystemStatusId };
export type SystemTone = "green" | "amber" | "red" | "unknown";

const ID_SET = new Set<string>(SYSTEM_STATUS_IDS);
const TONES = new Set(["green", "amber", "red", "yellow"]);

export interface StoredSystemReport {
  id: SystemStatusId;
  status: Exclude<SystemTone, "unknown">;
  summary: string;
  checkedAt: string;
  metrics: Record<string, unknown>;
}

export interface SystemTile {
  id: SystemStatusId;
  label: string;
  status: SystemTone;
  summary: string;
  checkedAt: string | null;
  source: "live" | "ingest" | "none";
}

export interface LiveSystemSignals {
  now?: Date;
  sync?: { status: "ok" | "warn" | "error"; lastCheckedAt: string | null } | null;
  webhook?: { configured: boolean; lastDeliveryAt: string | null } | null;
  shipengine?: { configured: boolean } | null;
  tracking?: { count: number; stuck: number; lastEventAt: string | null } | null;
}

const NO_DATA = "No data yet";
const SUMMARY_MAX = 240;

export function statusIngestToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYSTEM_STATUS_INGEST_TOKEN?.trim() || "";
}

export function statusIngestAuthorized(supplied: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = statusIngestToken(env);
  if (!expected || !supplied) return false;
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseStatusIngest(body: unknown): { ok: true; systems: StoredSystemReport[] } | { ok: false; error: string } {
  const root = asRecord(body);
  const rows = root && Array.isArray(root.systems) ? root.systems : null;
  if (!rows) return { ok: false, error: "Body must be { systems: [...] }." };
  if (rows.length === 0) return { ok: false, error: "systems must include at least one report." };
  if (rows.length > SYSTEM_STATUS_IDS.length) return { ok: false, error: "Too many system reports." };
  const fallbackCheckedAt = iso(root?.checkedAt);
  const systems: StoredSystemReport[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) return { ok: false, error: "Each system report must be an object." };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!ID_SET.has(id)) return { ok: false, error: `Unknown system id "${id}".` };
    const catalog = SYSTEM_CATALOG[id as SystemStatusId];
    if (catalog.polled) return { ok: false, error: `${catalog.label} is polled by Print Ops. Do not push it.` };
    if (seen.has(id)) return { ok: false, error: `Duplicate system id "${id}".` };
    seen.add(id);
    const rawStatus = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
    if (!TONES.has(rawStatus)) return { ok: false, error: `Status for ${id} must be green, amber, or red.` };
    const status = rawStatus === "yellow" ? "amber" : (rawStatus as StoredSystemReport["status"]);
    const checkedAt = iso(record.checkedAt) || fallbackCheckedAt;
    if (!checkedAt) return { ok: false, error: `checkedAt for ${id} must be an ISO time.` };
    const summary = typeof record.summary === "string" ? record.summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX) : "";
    if (!summary) return { ok: false, error: `summary for ${id} is required.` };
    const metrics = asRecord(record.metrics) ?? {};
    systems.push({ id: id as SystemStatusId, status, summary, checkedAt, metrics });
  }
  return { ok: true, systems };
}

function ensureTable(): void {
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS system_status_reports (
      system_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

export function saveSystemReports(systems: StoredSystemReport[], now = new Date()): void {
  ensureTable();
  const statement = getSqlite().prepare(
    `INSERT INTO system_status_reports (system_id, status, summary, checked_at, metrics_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(system_id) DO UPDATE SET
       status = excluded.status,
       summary = excluded.summary,
       checked_at = excluded.checked_at,
       metrics_json = excluded.metrics_json,
       updated_at = excluded.updated_at`,
  );
  const updatedAt = now.toISOString();
  const write = getSqlite().transaction((rows: StoredSystemReport[]) => {
    for (const row of rows) {
      statement.run(row.id, row.status, row.summary, row.checkedAt, JSON.stringify(row.metrics), updatedAt);
    }
  });
  write(systems);
}

export function listStoredSystemReports(): StoredSystemReport[] {
  ensureTable();
  const rows = getSqlite().prepare(
    `SELECT system_id, status, summary, checked_at, metrics_json FROM system_status_reports`,
  ).all() as Array<{ system_id: string; status: string; summary: string; checked_at: string; metrics_json: string }>;
  return rows.flatMap((row) => {
    if (!ID_SET.has(row.system_id)) return [];
    const status = row.status === "green" || row.status === "amber" || row.status === "red" ? row.status : null;
    if (!status) return [];
    let metrics: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metrics_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metrics = parsed as Record<string, unknown>;
    } catch {
      metrics = {};
    }
    return [{ id: row.system_id as SystemStatusId, status, summary: row.summary, checkedAt: row.checked_at, metrics }];
  });
}

function noneTile(id: SystemStatusId): SystemTile {
  return { id, label: SYSTEM_CATALOG[id].label, status: "unknown", summary: NO_DATA, checkedAt: null, source: "none" };
}

function webhookFresh(lastDeliveryAt: string | null, now: Date): boolean {
  if (!lastDeliveryAt) return false;
  const age = now.getTime() - new Date(lastDeliveryAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 24 * 60 * 60 * 1000;
}

export function buildSystemTiles(stored: StoredSystemReport[], live: LiveSystemSignals = {}): SystemTile[] {
  const now = live.now ?? new Date();
  const byId = new Map(stored.map((row) => [row.id, row]));
  return SYSTEM_STATUS_IDS.map((id) => {
    if (id === "hubspot-sync") {
      if (!live.sync) return noneTile(id);
      const status = live.sync.status === "ok" ? "green" : live.sync.status === "warn" ? "amber" : "red";
      return {
        id,
        label: SYSTEM_CATALOG[id].label,
        status,
        summary: live.sync.status === "ok" ? "HubSpot and Print Ops agree" : "Sync health needs a look",
        checkedAt: live.sync.lastCheckedAt,
        source: "live",
      };
    }
    if (id === "hubspot-webhook") {
      if (!live.webhook) return noneTile(id);
      if (!live.webhook.configured) {
        return { id, label: SYSTEM_CATALOG[id].label, status: "red", summary: "Webhook secret is not configured", checkedAt: live.webhook.lastDeliveryAt, source: "live" };
      }
      const fresh = webhookFresh(live.webhook.lastDeliveryAt, now);
      return {
        id,
        label: SYSTEM_CATALOG[id].label,
        status: fresh ? "green" : "amber",
        summary: live.webhook.lastDeliveryAt
          ? fresh
            ? "Deliveries are arriving"
            : "Last delivery is more than a day old"
          : "No delivery recorded",
        checkedAt: live.webhook.lastDeliveryAt,
        source: "live",
      };
    }
    if (id === "shipengine") {
      if (!live.shipengine) return noneTile(id);
      return {
        id,
        label: SYSTEM_CATALOG[id].label,
        status: live.shipengine.configured ? "green" : "red",
        summary: live.shipengine.configured ? "ShipEngine is configured" : "ShipEngine is not configured",
        checkedAt: now.toISOString(),
        source: "live",
      };
    }
    if (id === "shipment-tracking") {
      if (!live.tracking) return noneTile(id);
      if (live.tracking.count === 0) return noneTile(id);
      const status = live.tracking.stuck > 0 ? "amber" : "green";
      return {
        id,
        label: SYSTEM_CATALOG[id].label,
        status,
        summary: live.tracking.stuck > 0 ? `${live.tracking.stuck} stuck` : `${live.tracking.count} shipments`,
        checkedAt: live.tracking.lastEventAt,
        source: "live",
      };
    }
    const report = byId.get(id);
    if (!report) return noneTile(id);
    return {
      id,
      label: SYSTEM_CATALOG[id].label,
      status: report.status,
      summary: report.summary,
      checkedAt: report.checkedAt,
      source: "ingest",
    };
  });
}
