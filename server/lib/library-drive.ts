/**
 * Library <- Google Drive folder "Chitubox Sliced files" (Miguel's sliced CTB plates).
 *
 * Read-only toward Drive. The server's Google token only has drive.file scope, so it cannot list that
 * folder itself. Instead it reuses the business-only Files index the Mac mini already pushes nightly
 * (drive_files table, see drive-files.ts): rows there are privacy-filtered and client-masked upstream.
 * We pick the rows that live under the folder (by parent id or folder path) and fold them into
 * plate_files so the existing Library features (kits, order links, job picker, previews) keep working.
 *
 * Dedupe: one plate = one Library item regardless of path.
 *   1. same Drive file id            -> same row (an upload that already lives in the folder)
 *   2. same slice fingerprint sha256 -> the Drive copy is recorded on that row (when a pusher sends one)
 *   3. same file name + exact size   -> the Drive copy is recorded on that row
 *   4. otherwise                     -> a new source='drive' row
 * Manual metadata (printer, kit, notes, sliced stats, order links) is never overwritten by Drive. A
 * Drive-only row folds into an uploaded twin when one shows up later (links move, nothing is lost).
 * Drive-only rows that vanished from the folder are dropped only when nothing links to them and the
 * index still contains the folder itself (an empty/aborted push never wipes the Library).
 */
import {
  LIBRARY_DRIVE_FOLDER_ID_DEFAULT,
  LIBRARY_DRIVE_FOLDER_NAME_DEFAULT,
  guessPlatePrinter,
  isPlateFileName,
  libraryDedupeKey,
  maskLibraryClientText,
  plateExtension,
  type LibraryDriveStatus,
} from "../../shared/plate-files";
import { driveFilesDb } from "./drive-files";
import { getSqlite } from "./order-links";

/** The Library is sliced plates. Source meshes (.stl/.3mf) in the folder stay on the Files page. */
function isSlicedPlateName(name: string): boolean {
  if (!isPlateFileName(name)) return false;
  const ext = plateExtension(name);
  return ext !== ".stl" && ext !== ".3mf";
}

export interface LibraryDriveRow {
  id: string;
  name: string;
  path: string;
  parent: string | null;
  size: number | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  mimeType: string | null;
  thumbSource: string;
  thumbKey: string | null;
  /** Optional slice fingerprint (a future PC backup pusher can send it). */
  sha256?: string;
}

export interface LibraryDriveResult {
  seen: number;
  inserted: number;
  updated: number;
  merged: number;
  folded: number;
  pruned: number;
  skipped: boolean;
}

export function libraryDriveFolderId(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIBRARY_DRIVE_FOLDER_ID?.trim() || LIBRARY_DRIVE_FOLDER_ID_DEFAULT;
}

function folderRow(folderId: string): { name: string; path: string } | null {
  const row = driveFilesDb().prepare(`SELECT name, path FROM drive_files WHERE id = ?`).get(folderId) as
    | { name: string; path: string }
    | undefined;
  return row ?? null;
}

function folderPathOf(folderId: string, env: NodeJS.ProcessEnv): { path: string; name: string; indexed: boolean } {
  const row = folderRow(folderId);
  const fallback = env.LIBRARY_DRIVE_FOLDER_NAME?.trim() || LIBRARY_DRIVE_FOLDER_NAME_DEFAULT;
  if (!row) return { path: fallback, name: fallback, indexed: false };
  const path = row.path ? `${row.path}/${row.name}` : row.name;
  return { path, name: row.name, indexed: true };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Plates under the Library folder, straight from the Files index (no Drive call). */
export function readLibraryDriveRows(env: NodeJS.ProcessEnv = process.env): { rows: LibraryDriveRow[]; folderPath: string; indexed: boolean } {
  const folderId = libraryDriveFolderId(env);
  const folder = folderPathOf(folderId, env);
  const raw = driveFilesDb()
    .prepare(
      `SELECT id, name, path, parent, size, modified_time, web_view_link, mime_type, thumb_source, thumb_key
       FROM drive_files
       WHERE category != 'folder'
         AND (parent = ? OR path = ? OR path LIKE ? ESCAPE '\\')`,
    )
    .all(folderId, folder.path, `${escapeLike(folder.path)}/%`) as Array<{
    id: string;
    name: string;
    path: string;
    parent: string | null;
    size: number | null;
    modified_time: string | null;
    web_view_link: string | null;
    mime_type: string | null;
    thumb_source: string;
    thumb_key: string | null;
  }>;
  const rows = raw
    .filter((row) => isSlicedPlateName(row.name))
    .map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      parent: row.parent,
      size: row.size,
      modifiedTime: row.modified_time,
      webViewLink: row.web_view_link,
      mimeType: row.mime_type,
      thumbSource: row.thumb_source,
      thumbKey: row.thumb_key,
    }));
  return { rows, folderPath: folder.path, indexed: folder.indexed };
}

