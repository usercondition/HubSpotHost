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
  splitJobLabel,
  statusRoster,
  type PrinterAssignedFile,
  type PrinterRun,
  type PrinterStatusBoard,
  type StartPrinterRunInput,
  type StartablePlate,
  type StatusRosterPrinter,
} from "../../shared/printer-status";
import { formatHours } from "../../shared/printer-times";
import { matchVoiceToPrinter, type VoiceCandidate, type VoiceMatch, type VoicePrinter } from "../../shared/printer-voice";
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
  CREATE INDEX IF NOT EXISTS printer_runs_printer_started ON printer_runs (printer_key, started_at);
  CREATE TABLE IF NOT EXISTS printer_assignments (
    printer_key TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    size_bytes INTEGER,
    layer_count INTEGER,
    layer_height_mm REAL,
    print_time_seconds INTEGER,
    resin_volume_ml REAL,
    printer_profile TEXT,
    assigned_at TEXT NOT NULL
  )`);
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

/**
 * Client name for a HubSpot deal from data Print Ops already stores locally
 * (Priority stack contact name). No HubSpot call. Null when unknown.
 */
function localClientNames(dealIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!dealIds.length) return out;
  try {
    const marks = dealIds.map(() => "?").join(",");
    const rows = getSqlite()
      .prepare(
        `SELECT hubspot_deal_id AS dealId, contact_name AS name FROM priority_stack_entries
         WHERE hubspot_deal_id IN (${marks}) AND TRIM(contact_name) <> '' ORDER BY updated_at DESC`,
      )
      .all(...dealIds) as Array<{ dealId: string; name: string }>;
    for (const r of rows) if (!out.has(r.dealId)) out.set(r.dealId, r.name.trim().slice(0, 80));
  } catch {
    // Table not created yet on a fresh database: fall back to the deal name.
  }
  return out;
}

/** Add print name + client to each running job (owner-only page). */
export function withJobDetails(board: PrinterStatusBoard): PrinterStatusBoard {
  const dealIds = [...new Set(board.printers.map((p) => p.current?.dealId).filter((v): v is string => !!v))];
  const names = localClientNames(dealIds);
  return {
    ...board,
    printers: board.printers.map((p) => {
      if (!p.current) return p;
      const split = splitJobLabel(p.current.jobLabel);
      const stored = p.current.dealId ? names.get(p.current.dealId) ?? null : null;
      return { ...p, current: { ...p.current, printName: split.printName, clientName: stored ?? split.clientName } };
    }),
  };
}

type AssignmentRow = {
  printer_key: string;
  file_name: string;
  size_bytes: number | null;
  layer_count: number | null;
  layer_height_mm: number | null;
  print_time_seconds: number | null;
  resin_volume_ml: number | null;
  printer_profile: string | null;
  assigned_at: string;
};

function toAssigned(row: AssignmentRow): PrinterAssignedFile {
  return {
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    layerCount: row.layer_count,
    layerHeightMm: row.layer_height_mm,
    printTimeSeconds: row.print_time_seconds && row.print_time_seconds > 0 ? row.print_time_seconds : null,
    resinVolumeMl: row.resin_volume_ml,
    printerProfile: row.printer_profile,
    assignedAt: row.assigned_at,
  };
}

export function listAssignments(): Map<string, PrinterAssignedFile> {
  ensure();
  const rows = getSqlite().prepare("SELECT * FROM printer_assignments").all() as AssignmentRow[];
  return new Map(rows.map((r) => [r.printer_key, toAssigned(r)]));
}

export function getAssignment(printerKey: string): PrinterAssignedFile | null {
  ensure();
  const row = getSqlite().prepare("SELECT * FROM printer_assignments WHERE printer_key = ?").get(printerKey) as AssignmentRow | undefined;
  return row ? toAssigned(row) : null;
}

function onRoster(printerKey: string): boolean {
  return getStatusRoster().some((p) => p.key === printerKey);
}

/** Store the parsed metadata of a slice file dropped on a card (replaces any earlier one). The file is not stored. */
export function assignPrinterFile(
  printerKey: string,
  meta: Omit<PrinterAssignedFile, "assignedAt">,
  nowMs = Date.now(),
): { ok: true; assigned: PrinterAssignedFile } | { ok: false; status: 404; error: string } {
  ensure();
  if (!onRoster(printerKey)) return { ok: false, status: 404, error: "That printer is not on the Printers list" };
  const clean = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
  getSqlite()
    .prepare(
      `INSERT INTO printer_assignments (printer_key, file_name, size_bytes, layer_count, layer_height_mm, print_time_seconds, resin_volume_ml, printer_profile, assigned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(printer_key) DO UPDATE SET file_name = excluded.file_name, size_bytes = excluded.size_bytes,
         layer_count = excluded.layer_count, layer_height_mm = excluded.layer_height_mm,
         print_time_seconds = excluded.print_time_seconds, resin_volume_ml = excluded.resin_volume_ml,
         printer_profile = excluded.printer_profile, assigned_at = excluded.assigned_at`,
    )
    .run(
      printerKey,
      meta.fileName.slice(0, 240),
      clean(meta.sizeBytes),
      clean(meta.layerCount),
      clean(meta.layerHeightMm),
      clean(meta.printTimeSeconds) != null ? Math.round(meta.printTimeSeconds!) : null,
      clean(meta.resinVolumeMl),
      meta.printerProfile ? meta.printerProfile.slice(0, 120) : null,
      new Date(nowMs).toISOString(),
    );
  return { ok: true, assigned: getAssignment(printerKey)! };
}

export function clearPrinterAssignment(printerKey: string): { ok: true; cleared: boolean } | { ok: false; status: 404; error: string } {
  ensure();
  if (!onRoster(printerKey)) return { ok: false, status: 404, error: "That printer is not on the Printers list" };
  const info = getSqlite().prepare("DELETE FROM printer_assignments WHERE printer_key = ?").run(printerKey);
  return { ok: true, cleared: info.changes > 0 };
}

export function buildStatusBoard(nowMs = Date.now()): PrinterStatusBoard {
  const board = withJobDetails(buildPrinterStatusBoard(getStatusRoster(), listRecentRuns(), nowMs));
  const assigned = listAssignments();
  return { ...board, printers: board.printers.map((p) => ({ ...p, assigned: assigned.get(p.key) ?? null })) };
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
  let consumeAssignment = false;
  if (input.useAssigned) {
    const file = getAssignment(printerKey);
    if (!file) return { ok: false, status: 400, error: "No slice file is assigned to this printer. Drop one on its card first." };
    jobLabel = jobLabel || file.fileName.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim() || file.fileName;
    fileName = file.fileName;
    if (estSeconds == null && file.printTimeSeconds) estSeconds = file.printTimeSeconds;
    consumeAssignment = true;
  } else if (input.recordId != null) {
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
      .run(printerKey, input.useAssigned ? null : input.recordId ?? null, dealId, jobLabel.slice(0, 200), fileName, now, estSeconds, now);
    // The dropped file is now the running job: clear it from the card.
    if (consumeAssignment) db.prepare("DELETE FROM printer_assignments WHERE printer_key = ?").run(printerKey);
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

/** Roster + fleet nicknames for voice matching ("12K OLD", "NEWX2", ...). */
export function voiceRoster(): VoicePrinter[] {
  const roster = getStatusRoster();
  let fleet: Array<{ name: string; aliasesJson?: string | null }> = [];
  try {
    fleet = ensureDefaultPrinters() as Array<{ name: string; aliasesJson?: string | null }>;
  } catch {
    fleet = [];
  }
  const byName = new Map(fleet.map((p) => [normalizePrinterKey(p.name), p]));
  return roster.map((p) => {
    const fleetName = QUOTE_PRINTER_TO_FLEET_NAME[p.key];
    const f = fleetName ? byName.get(normalizePrinterKey(fleetName)) : undefined;
    let aliases: string[] = [];
    try {
      aliases = f?.aliasesJson ? (JSON.parse(f.aliasesJson) as unknown[]).filter((a): a is string => typeof a === "string") : [];
    } catch {
      aliases = [];
    }
    return { key: p.key, name: p.name, aliases: fleetName ? [fleetName, ...aliases] : aliases };
  });
}

export type VoiceCandidateInfo = VoiceCandidate & {
  state: "printing" | "idle";
  assigned: PrinterAssignedFile | null;
  estHours: string;
};

export type VoiceStartResult = {
  ok: true;
  started: boolean;
  /** Why nothing started: no printer heard, more than one fits, no file on the card, or it is printing. */
  reason: "started" | "no_match" | "ambiguous" | "no_file" | "busy";
  heard: string;
  printerKey: string | null;
  printerName: string | null;
  estHours: string;
  candidates: VoiceCandidateInfo[];
  run?: PrinterRun;
};

/**
 * Voice "<printer> print started". Starts only on an unambiguous match whose card has a file
 * assigned and that is not already printing. Otherwise returns candidates and starts nothing.
 * A confirmation (printerKey from the prompt) still needs an assigned file.
 */
export function voiceStart(input: { text: string; printerKey?: string }, nowMs = Date.now()): VoiceStartResult | { ok: false; status: 404; error: string } {
  ensure();
  const roster = voiceRoster();
  const board = buildStatusBoard(nowMs);
  const byKey = new Map(board.printers.map((p) => [p.key, p]));
  let match: VoiceMatch;
  const confirmed = Boolean(input.printerKey);
  if (input.printerKey) {
    const p = roster.find((r) => r.key === input.printerKey);
    if (!p) return { ok: false, status: 404, error: "That printer is not on the Printers list" };
    const heard = matchVoiceToPrinter(input.text, roster);
    match = { ...heard, status: "match", printerKey: p.key, candidates: [{ key: p.key, name: p.name, score: 99 }] };
  } else {
    match = matchVoiceToPrinter(input.text, roster);
  }
  const info = (c: VoiceCandidate): VoiceCandidateInfo => {
    const p = byKey.get(c.key);
    const assigned = p?.assigned ?? null;
    return { ...c, state: p?.state ?? "idle", assigned, estHours: formatHours(assigned?.printTimeSeconds ?? null) };
  };
  const candidates = match.candidates.map(info);
  const base = { ok: true as const, heard: match.heard, candidates };
  if (match.status !== "match" || !match.printerKey) {
    return { ...base, started: false, reason: match.status === "none" ? "no_match" : "ambiguous", printerKey: null, printerName: null, estHours: "" };
  }
  const target = candidates.find((c) => c.key === match.printerKey) ?? info({ key: match.printerKey, name: match.printerKey, score: 0 });
  const common = { ...base, printerKey: target.key, printerName: target.name, estHours: target.estHours };
  if (!target.assigned) return { ...common, started: false, reason: "no_file" };
  if (target.state === "printing" && !confirmed) return { ...common, started: false, reason: "busy" };
  const started = startPrinterRun(target.key, { useAssigned: true }, nowMs);
  if (!started.ok) return { ...common, started: false, reason: "no_file" };
  return { ...common, started: true, reason: "started", run: started.run };
}
