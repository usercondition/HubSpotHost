/**
 * Durable index of slice files. The bytes live in Google Drive.
 * This table never writes to HubSpot.
 */
import crypto from "node:crypto";
import type { PlateFileRecord, PlateFileSource, PlateLibraryPending, PlatePreviewStats, PlateUploadFailure, PrintLibraryMark } from "../../shared/plate-files";
import { libraryCatalogRecord, libraryCatalogText, libraryKitName, librarySliceName, plateExtension, platePartName } from "../../shared/plate-files";
import { getSqlite } from "./order-links";
import { PLATE_MESH_VERSION } from "./plate-mesh";

type FileRow = {
  drive_file_id: string;
  name: string;
  web_view_link: string;
  size_bytes: number | null;
  modified_at: string | null;
  mime_type: string;
  extension: string;
  printer: string;
  kit: string;
  customer: string;
  kit_tags: string;
  notes: string;
  source: string;
  sha256: string;
  mesh_drive_file_id?: string;
  mesh_state?: string;
  mesh_version?: number;
};

export interface PlateIndexInput {
  driveFileId: string;
  name: string;
  webViewLink: string;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  mimeType?: string;
  extension?: string;
  printer?: string;
  kit?: string;
  customer?: string;
  kitTags?: string;
  notes?: string;
  sha256?: string;
  printRecordIds?: number[];
  orderKeys?: string[];
}

function driveLink(id: string, webViewLink: string): string {
  const link = webViewLink.trim();
  if (link) return link;
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

function orderKeysFor(driveFileId: string): string[] {
  const rows = getSqlite()
    .prepare(`SELECT order_key FROM plate_file_orders WHERE drive_file_id = ? ORDER BY order_key`)
    .all(driveFileId) as Array<{ order_key: string }>;
  return rows.map((row) => row.order_key);
}

function parseStats(raw: string | null | undefined): PlatePreviewStats | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlatePreviewStats>;
    return {
      printerProfile: typeof parsed.printerProfile === "string" ? parsed.printerProfile : "",
      layerCount: typeof parsed.layerCount === "number" ? parsed.layerCount : null,
      layerHeightMm: typeof parsed.layerHeightMm === "number" ? parsed.layerHeightMm : null,
      printTimeSeconds: typeof parsed.printTimeSeconds === "number" ? parsed.printTimeSeconds : null,
      resinVolumeMl: typeof parsed.resinVolumeMl === "number" ? parsed.resinVolumeMl : null,
      resinCost: typeof parsed.resinCost === "number" ? parsed.resinCost : null,
    };
  } catch {
    return null;
  }
}

function previewFor(sha256: string): { hasPreview: boolean; stats: PlatePreviewStats | null } {
  if (!sha256) return { hasPreview: false, stats: null };
  const row = getSqlite()
    .prepare(`SELECT length(png) AS png_len, stats_json FROM plate_previews WHERE sha256 = ?`)
    .get(sha256) as { png_len: number; stats_json: string } | undefined;
  if (!row) return { hasPreview: false, stats: null };
  return { hasPreview: row.png_len > 32, stats: parseStats(row.stats_json) };
}

function printIdsFor(driveFileId: string): number[] {
  const rows = getSqlite()
    .prepare(`SELECT print_record_id FROM plate_file_prints WHERE drive_file_id = ? ORDER BY print_record_id`)
    .all(driveFileId) as Array<{ print_record_id: number }>;
  return rows.map((row) => row.print_record_id);
}

function toRecord(row: FileRow): PlateFileRecord {
  const source: PlateFileSource = row.source === "upload" ? "upload" : "indexed";
  const preview = previewFor(row.sha256 || "");
  return libraryCatalogRecord({
    driveFileId: row.drive_file_id,
    name: row.name,
    webViewLink: driveLink(row.drive_file_id, row.web_view_link),
    sizeBytes: row.size_bytes,
    modifiedAt: row.modified_at,
    mimeType: row.mime_type,
    extension: row.extension,
    printer: row.printer,
    kit: row.kit,
    customer: row.customer,
    kitTags: row.kit_tags,
    notes: row.notes,
    source,
    sha256: row.sha256 || "",
    orderKeys: orderKeysFor(row.drive_file_id),
    printRecordIds: printIdsFor(row.drive_file_id),
    hasPreview: preview.hasPreview,
    stats: preview.stats,
    meshDriveFileId: row.mesh_drive_file_id || "",
    meshState: row.mesh_state || "",
    meshVersion: row.mesh_version ?? 0,
  });
}

