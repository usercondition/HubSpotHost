import type { Express, Request, Response } from "express";
import { assignPrinterProfileSchema, assignPrintFilePrinterSchema, createPrinterLifecycleEventSchema, updatePrinterSchema } from "../../shared/schema";
import { addPrinterLifecycleEvent, assignPrintFilePrinter, assignPrinterProfile, buildPrinterFleetSnapshot, ensureDefaultPrinters, getPrinter, updatePrinter } from "./printers";

const firstIssue = (error: { issues: Array<{ message: string }> }) => error.issues[0]?.message ?? "Invalid request";

export function registerPrinterRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/printers", (req, res) => {
    if (rejectOwner(req, res)) return;
    try { ensureDefaultPrinters(); return res.json({ ok: true, ...buildPrinterFleetSnapshot() }); }
    catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Could not load printer fleet" }); }
  });
  app.patch("/api/printers/:id", (req, res) => {
    if (rejectOwner(req, res)) return;
    const id = Number(req.params.id); const parsed = updatePrinterSchema.safeParse(req.body ?? {});
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const printer = updatePrinter(id, parsed.data); return printer ? res.json({ ok: true, printer, fleet: buildPrinterFleetSnapshot() }) : res.status(404).json({ ok: false, error: "That printer was not found" });
  });
  app.post("/api/printers/:id/events", (req, res) => {
    if (rejectOwner(req, res)) return;
    const id = Number(req.params.id); const parsed = createPrinterLifecycleEventSchema.safeParse(req.body ?? {});
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    if (!getPrinter(id)) return res.status(404).json({ ok: false, error: "That printer was not found" });
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const event = addPrinterLifecycleEvent(id, parsed.data); return event ? res.status(201).json({ ok: true, event, fleet: buildPrinterFleetSnapshot() }) : res.status(404).json({ ok: false, error: "That printer was not found" });
  });
  app.post("/api/printers/assign-profile", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = assignPrinterProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const result = assignPrinterProfile(parsed.data); if (!result) return res.status(404).json({ ok: false, error: "That fleet printer was not found" });
    const label = parsed.data.profile.trim();
    return res.json({ ok: true, map: result.map, stamped: result.stamped, fleet: result.fleet, message: result.map ? `Assigned “${label}” to that printer. Matching plates now count toward its usage.` : `Assigned ${result.stamped} existing plate(s) with “${label}” to that printer. Future plates still need a per-plate choice (shared model name).` });
  });
  app.post("/api/printers/assign-plate", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = assignPrintFilePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const result = assignPrintFilePrinter(parsed.data); return result ? res.json({ ok: true, record: result.record, fleet: result.fleet, message: "Plate assigned to that printer. Its hours now count in the fleet breakdown." }) : res.status(404).json({ ok: false, error: "That plate or fleet printer was not found" });
  });
}
