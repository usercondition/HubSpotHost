import type { Express, Request, Response } from "express";
import {
  assignPrinterProfileSchema,
  assignPrintFilePrinterSchema,
  createPrinterLifecycleEventSchema,
  updatePrinterSchema,
} from "../../shared/schema";
import {
  addPrinterLifecycleEvent,
  assignPrintFilePrinter,
  assignPrinterProfile,
  buildPrinterFleetSnapshot,
  ensureDefaultPrinters,
  getPrinter,
  updatePrinter,
} from "./printers";
import { firstIssue } from "./validation";
import { startPrinterRunSchema } from "../../shared/printer-status";
import { buildStatusBoard, finishPrinterRun, listStartablePlates, startPrinterRun } from "./printer-status";

export function registerPrinterRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  /**
   * Printers page: IDLE / PRINTING board. Built only from stored plates and the
   * owner's started/done marks. Never contacts a printer.
   */
  app.get("/api/printers/status", (req, res) => {
    if (rejectOwner(req, res)) return;
    try {
      res.setHeader("cache-control", "no-store");
      return res.json({ ok: true, ...buildStatusBoard(), plates: listStartablePlates() });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load printer status",
      });
    }
  });
  app.post("/api/printers/status/:key/start", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = startPrinterRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const result = startPrinterRun(String(req.params.key), parsed.data);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.status(201).json({ ok: true, run: result.run, ...buildStatusBoard() });
  });
  app.post("/api/printers/status/:key/done", (req, res) => {
    if (rejectOwner(req, res)) return;
    const result = finishPrinterRun(String(req.params.key));
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true, closed: result.closed, ...buildStatusBoard() });
  });
  app.get("/api/printers", (req, res) => {
    if (rejectOwner(req, res)) return;
    try {
      ensureDefaultPrinters();
      return res.json({ ok: true, ...buildPrinterFleetSnapshot() });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load printer fleet",
      });
    }
  });
  app.patch("/api/printers/:id", (req, res) => {
    if (rejectOwner(req, res)) return;
    const id = Number(req.params.id);
    const parsed = updatePrinterSchema.safeParse(req.body ?? {});
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const printer = updatePrinter(id, parsed.data);
    if (!printer) return res.status(404).json({ ok: false, error: "That printer was not found" });
    return res.json({ ok: true, printer, fleet: buildPrinterFleetSnapshot() });
  });
  app.post("/api/printers/:id/events", (req, res) => {
    if (rejectOwner(req, res)) return;
    const id = Number(req.params.id);
    const parsed = createPrinterLifecycleEventSchema.safeParse(req.body ?? {});
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    if (!getPrinter(id)) return res.status(404).json({ ok: false, error: "That printer was not found" });
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const event = addPrinterLifecycleEvent(id, parsed.data);
    if (!event) return res.status(404).json({ ok: false, error: "That printer was not found" });
    return res.status(201).json({ ok: true, event, fleet: buildPrinterFleetSnapshot() });
  });
  /** Shared model profiles only stamp existing plates, preserving NEWX1/2/3 distinctions. */
  app.post("/api/printers/assign-profile", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = assignPrinterProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const result = assignPrinterProfile(parsed.data);
    if (!result) return res.status(404).json({ ok: false, error: "That fleet printer was not found" });
    const label = parsed.data.profile.trim();
    return res.json({
      ok: true,
      map: result.map,
      stamped: result.stamped,
      fleet: result.fleet,
      message: result.map
        ? `Assigned “${label}” to that printer. Matching plates now count toward its usage.`
        : `Assigned ${result.stamped} existing plate(s) with “${label}” to that printer. Future plates still need a per-plate choice (shared model name).`,
    });
  });
  /** One historical plate can be assigned without globally remapping its profile. */
  app.post("/api/printers/assign-plate", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = assignPrintFilePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const result = assignPrintFilePrinter(parsed.data);
    if (!result) return res.status(404).json({ ok: false, error: "That plate or fleet printer was not found" });
    return res.json({
      ok: true,
      record: result.record,
      fleet: result.fleet,
      message: "Plate assigned to that printer. Its hours now count in the fleet breakdown.",
    });
  });
}
