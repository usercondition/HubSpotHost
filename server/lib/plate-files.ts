/**
 * Durable index of slice files. The bytes live in Google Drive.
 * This table never writes to HubSpot.
 */
import type { PlateFileRecord, PlateFileSource, PlateUploadFailure } from "../../shared/plate-files";
import { plateExtension } from "../../shared/plate-files";
import { getSqlite } from "./order-links";

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

function toRecord(row: FileRow): PlateFileRecord {
  const source: PlateFileSource = row.source === "upload" ? "upload" : "indexed";
  return {
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
    orderKeys: orderKeysFor(row.drive_file_id),
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

export function listPlateFiles(query: { q?: string; printer?: string; orderKey?: string }): {
  files: PlateFileRecord[];
  failures: PlateUploadFailure[];
} {
  const q = query.q?.trim() ?? "";
  const printer = query.printer?.trim() ?? "";
  const orderKey = query.orderKey?.trim() ?? "";
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    const pattern = likePattern(q);
    where.push(
      `(name LIKE ? ESCAPE '\\' OR kit LIKE ? ESCAPE '\\' OR printer LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\' OR kit_tags LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR drive_file_id IN (SELECT drive_file_id FROM plate_file_orders WHERE order_key LIKE ? ESCAPE '\\'))`,
    );
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
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
  };
}

export function upsertPlateFiles(files: PlateIndexInput[], source: PlateFileSource = "indexed"): PlateFileRecord[] {
  const sqlite = getSqlite();
  const now = new Date().toISOString();
  const saved: string[] = [];
  const write = sqlite.transaction((batch: PlateIndexInput[]) => {
    for (const file of batch) {
      const existing = readFile(file.driveFileId);
      const nextSource: PlateFileSource = existing?.source === "upload" ? "upload" : source;
      const extension = (file.extension || plateExtension(file.name)).slice(0, 20);
      const kitTags = (file.kitTags || file.kit || "").slice(0, 240);
      sqlite
        .prepare(
          `INSERT INTO plate_files (
             drive_file_id, name, web_view_link, size_bytes, modified_at, mime_type, extension,
             printer, kit, customer, kit_tags, notes, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          now,
          now,
        );
      if (file.orderKeys) replaceLinks(file.driveFileId, file.orderKeys);
      saved.push(file.driveFileId);
    }
  });
  write(files);
  return saved.map((id) => toRecord(readFile(id)!));
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

export function registerUploadedPlate(input: PlateIndexInput & { orderKey: string }): PlateFileRecord {
  const [file] = upsertPlateFiles([{ ...input, orderKeys: [input.orderKey] }], "upload");
  clearUploadFailure(input.orderKey, input.name);
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
