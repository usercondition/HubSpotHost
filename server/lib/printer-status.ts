/**
 * Server side of the Printers IDLE / PRINTING board.
 *
 * HARD RULE: this module never contacts a printer or any printer network
 * endpoint. It reads the plates Print Ops already stores (print_file_records,
 * with CTB/ULTX print time) and one small table of owner "started / done"
 * marks (printer_runs). The roster is the STL Quote printer list.
 */
import { desc, eq } from "drizzle-orm";
import { printFileRecords, type PrintFileRecord } from "../../shared/schema";
import {
  QUOTE_PRINTER_TO_FLEET_NAME,
  buildPrinterStatusBoard,
  statusRoster,
  type PrinterRun,
  type PrinterStatusBoard,
  type StartPrinterRunInput,
  type StartablePlate,
  type StatusRosterPrinter,
} from "../../shared/printer-status";
import { getDb, getSqlite } from "./order-links";
import { ensureDefaultPrinters, listPrinterProfileMaps, normalizePrinterKey, resolvePrinterIdForRecord } from "./printers";
import { getStlQuoteSettings } from "./stl-quote-store";

let ready = false;
function ensure() {
  if (ready) return;
  getSqlite().exec(`CREATE TABLE IF NOT EXISTS printer_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_key TEXT NOT NULL,
    print_file_record_id INTEGER,
    deal_id TEXT,
    job_label TEXT NOT NULL,
    file_name TEXT,
    started_at TEXT NOT NULL,
    est_seconds INTEGER,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS printer_runs_printer_started ON printer_runs (printer_key, started_at)`);
  ready = true;
}

type RunRow = {
  id: number;
  printer_key: string;
  print_file_record_id: number | null;
  deal_id: string | null;
  job_label: string;
  file_name: string | null;
  started_at: string;
  est_seconds: number | null;
  finished_at: string | null;
};

function toRun(row: RunRow): PrinterRun {
  return {
    id: row.id,
    printerKey: row.printer_key,
    recordId: row.print_file_record_id,
    dealId: row.deal_id,
    jobLabel: row.job_label,
    fileName: row.file_name,
    startedAt: row.started_at,
    estSeconds: row.est_seconds,
    finishedAt: row.finished_at,
  };
}

export function getStatusRoster(): StatusRosterPrinter[] {
  return statusRoster(getStlQuoteSettings().settings.printers);
}

/** Recent runs only: enough to know what is on each printer and the last job. */
export function listRecentRuns(limit = 400): PrinterRun[] {
  ensure();
  const rows = getSqlite()
    .prepare("SELECT * FROM printer_runs ORDER BY started_at DESC, id DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 2_000))) as RunRow[];
  return rows.map(toRun);
}

export function buildStatusBoard(nowMs = Date.now()): PrinterStatusBoard {
  return buildPrinterStatusBoard(getStatusRoster(), listRecentRuns(), nowMs);
}

/** Fleet printer id (legacy registry) -> status board key. */
function fleetIdToStatusKey(): Map<number, string> {
  const fleet = ensureDefaultPrinters();
  const byName = new Map(fleet.map((p) => [normalizePrinterKey(p.name), p.id]));
  const out = new Map<number, string>();
  for (const [key, fleetName] of Object.entries(QUOTE_PRINTER_TO_FLEET_NAME)) {
    const id = byName.get(normalizePrinterKey(fleetName));
    if (id != null) out.set(id, key);
  }
  return out;
}

/** Newest plates for the "Start a job" picker. */
export function listStartablePlates(limit = 40): StartablePlate[] {
  ensure();
  const records = getDb()
    .select()
    .from(printFileRecords)
    .orderBy(desc(printFileRecords.attachedAt), desc(printFileRecords.id))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all();
  const fleet = ensureDefaultPrinters();
  const maps = listPrinterProfileMaps();
  const toKey = fleetIdToStatusKey();
  const startedIds = new Set(
    (getSqlite().prepare("SELECT DISTINCT print_file_record_id AS id FROM printer_runs WHERE print_file_record_id IS NOT NULL").all() as Array<{ id: number }>).map((r) => r.id),
  );
  return records.map((r) => {
    const fleetId = resolvePrinterIdForRecord(r, fleet, maps);
    return {
      recordId: r.id,
      dealId: r.hubspotDealId,
      dealName: r.hubspotDealName,
      fileName: r.fileName,
      printTimeSeconds: r.printTimeSeconds && r.printTimeSeconds > 0 ? r.printTimeSeconds : null,
      attachedAt: r.attachedAt,
      suggestedPrinterKey: fleetId != null ? toKey.get(fleetId) ?? null : null,
      started: startedIds.has(r.id),
    };
  });
}

function getRecord(id: number): PrintFileRecord | null {
  return getDb().select().from(printFileRecords).where(eq(printFileRecords.id, id)).get() ?? null;
}

export type StartResult =
  | { ok: true; run: PrinterRun }
  | { ok: false; status: 404 | 400; error: string };

/** Mark a plate/job as started on a printer now. Closes any open run on that printer. */
export function startPrinterRun(printerKey: string, input: StartPrinterRunInput, nowMs = Date.now()): StartResult {
  ensure();
  if (!getStatusRoster().some((p) => p.key === printerKey)) {
    return { ok: false, status: 404, error: "That printer is not on the Printers list" };
  }
  let jobLabel = (input.jobLabel ?? "").trim();
  let fileName: string | null = null;
  let dealId: string | null = null;
  let estSeconds: number | null = input.estHours != null && input.estHours > 0 ? Math.round(input.estHours * 3_600) : null;
  if (input.recordId != null) {
    const record = getRecord(input.recordId);
    if (!record) return { ok: false, status: 404, error: "That plate was not found" };
    jobLabel = jobLabel || record.hubspotDealName || record.fileName;
    fileName = record.fileName;
    dealId = record.hubspotDealId;
    if (estSeconds == null && record.printTimeSeconds && record.printTimeSeconds > 0) estSeconds = record.printTimeSeconds;
  }
  if (!jobLabel) return { ok: false, status: 400, error: "Pick a plate or type a job name" };

  const now = new Date(nowMs).toISOString();
  const db = getSqlite();
  const tx = db.transaction(() => {
    db.prepare("UPDATE printer_runs SET finished_at = ? WHERE printer_key = ? AND finished_at IS NULL").run(now, printerKey);
    const info = db
      .prepare(
        `INSERT INTO printer_runs (printer_key, print_file_record_id, deal_id, job_label, file_name, started_at, est_seconds, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(printerKey, input.recordId ?? null, dealId, jobLabel.slice(0, 200), fileName, now, estSeconds, now);
    return Number(info.lastInsertRowid);
  });
  const id = tx();
  const row = db.prepare("SELECT * FROM printer_runs WHERE id = ?").get(id) as RunRow;
  return { ok: true, run: toRun(row) };
}

/** One-tap "done": close every open run on that printer. Returns how many were closed. */
export function finishPrinterRun(printerKey: string, nowMs = Date.now()): { ok: true; closed: number } | { ok: false; status: 404; error: string } {
  ensure();
  if (!getStatusRoster().some((p) => p.key === printerKey)) {
    return { ok: false, status: 404, error: "That printer is not on the Printers list" };
  }
  const info = getSqlite()
    .prepare("UPDATE printer_runs SET finished_at = ? WHERE printer_key = ? AND finished_at IS NULL")
    .run(new Date(nowMs).toISOString(), printerKey);
  return { ok: true, closed: info.changes };
}
