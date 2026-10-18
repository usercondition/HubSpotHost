/**
 * Printers page: IDLE / PRINTING per machine.
 *
 * Status comes only from data Print Ops already stores. Nothing here (or on
 * the server) talks to a printer or its network. A "run" is the owner's
 * one-tap mark that a plate/job was started on a printer; its estimated length
 * comes from the CTB/ULTX print time on the attached plate (or an hours value
 * the owner types for a job without a plate).
 *
 * PRINTING = the printer has a started run that is not marked done AND
 *            (its estimated end is still in the future, OR it has no estimate,
 *            which means it was marked in-progress without a print time).
 * IDLE     = anything else (no run, run marked done, or estimated end passed).
 */
import { z } from "zod";
import { DEFAULT_QUOTE_PRINTERS, type QuotePrinter } from "./stl-quote";

/**
 * Quote printer ids that are on the STL Quote list but never shown on Printers.
 * Mighty Revo: Miguel no longer owns it (2026-10-17). Not a toggle.
 */
export const STATUS_HIDDEN_PRINTER_IDS: readonly string[] = ["mighty-revo"];

/**
 * STL Quote printer id -> legacy fleet registry name (server/lib/printers.ts).
 * Used only to put plates whose slicer machine name matches a printer at the
 * top of that printer's "Start a job" picker.
 */
export const QUOTE_PRINTER_TO_FLEET_NAME: Readonly<Record<string, string>> = {
  "mega-8k-s": "MEGA 8K",
  "mighty-12k-new": "Mighty 12K NEW",
  "mighty-12k-old": "Mighty 12K OLD",
  "mighty-8k-old": "Mighty 8K OLD",
  "mighty-8k-newx1": "Mighty 8K NEWX1",
  "mighty-8k-newx2": "Mighty 8K NEWX2",
  "mighty-8k-newx3": "Mighty 8K NEWX3",
  "heygears-reflex": "HeyGears Reflex Turbo",
};

export type StatusRosterPrinter = { key: string; name: string; watts: number | null };

/** Printers shown on the status board: the STL Quote list minus parked/hidden ones. */
export function statusRoster(
  printers: readonly QuotePrinter[] = DEFAULT_QUOTE_PRINTERS,
  hidden: readonly string[] = STATUS_HIDDEN_PRINTER_IDS,
): StatusRosterPrinter[] {
  const seen = new Set<string>();
  const out: StatusRosterPrinter[] = [];
  for (const p of printers) {
    if (!p || p.parked || hidden.includes(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ key: p.id, name: p.name, watts: p.watts ?? null });
  }
  return out;
}

export type PrinterRun = {
  id: number;
  printerKey: string;
  recordId: number | null;
  dealId: string | null;
  jobLabel: string;
  fileName: string | null;
  startedAt: string;
  estSeconds: number | null;
  finishedAt: string | null;
};

export type PrinterState = "printing" | "idle";

export type PrinterLiveStatus = StatusRosterPrinter & {
  state: PrinterState;
  /** Present only while PRINTING. */
  current: null | {
    runId: number;
    jobLabel: string;
    fileName: string | null;
    dealId: string | null;
    startedAt: string;
    etaAt: string | null;
    /** Total estimated duration in seconds, null when the job has none. */
    estSeconds: number | null;
    remainingSeconds: number | null;
    /** 0..1, null when there is no estimate. */
    progress: number | null;
    /** Print name without the client suffix ("Leman Russ" from "Leman Russ - Alex R."). */
    printName?: string;
    /** Client for this job when Print Ops knows it (owner-only page). */
    clientName?: string | null;
  };
  /** Most recent finished run (marked done, or its estimate ran out). */
  last: null | { jobLabel: string; startedAt: string; endedAt: string; autoEnded: boolean; durationSeconds: number | null };
  /** Slice file dropped on this card and not started yet (parsed metadata only). */
  assigned?: PrinterAssignedFile | null;
};

