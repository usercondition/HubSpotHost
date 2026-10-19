/**
 * GET /api/nerve/session-key — hands the Nerve v3 key to an already-unlocked Print Ops session.
 *
 * Option B: the browser still calls Nerve on the Mac mini directly over Tailscale (private, never
 * exposed to the internet); this endpoint just removes the separate "Nerve key" prompt.
 * Auth: the normal Print Ops owner code (x-paid-order-access-code), checked against
 * PAID_ORDER_INTAKE_ACCESS_CODE_HASH (or the optional _NORM_HASH) via lib/owner-code. 401 on a bad/missing code, 503 when NERVE_KEY is unset.
 * Always Cache-Control: no-store. The key is never logged.
 */
import type { Express, Request, Response } from "express";
import { verifyOwnerCode } from "./owner-code";

type Env = NodeJS.ProcessEnv;

export function ownerAuthorized(req: Request, env: Env = process.env): "ok" | "not-configured" | "denied" {
  const status = verifyOwnerCode(req.get("x-paid-order-access-code") ?? "", env);
  return status === "authorized" ? "ok" : status === "not-configured" ? "not-configured" : "denied";
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