/** Subfolder label inside the Library folder ("" = root). */
export function subfolderOf(path: string, folderPath: string): string {
  if (!path || path === folderPath) return "";
  if (path.startsWith(`${folderPath}/`)) return path.slice(folderPath.length + 1);
  return "";
}

/** Contact names Print Ops already knows (stack entries), used for the display mask. */
export function knownContactNames(): string[] {
  try {
    const rows = getSqlite()
      .prepare(`SELECT DISTINCT contact_name FROM priority_stack_entries WHERE contact_name IS NOT NULL AND contact_name != ''`)
      .all() as Array<{ contact_name: string }>;
    const names = new Set<string>();
    for (const row of rows) {
      const full = row.contact_name.trim();
      if (!full) continue;
      names.add(full);
    }
    return Array.from(names);
  } catch {
    return [];
  }
}

type PlateRow = {
  drive_file_id: string;
  name: string;
  size_bytes: number | null;
  modified_at: string | null;
  source: string;
  sha256: string;
  printer: string;
  kit: string;
  drive_folder: string | null;
};

function isNewer(incoming: string | null, stored: string | null): boolean {
  if (!incoming) return false;
  if (!stored) return true;
  return Date.parse(incoming) > Date.parse(stored);
}

function linkCount(driveFileId: string): number {
  const sqlite = getSqlite();
  const orders = (sqlite.prepare(`SELECT COUNT(*) AS n FROM plate_file_orders WHERE drive_file_id = ?`).get(driveFileId) as { n: number }).n;
  const prints = (sqlite.prepare(`SELECT COUNT(*) AS n FROM plate_file_prints WHERE drive_file_id = ?`).get(driveFileId) as { n: number }).n;
  return orders + prints;
}

