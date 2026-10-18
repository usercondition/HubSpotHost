import type { Express, Request, Response } from "express";
import { checkMarket } from "./market-comps";
import { getStlQuoteSettings, resetStlQuoteSettings, saveStlQuoteSettings } from "./stl-quote-store";

type RejectOwner = (req: Request, res: Response) => boolean;

/** STL Quote: owner-only settings + market check. Mesh math runs in the browser. */
export function registerStlQuoteRoutes(app: Express, rejectOwner: RejectOwner, deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
  app.get("/api/stl-quote/settings", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({ ok: true, ...getStlQuoteSettings() });
  });
  app.put("/api/stl-quote/settings", (req, res) => {
    if (rejectOwner(req, res)) return;
    if (!req.body || typeof req.body !== "object") return res.status(400).json({ ok: false, error: "Send settings as JSON" });
    return res.json({ ok: true, ...saveStlQuoteSettings(req.body.settings ?? req.body) });
  });
  app.delete("/api/stl-quote/settings", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({ ok: true, ...resetStlQuoteSettings() });
  });
  app.post("/api/stl-quote/market", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (query.length < 2) return res.status(400).json({ ok: false, error: "Enter a search term" });
    try {
      const result = await checkMarket(query, deps.env ?? process.env, deps.fetch ?? fetch);
      res.setHeader("Cache-Control", "no-store");
      return res.json(result);
    } catch (error) {
      return res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "Market check failed" });
    }
  });
}
