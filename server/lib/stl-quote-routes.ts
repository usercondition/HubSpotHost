import type { Express, Request, Response } from "express";
import { checkMarket } from "./market-comps";
import { interpretNotesWithAi, notesAiConfig } from "./quote-notes-ai";
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
  // Optional AI read of client notes the deterministic parser left unparsed.
  app.get("/api/stl-quote/notes-ai", (req, res) => {
    if (rejectOwner(req, res)) return;
    const cfg = notesAiConfig(deps.env ?? process.env);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, available: !!cfg, model: cfg?.model ?? null });
  });
  app.post("/api/stl-quote/notes-ai", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 4000) : "";
    const unparsed = Array.isArray(req.body?.unparsed) ? req.body.unparsed.filter((u: unknown) => typeof u === "string") : [];
    if (!notes.trim() || unparsed.length === 0) return res.status(400).json({ ok: false, error: "Nothing to read" });
    const result = await interpretNotesWithAi(notes, unparsed, deps.env ?? process.env, deps.fetch ?? fetch);
    res.setHeader("Cache-Control", "no-store");
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json(result);
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