function readMeta(key: string): string | null {
  const row = getSqlite().prepare(`SELECT v FROM plate_library_meta WHERE k = ?`).get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

function writeMeta(key: string, value: string): void {
  getSqlite()
    .prepare(`INSERT INTO plate_library_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(key, value);
}

function indexGeneratedAt(): string | null {
  try {
    const row = driveFilesDb().prepare(`SELECT v FROM drive_files_meta WHERE k = 'generatedAt'`).get() as { v: string } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/** Fold Library Drive folder rows into plate_files. Pure SQLite; safe to call often. */
export function reconcileLibraryDrive(
  input?: { rows: LibraryDriveRow[]; folderPath: string; indexed: boolean },
  options: { contactNames?: string[]; now?: Date } = {},
): LibraryDriveResult {
  const source = input ?? readLibraryDriveRows();
  const contactNames = options.contactNames ?? knownContactNames();
  const now = (options.now ?? new Date()).toISOString();
  const sqlite = getSqlite();
  const result: LibraryDriveResult = { seen: source.rows.length, inserted: 0, updated: 0, merged: 0, folded: 0, pruned: 0, skipped: false };
  if (!source.indexed && source.rows.length === 0) {
    result.skipped = true;
    return result;
  }

  const readPlate = sqlite.prepare(`SELECT * FROM plate_files WHERE drive_file_id = ?`);
  const readCopy = sqlite.prepare(`SELECT drive_file_id FROM plate_file_drive_copies WHERE copy_id = ?`);
  const upsertCopy = sqlite.prepare(
    `INSERT INTO plate_file_drive_copies (copy_id, drive_file_id, web_view_link, folder, size_bytes, modified_at, matched_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(copy_id) DO UPDATE SET
       web_view_link = excluded.web_view_link, folder = excluded.folder, size_bytes = excluded.size_bytes,
       modified_at = excluded.modified_at, updated_at = excluded.updated_at`,
  );

  const run = sqlite.transaction(() => {
    const plates = sqlite.prepare(`SELECT drive_file_id, name, size_bytes, modified_at, source, sha256, printer, kit, drive_folder FROM plate_files`).all() as PlateRow[];
    const byKey = new Map<string, PlateRow>();
    const bySha = new Map<string, PlateRow>();
    // Prefer uploaded/indexed rows as the canonical item for a key.
    for (const plate of [...plates].sort((a, b) => (a.source === "drive" ? 1 : 0) - (b.source === "drive" ? 1 : 0))) {
      const key = libraryDedupeKey(plate.name, plate.size_bytes);
      if (key && !byKey.has(key)) byKey.set(key, plate);
      if (plate.sha256 && !bySha.has(plate.sha256)) bySha.set(plate.sha256, plate);
    }
    const seenIds = new Set<string>();

    for (const row of source.rows) {
      seenIds.add(row.id);
      const folder = maskLibraryClientText(subfolderOf(row.path, source.folderPath), contactNames);
      const name = maskLibraryClientText(row.name, contactNames);
      const link = row.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(row.id)}/view`;
      const thumbKey = row.thumbSource !== "icon" && row.thumbKey ? row.thumbKey : "";

      // 1. same Drive file id
      const own = readPlate.get(row.id) as PlateRow | undefined;
      if (own) {
        if (own.source === "drive") {
          const fresh = isNewer(row.modifiedTime, own.modified_at);
          sqlite
            .prepare(
              `UPDATE plate_files SET name = ?, web_view_link = ?, drive_folder = ?, drive_thumb_key = ?,
                 size_bytes = CASE WHEN ? THEN ? ELSE size_bytes END,
                 modified_at = CASE WHEN ? THEN ? ELSE modified_at END,
                 printer = CASE WHEN printer = '' THEN ? ELSE printer END,
                 updated_at = ?
               WHERE drive_file_id = ?`,
            )
            .run(name, link, folder, thumbKey, fresh ? 1 : 0, row.size, fresh ? 1 : 0, row.modifiedTime, guessPlatePrinter(name), now, row.id);
        } else {
          // Uploaded plate that lives in the folder: only note where it is. Manual data wins.
          sqlite.prepare(`UPDATE plate_files SET drive_folder = ?, updated_at = ? WHERE drive_file_id = ?`).run(folder, now, row.id);
        }
        result.updated += 1;
        continue;
      }

      // Already recorded as a copy of another item.
      const copied = readCopy.get(row.id) as { drive_file_id: string } | undefined;
      if (copied && readPlate.get(copied.drive_file_id)) {
        upsertCopy.run(row.id, copied.drive_file_id, link, folder, row.size, row.modifiedTime, "name+size", now, now);
        result.updated += 1;
        continue;
      }

      // 2./3. sha256 or name + size twin.
      const sha = (row.sha256 ?? "").toLowerCase();
      const twinBySha = sha ? bySha.get(sha) : undefined;
      const key = libraryDedupeKey(name, row.size);
      const twin = twinBySha ?? (key ? byKey.get(key) : undefined);
      if (twin && twin.drive_file_id !== row.id) {
        upsertCopy.run(row.id, twin.drive_file_id, link, folder, row.size, row.modifiedTime, twinBySha ? "sha256" : "name+size", now, now);
        result.merged += 1;
        continue;
      }

      // 4. new Drive-only plate.
      const printer = guessPlatePrinter(name);
      const kit = folder || source.folderPath.split("/").pop() || LIBRARY_DRIVE_FOLDER_NAME_DEFAULT;
      sqlite
        .prepare(
          `INSERT INTO plate_files (
             drive_file_id, name, web_view_link, size_bytes, modified_at, mime_type, extension,
             printer, kit, customer, kit_tags, notes, source, sha256, drive_folder, drive_thumb_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', 'drive', ?, ?, ?, ?, ?)`,
        )
        .run(row.id, name, link, row.size, row.modifiedTime, row.mimeType ?? "", plateExtension(name), printer, kit, kit, sha, folder, thumbKey, now, now);
      const inserted: PlateRow = {
        drive_file_id: row.id, name, size_bytes: row.size, modified_at: row.modifiedTime, source: "drive", sha256: sha, printer, kit, drive_folder: folder,
      };
      if (key && !byKey.has(key)) byKey.set(key, inserted);
      if (sha && !bySha.has(sha)) bySha.set(sha, inserted);
      result.inserted += 1;
    }

    // Fold Drive-only rows into an uploaded twin that appeared after them.
    result.folded += foldDriveTwins(now);

    // Prune only when the index still has the folder (never on an empty/aborted push).
    if (source.indexed) {
      const driveRows = sqlite.prepare(`SELECT drive_file_id FROM plate_files WHERE source = 'drive'`).all() as Array<{ drive_file_id: string }>;
      for (const { drive_file_id } of driveRows) {
        if (seenIds.has(drive_file_id)) continue;
        if (linkCount(drive_file_id) > 0) {
          sqlite.prepare(`UPDATE plate_files SET drive_folder = NULL, updated_at = ? WHERE drive_file_id = ?`).run(now, drive_file_id);
          continue;
        }
        sqlite.prepare(`DELETE FROM plate_files WHERE drive_file_id = ?`).run(drive_file_id);
        sqlite.prepare(`DELETE FROM plate_file_drive_copies WHERE drive_file_id = ?`).run(drive_file_id);
        result.pruned += 1;
      }
      const copies = sqlite.prepare(`SELECT copy_id FROM plate_file_drive_copies`).all() as Array<{ copy_id: string }>;
      for (const { copy_id } of copies) {
        if (!seenIds.has(copy_id)) sqlite.prepare(`DELETE FROM plate_file_drive_copies WHERE copy_id = ?`).run(copy_id);
      }
      sqlite.prepare(`UPDATE plate_files SET drive_folder = NULL WHERE source != 'drive' AND drive_folder IS NOT NULL AND drive_file_id NOT IN (${
        seenIds.size ? Array.from(seenIds).map(() => "?").join(",") : "''"
      })`).run(...Array.from(seenIds));
    }
  });
  run();
  writeMeta("driveReconciledAt", now);
  writeMeta("driveIndexGeneratedAt", indexGeneratedAt() ?? "");
  return result;
}

