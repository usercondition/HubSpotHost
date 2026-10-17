/**
 * GET /api/nerve/* — read-only proxy to the Nerve v3 server on the Mac mini.
 *
 * Auth: the normal Print Ops owner code (header x-paid-order-access-code), checked against
 * PAID_ORDER_INTAKE_ACCESS_CODE_HASH like every other owner route. The Nerve key lives only in the
 * server env (NERVE_KEY) and is added here as x-nerve-key; the browser never sees or stores it.
 * Upstream: NERVE_API_BASE (server env). Only an allowlist of GET paths is forwarded.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";

export const NERVE_PROXY_PATHS = new Set(["/api/v3", "/api/messages", "/api/messages/thread"]);
const ALLOWED_QUERY = new Set(["uid", "limit", "before"]);

type Env = NodeJS.ProcessEnv;
type FetchLike = (url: string, init: RequestInit) => Promise<globalThis.Response>;

function sha256(v: string) {
  return crypto.createHash("sha256").update(v, "utf8").digest();
}

export function ownerAuthorized(req: Request, env: Env = process.env): "ok" | "not-configured" | "denied" {
  const expected = env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim().toLowerCase() || "";
  if (!expected) return "not-configured";
  const provided = (req.get("x-paid-order-access-code") ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!provided) return "denied";
  const a = Buffer.from(sha256(provided).toString("hex"), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "denied";
}

export function registerNerveProxyRoutes(app: Express, deps: { env?: Env; fetch?: FetchLike } = {}) {
  const env = deps.env ?? process.env;
  const doFetch: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));

  app.get(/^\/api\/nerve(\/.*)$/, async (req: Request, res: Response) => {
    res.set("cache-control", "no-store");
    const auth = ownerAuthorized(req, env);
    if (auth !== "ok") {
      return res.status(auth === "not-configured" ? 503 : 401).json({ ok: false, error: "Owner code required" });
    }
    const path = (req.params as Record<string, string>)[0] ?? "";
    if (!NERVE_PROXY_PATHS.has(path)) return res.status(404).json({ ok: false, error: "Not a Nerve read path" });
    const key = env.NERVE_KEY?.trim() || "";
    const base = (env.NERVE_API_BASE?.trim() || "").replace(/\/+$/, "");
    if (!key || !base) return res.status(503).json({ ok: false, error: "Nerve is not configured on the server" });

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (ALLOWED_QUERY.has(k) && typeof v === "string") qs.set(k, v.slice(0, 200));
    }
    let upstream: globalThis.Response;
    try {
      upstream = await doFetch(`${base}${path}${qs.size ? `?${qs}` : ""}`, {
        method: "GET",
        headers: { "x-nerve-key": key, accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      return res.status(502).json({ ok: false, error: "Nerve is unreachable from the server" });
    }
    // Never let an upstream 401 look like a Print Ops auth failure (that would lock the owner session).
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(502).json({ ok: false, error: "Nerve rejected the server's key" });
    }
    if (!upstream.ok) return res.status(502).json({ ok: false, error: `Nerve answered ${upstream.status}` });
    res.type("application/json").send(await upstream.text());
  });
}
