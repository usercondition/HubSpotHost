import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getSqlite } from "./order-links";

const heartbeatSchema = z.object({ service: z.string().min(1), status: z.enum(["green", "yellow", "red"]), metrics: z.record(z.string(), z.unknown()), timestamp: z.string().datetime() });
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export function normalizeHeartbeat(value: unknown): Heartbeat { return heartbeatSchema.parse(value); }
function loadHeartbeats(dir: string): Heartbeat[] { if (!dir || !fs.existsSync(dir)) return []; return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => { try { return [normalizeHeartbeat(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))]; } catch { return []; } }); }
function ensure() { getSqlite().exec("CREATE TABLE IF NOT EXISTS system_action_requests (id INTEGER PRIMARY KEY, service TEXT NOT NULL, action TEXT NOT NULL, requested_at TEXT NOT NULL)"); }
export function registerSystemsRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/systems", (req, res) => { if (rejectOwner(req, res)) return; return res.json({ ok: true, pending: !process.env.SYSTEM_HEARTBEATS_DIR, heartbeats: loadHeartbeats(process.env.SYSTEM_HEARTBEATS_DIR?.trim() ?? "") }); });
  app.post("/api/systems/:service/actions", (req: Request, res: Response) => { if (rejectOwner(req, res)) return; const action = req.body?.action === "wake" || req.body?.action === "restart" ? req.body.action : null; if (!action) return res.status(400).json({ ok: false, error: "Choose wake or restart." }); ensure(); getSqlite().prepare("INSERT INTO system_action_requests (service, action, requested_at) VALUES (?, ?, ?)").run(req.params.service, action, new Date().toISOString()); return res.json({ ok: true, executed: false, message: "Request recorded; no system command was run." }); });
}