/** Slice formats the Library slice parser reads stats from (server/lib/ctb.ts). */
export const ASSIGNABLE_SLICE_EXTENSIONS = [".ctb"] as const;
/** Bytes of the file the browser sends for parsing; the file itself is never stored. */
export const ASSIGN_PREFIX_BYTES = 2 * 1024 * 1024;

export function isAssignableSliceName(fileName: string): boolean {
  const lower = String(fileName ?? "").trim().toLowerCase();
  return ASSIGNABLE_SLICE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type PrinterAssignedFile = {
  fileName: string;
  sizeBytes: number | null;
  layerCount: number | null;
  layerHeightMm: number | null;
  printTimeSeconds: number | null;
  resinVolumeMl: number | null;
  /** Machine name the slicer wrote into the file. */
  printerProfile: string | null;
  assignedAt: string;
};

export type PrinterStatusBoard = {
  now: string;
  printingCount: number;
  idleCount: number;
  printers: PrinterLiveStatus[];
};

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Estimated end time in ms, or null when the run has no usable estimate. */
export function runEtaMs(run: Pick<PrinterRun, "startedAt" | "estSeconds">): number | null {
  const start = ms(run.startedAt);
  if (start == null || run.estSeconds == null || !(run.estSeconds > 0)) return null;
  return start + run.estSeconds * 1000;
}

/** True when this open (not done) run still counts as printing at nowMs. */
export function isRunPrinting(run: PrinterRun, nowMs: number): boolean {
  if (run.finishedAt) return false;
  const start = ms(run.startedAt);
  if (start == null) return false;
  const eta = runEtaMs(run);
  if (eta == null) return true; // marked in-progress, no estimate
  return eta > nowMs;
}

/** Status for one printer given its runs (any order) at nowMs. */
export function computePrinterStatus(
  printer: StatusRosterPrinter,
  runs: readonly PrinterRun[],
  nowMs: number,
): PrinterLiveStatus {
  const mine = runs
    .filter((r) => r.printerKey === printer.key && ms(r.startedAt) != null)
    .sort((a, b) => (ms(b.startedAt)! - ms(a.startedAt)!) || b.id - a.id);

  const printingRun = mine.find((r) => isRunPrinting(r, nowMs)) ?? null;
  let current: PrinterLiveStatus["current"] = null;
  if (printingRun) {
    const start = ms(printingRun.startedAt)!;
    const eta = runEtaMs(printingRun);
    const total = eta != null ? eta - start : null;
    current = {
      runId: printingRun.id,
      jobLabel: printingRun.jobLabel,
      fileName: printingRun.fileName,
      dealId: printingRun.dealId,
      startedAt: new Date(start).toISOString(),
      etaAt: eta != null ? new Date(eta).toISOString() : null,
      estSeconds: total != null && total > 0 ? Math.round(total / 1000) : null,
      remainingSeconds: eta != null ? Math.max(0, Math.round((eta - nowMs) / 1000)) : null,
      progress: total && total > 0 ? Math.min(1, Math.max(0, (nowMs - start) / total)) : null,
    };
  }

  let last: PrinterLiveStatus["last"] = null;
  for (const r of mine) {
    if (printingRun && r.id === printingRun.id) continue;
    const eta = runEtaMs(r);
    const finished = ms(r.finishedAt);
    let endMs: number | null = null;
    let autoEnded = false;
    if (finished != null && (eta == null || finished <= eta)) endMs = finished;
    else if (eta != null && eta <= nowMs) {
      endMs = eta;
      autoEnded = finished == null;
    } else if (finished != null) endMs = finished;
    if (endMs == null || endMs > nowMs) continue;
    if (!last || endMs > ms(last.endedAt)!) {
      const startMs = ms(r.startedAt)!;
      last = {
        jobLabel: r.jobLabel,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        autoEnded,
        durationSeconds: endMs > startMs ? Math.round((endMs - startMs) / 1000) : null,
      };
    }
  }

  return { ...printer, state: printingRun ? "printing" : "idle", current, last };
}

export function buildPrinterStatusBoard(
  roster: readonly StatusRosterPrinter[],
  runs: readonly PrinterRun[],
  nowMs: number,
): PrinterStatusBoard {
  const printers = roster.map((p) => computePrinterStatus(p, runs, nowMs));
  const printingCount = printers.filter((p) => p.state === "printing").length;
  return { now: new Date(nowMs).toISOString(), printingCount, idleCount: printers.length - printingCount, printers };
}

/**
 * Deal names made by Print Ops look like "<item> - <client>" (paid-orders.ts).
 * Split that into the print name and the client. Anything else stays whole.
 */
export function splitJobLabel(label: string | null | undefined): { printName: string; clientName: string | null } {
  const text = String(label ?? "").trim();
  const at = text.lastIndexOf(" - ");
  if (at <= 0) return { printName: text, clientName: null };
  const printName = text.slice(0, at).trim();
  const clientName = text.slice(at + 3).trim();
  // A long tail is more likely part of the item ("Terrain - ruined chapel walls").
  if (!printName || !clientName || clientName.length > 40 || clientName.split(/\s+/).length > 4 || /\d{2,}/.test(clientName)) {
    return { printName: text, clientName: null };
  }
  return { printName, clientName };
}

/** Which illustration a printer gets. Uses only the roster key/name. */
export type PrinterArt = "phrozen-mega" | "phrozen-mighty" | "heygears-reflex" | "generic";
export function printerArt(printer: { key: string; name?: string }): PrinterArt {
  const k = `${printer.key} ${printer.name ?? ""}`.toLowerCase();
  if (k.includes("heygears") || k.includes("reflex") || k.includes("ultracraft")) return "heygears-reflex";
  if (k.includes("mega")) return "phrozen-mega";
  if (k.includes("mighty") || k.includes("phrozen")) return "phrozen-mighty";
  return "generic";
}

/** Short, friendly name on the card: "Mighty 8K New X1" from "Phrozen Sonic Mighty 8K New X1". */
export function shortPrinterName(name: string): string {
  const short = name.replace(/^phrozen\s+sonic\s+/i, "").replace(/\s*\((.+)\)\s*$/, " $1").trim();
  return short || name;
}

/** "4h 05m left" / "12m left" / "under 1m left". */
export function formatRemaining(seconds: number | null): string {
  if (seconds == null) return "";
  if (seconds < 60) return "under 1m left";
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m left` : `${m}m left`;
}

/** Plates offered in the "Start a job" picker. */
export type StartablePlate = {
  recordId: number;
  dealId: string;
  dealName: string;
  fileName: string;
  printTimeSeconds: number | null;
  attachedAt: string;
  /** Status-board printer key the plate's slicer machine name points to, if any. */
  suggestedPrinterKey: string | null;
  /** True when this plate was already started on some printer. */
  started: boolean;
};

export const startPrinterRunSchema = z
  .object({
    recordId: z.coerce.number().int().positive().optional(),
    jobLabel: z.string().trim().max(200).optional(),
    /** Hours for a typed job (or to override a plate's print time). */
    estHours: z.coerce.number().min(0).max(240).optional(),
    /** Start the slice file assigned (dropped) on this card, using its estimated time. */
    useAssigned: z.boolean().optional(),
  })
  .refine((v) => v.useAssigned === true || v.recordId != null || (v.jobLabel ?? "").length > 0, {
    message: "Pick a plate or type a job name",
  });

export type StartPrinterRunInput = z.infer<typeof startPrinterRunSchema>;

export const printerVoiceSchema = z.object({
  text: z.string().trim().min(1, "Say the printer name").max(300),
  /** Confirmation from the prompt: start this printer (still needs a file on the card). */
  printerKey: z.string().trim().max(60).optional(),
});