/**
 * A Drive-only row and an uploaded/indexed row with the same name + size are one plate. Keep the
 * uploaded row (it carries sliced stats and the preview), move order/print links over, record the
 * Drive copy on it, and drop the Drive-only row. Returns how many rows were folded.
 */
export function foldDriveTwins(now = new Date().toISOString()): number {
  const sqlite = getSqlite();
  const plates = sqlite
    .prepare(`SELECT drive_file_id, name, size_bytes, modified_at, source, sha256, printer, kit, drive_folder, web_view_link FROM plate_files`)
    .all() as Array<PlateRow & { web_view_link: string }>;
  const keep = new Map<string, PlateRow>();
  for (const plate of plates) {
    if (plate.source === "drive") continue;
    const key = libraryDedupeKey(plate.name, plate.size_bytes);
    if (key && !keep.has(key)) keep.set(key, plate);
    if (plate.sha256 && !keep.has(`sha:${plate.sha256}`)) keep.set(`sha:${plate.sha256}`, plate);
  }
  let folded = 0;
  for (const plate of plates) {
    if (plate.source !== "drive") continue;
    const target =
      (plate.sha256 ? keep.get(`sha:${plate.sha256}`) : undefined) ?? keep.get(libraryDedupeKey(plate.name, plate.size_bytes));
    if (!target || target.drive_file_id === plate.drive_file_id) continue;
    sqlite
      .prepare(`INSERT INTO plate_file_orders (drive_file_id, order_key) SELECT ?, order_key FROM plate_file_orders WHERE drive_file_id = ? ON CONFLICT DO NOTHING`)
      .run(target.drive_file_id, plate.drive_file_id);
    sqlite.prepare(`DELETE FROM plate_file_orders WHERE drive_file_id = ?`).run(plate.drive_file_id);
    sqlite
      .prepare(`INSERT INTO plate_file_prints (drive_file_id, print_record_id) SELECT ?, print_record_id FROM plate_file_prints WHERE drive_file_id = ? ON CONFLICT DO NOTHING`)
      .run(target.drive_file_id, plate.drive_file_id);
    sqlite.prepare(`DELETE FROM plate_file_prints WHERE drive_file_id = ?`).run(plate.drive_file_id);
    sqlite.prepare(`UPDATE plate_file_drive_copies SET drive_file_id = ?, updated_at = ? WHERE drive_file_id = ?`).run(target.drive_file_id, now, plate.drive_file_id);
    sqlite
      .prepare(
        `INSERT INTO plate_file_drive_copies (copy_id, drive_file_id, web_view_link, folder, size_bytes, modified_at, matched_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(copy_id) DO UPDATE SET drive_file_id = excluded.drive_file_id, updated_at = excluded.updated_at`,
      )
      .run(
        plate.drive_file_id,
        target.drive_file_id,
        plate.web_view_link,
        plate.drive_folder ?? "",
        plate.size_bytes,
        plate.modified_at,
        plate.sha256 && plate.sha256 === target.sha256 ? "sha256" : "name+size",
        now,
        now,
      );
    // Fill blanks on the kept row only (never overwrite manual data).
    sqlite
      .prepare(`UPDATE plate_files SET printer = CASE WHEN printer = '' THEN ? ELSE printer END, updated_at = ? WHERE drive_file_id = ?`)
      .run(plate.printer, now, target.drive_file_id);
    sqlite.prepare(`DELETE FROM plate_files WHERE drive_file_id = ?`).run(plate.drive_file_id);
    folded += 1;
  }
  return folded;
}

