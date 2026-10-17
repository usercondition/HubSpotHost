/**
 * GET /api/nerve/session-key — hands the Nerve v3 key to an already-unlocked Print Ops session.
 *
 * Option B: the browser still calls Nerve on the Mac mini directly over Tailscale (private, never
 * exposed to the internet); this endpoint just removes the separate "Nerve key" prompt.
 * Auth: the normal Print Ops owner code (x-paid-order-access-code), checked against
 * PAID_ORDER_INTAKE_ACCESS_CODE_HASH. 401 on a bad/missing code, 503 when NERVE_KEY is unset.
 * Always Cache-Control: no-store. The key is never logged.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";

type Env = NodeJS.ProcessEnv;

export function ownerAuthorized(req: Request, env: Env = process.env): "ok" | "not-configured" | "denied" {
  const expected = env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim().toLowerCase() || "";
  if (!expected) return "not-configured";
  const provided = (req.get("x-paid-order-access-code") ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!provided) return "denied";
  const a = Buffer.from(crypto.createHash("sha256").update(provided, "utf8").digest("hex"), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "denied";
}

export function registerNerveSessionKeyRoute(app: Express, deps: { env?: Env } = {}) {
  const env = deps.env ?? process.env;
  app.get("/api/nerve/session-key", (req: Request, res: Response) => {
    res.set("cache-control", "no-store");
    res.set("pragma", "no-cache");
    const auth = ownerAuthorized(req, env);
    if (auth !== "ok") {
      return res.status(auth === "not-configured" ? 503 : 401).json({ ok: false, error: "Owner code required" });
    }
    const key = env.NERVE_KEY?.trim() || "";
    if (!key) return res.status(503).json({ ok: false, error: "Nerve is not configured on the server" });
    res.json({ ok: true, key });
  });
}
