import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getConfig } from "./config";
import { getSqlite } from "./order-links";
import { getShipEngineStatus } from "./shipengine";
import { listShipstationShipments } from "./shipstation";
import { getCachedSyncHealth } from "./sync-health";
import {
  buildSystemTiles,
  listStoredSystemReports,
  parseStatusIngest,
  saveSystemReports,
  statusIngestAuthorized,
  statusIngestToken,
} from "./system-status";
import { getLatestWebhookDiagnostic } from "./webhook-diagnostics";

const heartbeatSchema = z.object({ service: z.string().min(1), status: z.enum(["green", "yellow", "red"]), metrics: z.record(z.string(), z.unknown()), timestamp: z.string().datetime() });
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export function normalizeHeartbeat(value: unknown): Heartbeat { return heartbeatSchema.parse(value); }
export function readSystemHeartbeats(dir: string | undefined): { pending: boolean; heartbeats: Heartbeat[] } {
  const cleaned = dir?.trim() ?? "";
  if (!cleaned || !fs.existsSync(cleaned) || !fs.statSync(cleaned).isDirectory()) return { pending: true, heartbeats: [] };
  const heartbeats = fs.readdirSync(cleaned).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try { return [normalizeHeartbeat(JSON.parse(fs.readFileSync(path.join(cleaned, name), "utf8")))]; } catch { return []; }
  });
  return { pending: heartbeats.length === 0, heartbeats };
}
function ensure() { getSqlite().exec("CREATE TABLE IF NOT EXISTS system_action_requests (id INTEGER PRIMARY KEY, service TEXT NOT NULL, action TEXT NOT NULL, requested_at TEXT NOT NULL)"); }
function suppliedStatusToken(req: Request): string {
  const header = req.get("x-print-ops-status-token")?.trim() || "";
  if (header) return header;
  const authorization = req.get("authorization")?.trim() || "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? "";
}

export function registerSystemsRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/systems", (req, res) => { if (rejectOwner(req, res)) return; return res.json({ ok: true, ...readSystemHeartbeats(process.env.SYSTEM_HEARTBEATS_DIR) }); });
  app.get("/api/systems/status", (req, res) => {
    if (rejectOwner(req, res)) return;
    const sync = getCachedSyncHealth();
    const webhook = getLatestWebhookDiagnostic();
    const shipments = listShipstationShipments().filter((row) => !row.voided);
    const stuck = shipments.filter((row) => row.stale || row.status === "exception").length;
    const lastEventAt = shipments.find((row) => row.lastEventAt)?.lastEventAt ?? shipments[0]?.shipDate ?? null;
    return res.json({
      ok: true,
      tiles: buildSystemTiles(listStoredSystemReports(), {
        sync: sync ? { status: sync.summary.status, lastCheckedAt: sync.summary.lastCheckedAt } : null,
        webhook: { configured: getConfig().webhookSecretConfigured, lastDeliveryAt: webhook?.receivedAt ?? null },
        shipengine: { configured: getShipEngineStatus().configured },
        tracking: { count: shipments.length, stuck, lastEventAt },
      }),
    });
  });
  app.post("/api/systems/status", (req, res) => {
    if (!statusIngestToken()) {
      return res.status(503).json({ ok: false, error: "Status ingest token is not configured" });
    }
    if (!statusIngestAuthorized(suppliedStatusToken(req))) {
      return res.status(401).json({ ok: false, error: "Invalid status ingest token" });
    }
    const parsed = parseStatusIngest(req.body);
    if (!parsed.ok) return res.status(400).json(parsed);
    saveSystemReports(parsed.systems);
    return res.json({ ok: true, stored: parsed.systems.length });
  });
  app.post("/api/systems/:service/actions", (req: Request, res: Response) => { if (rejectOwner(req, res)) return; const action = req.body?.action === "wake" || req.body?.action === "restart" ? req.body.action : null; if (!action) return res.status(400).json({ ok: false, error: "Choose wake or restart." }); ensure(); getSqlite().prepare("INSERT INTO system_action_requests (service, action, requested_at) VALUES (?, ?, ?)").run(req.params.service, action, new Date().toISOString()); return res.json({ ok: true, executed: false, message: "Request recorded; no system command was run." }); });
}