function catalogInput(file: PlateIndexInput): PlateIndexInput {
  const customer = file.customer ?? "";
  return {
    ...file,
    name: librarySliceName(file.name, customer),
    kit: libraryKitName(file.kit || file.name, customer),
    kitTags: libraryKitName(file.kitTags || file.kit || file.name, customer),
    notes: libraryCatalogText(file.notes ?? "", customer),
    customer: "",
  };
}

function readFile(driveFileId: string): FileRow | null {
  const row = getSqlite().prepare(`SELECT * FROM plate_files WHERE drive_file_id = ?`).get(driveFileId) as FileRow | undefined;
  return row ?? null;
}

function replaceLinks(driveFileId: string, orderKeys: string[]): void {
  const sqlite = getSqlite();
  sqlite.prepare(`DELETE FROM plate_file_orders WHERE drive_file_id = ?`).run(driveFileId);
  const insert = sqlite.prepare(`INSERT INTO plate_file_orders (drive_file_id, order_key) VALUES (?, ?)`);
  for (const orderKey of orderKeys) insert.run(driveFileId, orderKey);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function findReusablePlate(kit: string, part: string, printer: string): PlateFileRecord | null {
  const wantedKit = libraryKitName(kit).toLowerCase();
  const wantedPart = platePartName(part).toLowerCase();
  const wantedPrinter = printer.trim().toLowerCase();
  if (!wantedKit || !wantedPart || !wantedPrinter) return null;
  const rows = getSqlite()
    .prepare(`SELECT * FROM plate_files WHERE lower(kit) = ? AND lower(printer) = ? ORDER BY id DESC LIMIT 50`)
    .all(wantedKit, wantedPrinter) as FileRow[];
  for (const row of rows) {
    if (platePartName(row.name).toLowerCase() === wantedPart) return toRecord(row);
  }
  return null;
}

export function renameLibraryKit(from: string, to: string): number {
  const source = from.trim();
  const target = to.trim().replace(/\s+/g, " ").slice(0, 180);
  if (!source || !target || source.toLowerCase() === target.toLowerCase()) return 0;
  const result = getSqlite()
    .prepare(`UPDATE plate_files SET kit = ?, kit_tags = ?, updated_at = ? WHERE lower(kit) = lower(?)`)
    .run(target, target, new Date().toISOString(), source);
  return Number(result.changes);
}

export function countPlateFiles(): number {
  const row = getSqlite().prepare(`SELECT COUNT(*) AS n FROM plate_files`).get() as { n: number };
  return row?.n ?? 0;
}

export function listPlateFiles(query: { q?: string; printer?: string; orderKey?: string }): {
  files: PlateFileRecord[];
  failures: PlateUploadFailure[];
  pending: PlateLibraryPending[];
} {
  const q = query.q?.trim() ?? "";
  const printer = query.printer?.trim() ?? "";
  const orderKey = query.orderKey?.trim() ?? "";
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    const pattern = likePattern(q);
    where.push(
      `(name LIKE ? ESCAPE '\\' OR kit LIKE ? ESCAPE '\\' OR printer LIKE ? ESCAPE '\\' OR kit_tags LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern, pattern);
  }
  if (printer) {
    where.push(`printer = ?`);
    params.push(printer);
  }
  if (orderKey) {
    where.push(`drive_file_id IN (SELECT drive_file_id FROM plate_file_orders WHERE order_key = ?)`);
    params.push(orderKey);
  }
  const sql = `SELECT * FROM plate_files ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(modified_at, updated_at) DESC, id DESC LIMIT 200`;
  const rows = getSqlite().prepare(sql).all(...params) as FileRow[];
  return {
    files: rows.map(toRecord),
    failures: orderKey ? listUploadFailures(orderKey) : [],
    pending: orderKey ? listLibraryPending(orderKey) : [],
  };
}

export function upsertPlateFiles(files: PlateIndexInput[], source: PlateFileSource = "indexed"): PlateFileRecord[] {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  const saved: string[] = [];
  const write = sqlite.transaction((batch: PlateIndexInput[]) => {
    for (const file of batch.map(catalogInput)) {
      const existing = readFile(file.driveFileId);
      const nextSource: PlateFileSource = existing?.source === "upload" ? "upload" : source;
      const extension = (file.extension || plateExtension(file.name)).slice(0, 20);
      const kitTags = (file.kitTags || file.kit || "").slice(0, 240);
      sqlite
        .prepare(
          `INSERT INTO plate_files (
             drive_file_id, name, web_view_link, size_bytes, modified_at, mime_type, extension,
             printer, kit, customer, kit_tags, notes, source, sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(drive_file_id) DO UPDATE SET
             name = excluded.name,
             web_view_link = excluded.web_view_link,
             size_bytes = excluded.size_bytes,
             modified_at = excluded.modified_at,
             mime_type = excluded.mime_type,
             extension = excluded.extension,
             printer = excluded.printer,
             kit = excluded.kit,
             customer = excluded.customer,
             kit_tags = excluded.kit_tags,
             notes = excluded.notes,
             sha256 = CASE WHEN excluded.sha256 != '' THEN excluded.sha256 ELSE plate_files.sha256 END,
             source = CASE WHEN plate_files.source = 'upload' THEN 'upload' ELSE excluded.source END,
             updated_at = excluded.updated_at`,
        )
        .run(
          file.driveFileId,
          file.name,
          file.webViewLink,
          file.sizeBytes ?? null,
          file.modifiedAt ?? null,
          file.mimeType ?? "",
          extension,
          file.printer ?? "",
          file.kit ?? "",
          file.customer ?? "",
          kitTags,
          file.notes ?? "",
          nextSource,
          (file.sha256 ?? "").toLowerCase(),
          now,
          now,
        );
      if (file.orderKeys) replaceLinks(file.driveFileId, file.orderKeys);
      if (file.printRecordIds) linkPrintRecords(file.driveFileId, file.printRecordIds);
      saved.push(file.driveFileId);
    }
  });
  write(files);
  return saved.map((id) => toRecord(readFile(id)!));
}

export function markPlateMesh(
  driveFileId: string,
  patch: { meshDriveFileId?: string; meshState?: string; meshVersion?: number },
): PlateFileRecord | null {
  const row = readFile(driveFileId);
  if (!row) return null;
  const meshDriveFileId = patch.meshDriveFileId ?? row.mesh_drive_file_id ?? "";
  const meshState = patch.meshState ?? row.mesh_state ?? "";
  const meshVersion = patch.meshVersion ?? row.mesh_version ?? 0;
  getSqlite()
    .prepare(`UPDATE plate_files SET mesh_drive_file_id = ?, mesh_state = ?, mesh_version = ?, updated_at = ? WHERE drive_file_id = ?`)
    .run(meshDriveFileId, meshState, meshVersion, new Date().toISOString(), driveFileId);
  return toRecord(readFile(driveFileId)!);
}

export function listPlateIdsNeedingMesh(): string[] {
  const rows = getSqlite()
    .prepare(
      `SELECT drive_file_id FROM plate_files
       WHERE (lower(extension) = '.ctb' OR lower(name) LIKE '%.ctb')
         AND (mesh_state != 'ready' OR IFNULL(mesh_version, 0) < ?)
       ORDER BY id ASC
       LIMIT 40`,
    )
    .all(PLATE_MESH_VERSION) as Array<{ drive_file_id: string }>;
  return rows.map((row) => row.drive_file_id);
}

export function getPlateFile(driveFileId: string): PlateFileRecord | null {
  const row = readFile(driveFileId);
  return row ? toRecord(row) : null;
}

export function linkPlateFile(driveFileId: string, orderKey: string): PlateFileRecord | null {
  if (!readFile(driveFileId)) return null;
  getSqlite()
    .prepare(`INSERT INTO plate_file_orders (drive_file_id, order_key) VALUES (?, ?) ON CONFLICT(drive_file_id, order_key) DO NOTHING`)
    .run(driveFileId, orderKey);
  return toRecord(readFile(driveFileId)!);
}

export function unlinkPlateFile(driveFileId: string, orderKey: string): PlateFileRecord | null {
  if (!readFile(driveFileId)) return null;
  getSqlite().prepare(`DELETE FROM plate_file_orders WHERE drive_file_id = ? AND order_key = ?`).run(driveFileId, orderKey);
  return toRecord(readFile(driveFileId)!);
}

export function registerUploadedPlate(input: PlateIndexInput & { orderKey: string; printRecordId?: number }): PlateFileRecord {
  const cleaned = catalogInput(input);
  const [file] = upsertPlateFiles(
    [{ ...cleaned, orderKeys: [input.orderKey], printRecordIds: input.printRecordId ? [input.printRecordId] : undefined }],
    "upload",
  );
  clearUploadFailure(input.orderKey, input.name);
  if (cleaned.name !== input.name) clearUploadFailure(input.orderKey, cleaned.name);
  if (input.printRecordId) clearLibraryPending(input.printRecordId);
  return file;
}

function listUploadFailures(orderKey: string): PlateUploadFailure[] {
  const rows = getSqlite()
    .prepare(
      `SELECT id, order_key, name, printer, notes, error, created_at
       FROM plate_upload_failures WHERE order_key = ? ORDER BY id DESC`,
    )
    .all(orderKey) as Array<{
    id: number;
    order_key: string;
    name: string;
    printer: string;
    notes: string;
    error: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    orderKey: row.order_key,
    name: row.name,
    printer: row.printer,
    notes: row.notes,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export function recordUploadFailure(input: { orderKey: string; name: string; printer: string; notes: string; error: string }): PlateUploadFailure {
  const sqlite = getSqlite();
  sqlite.prepare(`DELETE FROM plate_upload_failures WHERE order_key = ? AND name = ?`).run(input.orderKey, input.name);
  const now = new Date().toISOString();
  const result = sqlite
    .prepare(
      `INSERT INTO plate_upload_failures (order_key, name, printer, notes, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.orderKey, input.name, input.printer, input.notes, input.error.slice(0, 300), now);
  return {
    id: Number(result.lastInsertRowid),
    orderKey: input.orderKey,
    name: input.name,
    printer: input.printer,
    notes: input.notes,
    error: input.error.slice(0, 300),
    createdAt: now,
  };
}

export function clearUploadFailure(orderKey: string, name: string): void {
  getSqlite().prepare(`DELETE FROM plate_upload_failures WHERE order_key = ? AND name = ?`).run(orderKey, name);
}

function linkPrintRecords(driveFileId: string, printRecordIds: number[]): void {
  const insert = getSqlite().prepare(
    `INSERT INTO plate_file_prints (drive_file_id, print_record_id) VALUES (?, ?) ON CONFLICT(drive_file_id, print_record_id) DO NOTHING`,
  );
  for (const printRecordId of printRecordIds) insert.run(driveFileId, printRecordId);
}

export function linkPlatePrint(driveFileId: string, printRecordId: number): void {
  linkPrintRecords(driveFileId, [printRecordId]);
  clearLibraryPending(printRecordId);
}

export function findPlateBySha256(orderKey: string, sha256: string): PlateFileRecord | null {
  const fingerprint = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  const row = getSqlite()
    .prepare(
      `SELECT drive_file_id FROM plate_files
       WHERE sha256 = ?
         AND drive_file_id IN (SELECT drive_file_id FROM plate_file_orders WHERE order_key = ?)
       LIMIT 1`,
    )
    .get(fingerprint, orderKey) as { drive_file_id: string } | undefined;
  if (!row) return null;
  const file = readFile(row.drive_file_id);
  return file ? toRecord(file) : null;
}

export function saveLibraryPending(input: {
  printRecordId: number;
  orderKey: string;
  sha256: string;
  name: string;
  error: string;
}): void {
  const now = new Date().toISOString();
  getSqlite()
    .prepare(
      `INSERT INTO plate_library_pending (print_record_id, order_key, sha256, name, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(print_record_id) DO UPDATE SET
         order_key = excluded.order_key,
         sha256 = excluded.sha256,
         name = excluded.name,
         error = excluded.error,
         updated_at = excluded.updated_at`,
    )
    .run(input.printRecordId, input.orderKey, input.sha256, input.name, input.error.slice(0, 300), now, now);
}

export function clearLibraryPending(printRecordId: number): void {
  getSqlite().prepare(`DELETE FROM plate_library_pending WHERE print_record_id = ?`).run(printRecordId);
}

function listLibraryPending(orderKey: string): PlateLibraryPending[] {
  const rows = getSqlite()
    .prepare(
      `SELECT print_record_id, order_key, sha256, name, error
       FROM plate_library_pending WHERE order_key = ? ORDER BY print_record_id`,
    )
    .all(orderKey) as Array<{ print_record_id: number; order_key: string; sha256: string; name: string; error: string }>;
  return rows.map((row) => ({
    printRecordId: row.print_record_id,
    orderKey: row.order_key,
    sha256: row.sha256,
    name: row.name,
    error: row.error,
  }));
}

export function libraryMarksForPrints(printRecordIds: number[]): Map<number, PrintLibraryMark> {
  const marks = new Map<number, PrintLibraryMark>();
  if (printRecordIds.length === 0) return marks;
  const placeholders = printRecordIds.map(() => "?").join(", ");
  const linked = getSqlite()
    .prepare(`SELECT print_record_id, drive_file_id FROM plate_file_prints WHERE print_record_id IN (${placeholders})`)
    .all(...printRecordIds) as Array<{ print_record_id: number; drive_file_id: string }>;
  for (const row of linked) {
    marks.set(row.print_record_id, { status: "in_library", driveFileId: row.drive_file_id, error: "" });
  }
  const pending = getSqlite()
    .prepare(`SELECT print_record_id, error FROM plate_library_pending WHERE print_record_id IN (${placeholders})`)
    .all(...printRecordIds) as Array<{ print_record_id: number; error: string }>;
  for (const row of pending) {
    if (marks.has(row.print_record_id)) continue;
    marks.set(row.print_record_id, { status: "pending", driveFileId: "", error: row.error });
  }
  return marks;
}

function statFilled(value: string | number | null | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim().length > 0;
}

/** Keep values already stored (attach-time cost included) and only fill blanks. */
export function mergePreviewStats(existing: PlatePreviewStats | null, incoming: PlatePreviewStats): PlatePreviewStats {
  if (!existing) return incoming;
  const keys = ["printerProfile", "layerCount", "layerHeightMm", "printTimeSeconds", "resinVolumeMl", "resinCost"] as const;
  const merged: PlatePreviewStats = { ...incoming };
  for (const key of keys) {
    const prior = existing[key];
    if (statFilled(prior)) merged[key] = prior as never;
  }
  return merged;
}

/** Fill a library preview from a header read. A blank fingerprint may be stored; a different one is left alone. Cost is never written. */
export function storeBlankPlatePreview(driveFileId: string, sha256: string, png: Buffer | null, stats: PlatePreviewStats): boolean {
  const fingerprint = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return false;
  const row = readFile(driveFileId);
  if (!row) return false;
  const current = (row.sha256 || "").trim().toLowerCase();
  if (current && current !== fingerprint) return false;
  if (!current) {
    const updated = getSqlite()
      .prepare(`UPDATE plate_files SET sha256 = ? WHERE drive_file_id = ? AND sha256 = ''`)
      .run(fingerprint, driveFileId);
    if (Number(updated.changes) !== 1) return false;
  }
  savePlatePreview(fingerprint, png, { ...stats, resinCost: null });
  return true;
}

export function savePlatePreview(sha256: string, png: Buffer | null, stats: PlatePreviewStats): void {
  const fingerprint = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return;
  const now = new Date().toISOString();
  const existing = getSqlite()
    .prepare(`SELECT png, stats_json FROM plate_previews WHERE sha256 = ?`)
    .get(fingerprint) as { png: Buffer; stats_json: string } | undefined;
  let prior: PlatePreviewStats | null = null;
  if (existing?.stats_json) {
    try {
      prior = JSON.parse(existing.stats_json) as PlatePreviewStats;
    } catch {
      prior = null;
    }
  }
  const nextPng = png && png.length > 32 ? png : existing?.png ?? Buffer.alloc(0);
  getSqlite()
    .prepare(
      `INSERT INTO plate_previews (sha256, png, stats_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET png = excluded.png, stats_json = excluded.stats_json, updated_at = excluded.updated_at`,
    )
    .run(fingerprint, nextPng, JSON.stringify(mergePreviewStats(prior, stats)), now);
}

export function readPlatePreviewPng(sha256: string): Buffer | null {
  const fingerprint = sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  const row = getSqlite().prepare(`SELECT png FROM plate_previews WHERE sha256 = ?`).get(fingerprint) as { png: Buffer } | undefined;
  if (!row || !row.png || row.png.length < 32) return null;
  return row.png;
}

export function saveDownloadTicket(driveFileId: string): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const sqlite = getSqlite();
  sqlite.prepare(`DELETE FROM plate_download_tickets WHERE expires_at < ?`).run(new Date().toISOString());
  sqlite.prepare(`INSERT INTO plate_download_tickets (token, drive_file_id, expires_at) VALUES (?, ?, ?)`).run(token, driveFileId, expiresAt);
  return { token, expiresAt };
}

export function readDownloadTicket(token: string): string | null {
  const row = getSqlite()
    .prepare(`SELECT drive_file_id, expires_at FROM plate_download_tickets WHERE token = ?`)
    .get(token) as { drive_file_id: string; expires_at: string } | undefined;
  if (!row || row.expires_at <= new Date().toISOString()) return null;
  return row.drive_file_id;
}