const RECONCILE_MIN_MS = 60_000;
let lastReconcileMs = 0;

/** On Library open: reconcile when the Files index changed, or at most once a minute. Never throws. */
export function maybeReconcileLibraryDrive(nowMs = Date.now()): void {
  try {
    const generated = indexGeneratedAt() ?? "";
    const seenGeneration = readMeta("driveIndexGeneratedAt") ?? "";
    if (generated === seenGeneration && nowMs - lastReconcileMs < RECONCILE_MIN_MS) return;
    lastReconcileMs = nowMs;
    reconcileLibraryDrive();
  } catch (error) {
    console.error("[library-drive] reconcile failed", error instanceof Error ? error.message : String(error));
  }
}

export function resetLibraryDriveThrottleForTests(): void {
  lastReconcileMs = 0;
}

export function libraryDriveStatus(env: NodeJS.ProcessEnv = process.env): LibraryDriveStatus {
  const folderId = libraryDriveFolderId(env);
  let indexed = false;
  let folderName = env.LIBRARY_DRIVE_FOLDER_NAME?.trim() || LIBRARY_DRIVE_FOLDER_NAME_DEFAULT;
  try {
    const row = folderRow(folderId);
    if (row) {
      indexed = true;
      folderName = row.name;
    }
  } catch {
    indexed = false;
  }
  const sqlite = getSqlite();
  const plates = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM plate_files
         WHERE drive_folder IS NOT NULL OR drive_file_id IN (SELECT drive_file_id FROM plate_file_drive_copies)`,
      )
      .get() as { n: number }
  ).n;
  const merged = (sqlite.prepare(`SELECT COUNT(*) AS n FROM plate_file_drive_copies`).get() as { n: number }).n;
  return {
    folderId,
    folderName,
    folderLink: `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`,
    indexed,
    plates,
    merged,
    indexGeneratedAt: indexGeneratedAt(),
    reconciledAt: readMeta("driveReconciledAt"),
  };
}

/** Thumbnail bytes from the Files index for a Drive-folder plate (owner route serves them). */
export function readLibraryDriveThumb(key: string): { mime: string; data: Buffer } | null {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key)) return null;
  const owned = getSqlite().prepare(`SELECT 1 FROM plate_files WHERE drive_thumb_key = ? LIMIT 1`).get(key);
  if (!owned) return null;
  const row = driveFilesDb().prepare(`SELECT mime, data FROM drive_thumbs WHERE key = ?`).get(key) as { mime: string; data: Buffer } | undefined;
  return row ?? null;
}
