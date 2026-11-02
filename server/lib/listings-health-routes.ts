import fs from "node:fs";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getSqlite } from "./order-links";

const itemSchema = z.object({ id: z.string().min(1), storefront: z.enum(["ebay", "etsy", "offerup"]), title: z.string(), kind: z.enum(["health", "pricing"]), reason: z.string(), proposedPrice: z.number().nonnegative().nullable().optional() });
export type ListingsHealthItem = z.infer<typeof itemSchema>;
export function parseListingsHealth(raw: string): ListingsHealthItem[] { return z.array(itemSchema).parse(JSON.parse(raw)); }
function ensure() { getSqlite().exec("CREATE TABLE IF NOT EXISTS listings_health_decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL, decided_at TEXT NOT NULL)"); }
export function registerListingsHealthRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/listings-health", (req, res) => {
    if (rejectOwner(req, res)) return;
    const file = process.env.LISTINGS_HEALTH_FILE?.trim();
    if (!file) return res.json({ ok: true, pending: true, items: [] });
    try { return res.json({ ok: true, pending: false, items: parseListingsHealth(fs.readFileSync(file, "utf8")) }); } catch { return res.status(502).json({ ok: false, error: "Could not read listings health feed." }); }
  });
  app.post("/api/listings-health/:id/decision", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const decision = req.body?.decision === "approved" || req.body?.decision === "dismissed" ? req.body.decision : null;
    if (!decision) return res.status(400).json({ ok: false, error: "Choose approve or dismiss." });
    ensure(); getSqlite().prepare("INSERT INTO listings_health_decisions (id, decision, decided_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at").run(req.params.id, decision, new Date().toISOString());
    return res.json({ ok: true, decision, applied: false });
  });
}
