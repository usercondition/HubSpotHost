/**
 * Files page backend: business-only Google Drive index with thumbnails.
 *
 * Data flow (push, no inbound path to the Mac mini needed): the Mac mini's nightly drive_thumbs.py builds
 * ~/.hermes/data/drive_inventory/files/files_index.json (personal/VA/medical/family/client-PII folders are
 * already excluded and client names redacted there), then drive_files_sync.py pushes it here:
 *   GET  /api/ops/files/sync/thumbs           -> {keys: {key: sha}} so only new/changed thumbs are sent
 *   POST /api/ops/files/sync/thumbs           {thumbs: [{key, sha, mime, data(base64)}]}  (<= 1 MB body)
 *   POST /api/ops/files/sync/rows             {generation, rows: [...]}
 *   POST /api/ops/files/sync/commit           {generation} -> drops rows not seen in this generation
 * Auth for sync: Bearer FILES_SYNC_TOKEN (>= 24 chars; 503 when unset). Write-only token, separate from
 * NERVE_READ_TOKEN and the owner code.
 *
 * Read: GET /api/files?q=&cat=&offset=&limit= behind the normal Print Ops owner code. Thumbnails are
 * returned inline as data: URLs so <img> never needs a separate unauthenticated route.
 * Read-only toward Drive: links only (Open in Drive / Download / Share link); nothing is moved or shared.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  DRIVE_FILE_CATEGORIES,
  queryTokens,
  type DriveFileCategory,
  type DriveFileView,
  type DriveFilesResponse,
  type DriveThumbSource,
} from "../../shared/drive-files";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  parent TEXT,
  size INTEGER,
  modified_time TEXT,
  web_view_link TEXT,
  mime_type TEXT,
  tags TEXT NOT NULL DEFAULT '{}',
  thumb_source TEXT NOT NULL DEFAULT 'icon',
  thumb_key TEXT,
  web_source_url TEXT,
  search TEXT NOT NULL DEFAULT '',
  generation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_files_cat ON drive_files(category);
CREATE TABLE IF NOT EXISTS drive_thumbs (
  key TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_files_meta (k TEXT PRIMARY KEY, v TEXT);
`;

let sqlite: Database.Database | null = null;

export function driveFilesDbFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DRIVE_FILES_DB_FILE?.trim();
  if (configured === ":memory:") return configured;
  if (configured) return path.resolve(configured);
  const orderLinks = env.ORDER_LINKS_DB_FILE?.trim();
  if (orderLinks === ":memory:") return ":memory:";
  return path.resolve(orderLinks ? path.dirname(orderLinks) : "/data", "drive-files.db");
}

export function driveFilesDb(): Database.Database {
  if (sqlite) return sqlite;
  const file = driveFilesDbFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(SCHEMA);
  return sqlite;
}

/** Test hook. */
export function resetDriveFilesDbForTests() {
  sqlite?.close();
  sqlite = null;
}

function syncToken(env: NodeJS.ProcessEnv) {
  return env.FILES_SYNC_TOKEN?.trim() || "";
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function rejectFilesSync(req: Request, res: Response, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = syncToken(env);
  if (expected.length < 24) {
    res.status(503).json({ ok: false, error: "Files sync is not configured (FILES_SYNC_TOKEN)" });
    return true;
  }
  const provided = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return true;
  }
  return false;
}

const KEY = z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/);
const thumbSources = ["drive", "folder-photo", "render", "web", "icon"] as const;
const rowSchema = z.object({
  id: KEY,
  name: z.string().max(400),
  category: z.enum(DRIVE_FILE_CATEGORIES),
  path: z.string().max(1200).default(""),
  parent: z.string().max(120).nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  modifiedTime: z.string().max(40).nullable().optional(),
  webViewLink: z
    .string()
    .max(500)
    .regex(/^https:\/\/(drive|docs)\.google\.com\//)
    .nullable()
    .optional(),
  mimeType: z.string().max(200).nullable().optional(),
  tags: z.record(z.string().max(40), z.string().max(80)).default({}),
  thumbSource: z.enum(thumbSources).default("icon"),
  thumbKey: KEY.nullable().optional(),
  webSourceUrl: z.string().max(500).regex(/^https:\/\//).nullable().optional(),
});
const rowsSchema = z.object({ generation: z.string().min(4).max(40), rows: z.array(rowSchema).max(5000) });
const thumbsSchema = z.object({
  thumbs: z
    .array(
      z.object({
        key: KEY,
        sha: z.string().regex(/^[a-f0-9]{8,64}$/),
        mime: z.enum(["image/jpeg", "image/png"]),
        data: z.string().max(200_000),
      }),
    )
    .max(200),
});
const commitSchema = z.object({ generation: z.string().min(4).max(40), generatedAt: z.string().max(40).optional() });

export function searchBlob(r: { name: string; path: string; tags: Record<string, string> }): string {
  const raw = [r.name, r.path, ...Object.values(r.tags)].join(" ").toLowerCase();
  // Keep both spaced and joined forms so "darkangels" and "dark angels" both hit.
  return `${raw} ${raw.replace(/[^a-z0-9]+/g, "")}`;
}

export function upsertRows(generation: string, rows: z.infer<typeof rowSchema>[]) {
  const d = driveFilesDb();
  const stmt = d.prepare(`INSERT INTO drive_files (id,name,category,path,parent,size,modified_time,web_view_link,mime_type,tags,thumb_source,thumb_key,web_source_url,search,generation)
    VALUES (@id,@name,@category,@path,@parent,@size,@modifiedTime,@webViewLink,@mimeType,@tags,@thumbSource,@thumbKey,@webSourceUrl,@search,@generation)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, path=excluded.path, parent=excluded.parent,
      size=excluded.size, modified_time=excluded.modified_time, web_view_link=excluded.web_view_link, mime_type=excluded.mime_type,
      tags=excluded.tags, thumb_source=excluded.thumb_source, thumb_key=excluded.thumb_key, web_source_url=excluded.web_source_url,
      search=excluded.search, generation=excluded.generation`);
  const tx = d.transaction((items: typeof rows) => {
    for (const r of items) {
      stmt.run({
        ...r,
        parent: r.parent ?? null,
        size: r.size ?? null,
        modifiedTime: r.modifiedTime ?? null,
        webViewLink: r.webViewLink ?? null,
        mimeType: r.mimeType ?? null,
        tags: JSON.stringify(r.tags ?? {}),
        thumbKey: r.thumbKey ?? null,
        webSourceUrl: r.webSourceUrl ?? null,
        search: searchBlob(r),
        generation,
      });
    }
  });
  tx(rows);
}

export function commitGeneration(generation: string, generatedAt?: string) {
  const d = driveFilesDb();
  const seen = (d.prepare("SELECT COUNT(*) n FROM drive_files WHERE generation = ?").get(generation) as { n: number }).n;
  // Never wipe the index on an empty/aborted push.
  if (seen === 0) return { kept: 0, removed: 0, skipped: true };
  const removed = d.prepare("DELETE FROM drive_files WHERE generation <> ?").run(generation).changes;
  const orphanThumbs = d
    .prepare("DELETE FROM drive_thumbs WHERE key NOT IN (SELECT thumb_key FROM drive_files WHERE thumb_key IS NOT NULL)")
    .run().changes;
  d.prepare("INSERT INTO drive_files_meta (k,v) VALUES ('generatedAt', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
    generatedAt || new Date().toISOString(),
  );
  return { kept: seen, removed, orphanThumbs, skipped: false };
}

type Row = {
  id: string; name: string; category: DriveFileCategory; path: string; size: number | null; modified_time: string | null;
  web_view_link: string | null; mime_type: string | null; tags: string; thumb_source: DriveThumbSource; thumb_key: string | null;
  web_source_url: string | null; tmime: string | null; tdata: Buffer | null;
};

const CAT_RANK = "CASE category WHEN 'folder' THEN 0 WHEN 'model' THEN 1 WHEN 'archive' THEN 2 WHEN 'sliced' THEN 3 WHEN 'photo' THEN 4 ELSE 5 END";

export function searchFiles(opts: { q: string; category: DriveFileCategory | null; offset: number; limit: number }): DriveFilesResponse {
  const d = driveFilesDb();
  const tokens = queryTokens(opts.q);
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  tokens.forEach((t, i) => {
    where.push(`search LIKE @t${i} ESCAPE '\\'`);
    args[`t${i}`] = `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  });
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countRows = d.prepare(`SELECT category, COUNT(*) n FROM drive_files ${base} GROUP BY category`).all(args) as Array<{ category: DriveFileCategory; n: number }>;
  const counts: DriveFilesResponse["counts"] = {};
  for (const c of countRows) counts[c.category] = c.n;
  const catClause = opts.category ? `${base ? `${base} AND` : "WHERE"} category = @cat` : base;
  if (opts.category) args.cat = opts.category;
  const total = opts.category ? counts[opts.category] ?? 0 : countRows.reduce((s, c) => s + c.n, 0);
  // Name hits first, then things with a real picture, then folders/models before loose files.
  const nameHits = tokens.length ? tokens.map((_, i) => `(lower(name) LIKE @t${i} ESCAPE '\\')`).join(" + ") : "(0 = 0)";
  const rows = d
    .prepare(
      `SELECT f.*, t.mime tmime, t.data tdata FROM drive_files f LEFT JOIN drive_thumbs t ON t.key = f.thumb_key
       ${catClause.replace(/\bsearch\b/g, "f.search").replace(/\bcategory\b/g, "f.category")}
       ORDER BY (${nameHits}) DESC, (f.thumb_source <> 'icon') DESC, ${CAT_RANK.replace("category", "f.category")}, f.modified_time DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...args, limit: opts.limit, offset: opts.offset }) as Row[];
  const generatedAt =
    (d.prepare("SELECT v FROM drive_files_meta WHERE k='generatedAt'").get() as { v: string } | undefined)?.v ?? null;
  return {
    ok: true,
    q: opts.q,
    category: opts.category,
    total,
    offset: opts.offset,
    counts,
    generatedAt,
    configured: generatedAt !== null,
    items: rows.map(toView),
  };
}

function toView(r: Row): DriveFileView {
  let tags: Record<string, string> = {};
  try {
    tags = JSON.parse(r.tags) as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    path: r.path,
    size: r.size,
    modifiedTime: r.modified_time,
    webViewLink: r.web_view_link,
    mimeType: r.mime_type,
    tags,
    thumbSource: r.thumb_source,
    thumb: r.tdata && r.tmime ? `data:${r.tmime};base64,${Buffer.from(r.tdata).toString("base64")}` : null,
    webSourceUrl: r.web_source_url,
  };
}

const readQuery = z.object({
  q: z.string().max(200).default(""),
  cat: z.enum(DRIVE_FILE_CATEGORIES).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(60).default(36),
});

export function registerDriveFilesRoutes(
  app: Express,
  rejectOwner: (req: Request, res: Response) => boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  app.get("/api/files", (req, res) => {
    res.set("cache-control", "no-store");
    if (rejectOwner(req, res)) return;
    const parsed = readQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "bad query" });
    const { q, cat, offset, limit } = parsed.data;
    res.json(searchFiles({ q, category: cat ?? null, offset, limit }));
  });

  app.get("/api/ops/files/sync/thumbs", (req, res) => {
    if (rejectFilesSync(req, res, env)) return;
    const rows = driveFilesDb().prepare("SELECT key, sha FROM drive_thumbs").all() as Array<{ key: string; sha: string }>;
    res.json({ ok: true, keys: Object.fromEntries(rows.map((r) => [r.key, r.sha])) });
  });

  app.post("/api/ops/files/sync/thumbs", (req, res) => {
    if (rejectFilesSync(req, res, env)) return;
    const parsed = thumbsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "bad thumbs payload" });
    const d = driveFilesDb();
    const stmt = d.prepare(
      "INSERT INTO drive_thumbs (key,sha,mime,data) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET sha=excluded.sha, mime=excluded.mime, data=excluded.data",
    );
    let stored = 0;
    d.transaction(() => {
      for (const t of parsed.data.thumbs) {
        const buf = Buffer.from(t.data, "base64");
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        if (!(isJpeg || isPng) || buf.length > 150_000) continue;
        stmt.run(t.key, t.sha, isPng ? "image/png" : "image/jpeg", buf);
        stored++;
      }
    })();
    res.json({ ok: true, stored });
  });

  app.post("/api/ops/files/sync/rows", (req, res) => {
    if (rejectFilesSync(req, res, env)) return;
    const parsed = rowsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "bad rows payload", issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`) });
    upsertRows(parsed.data.generation, parsed.data.rows);
    res.json({ ok: true, upserted: parsed.data.rows.length });
  });

  app.post("/api/ops/files/sync/commit", (req, res) => {
    if (rejectFilesSync(req, res, env)) return;
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "bad commit payload" });
    res.json({ ok: true, ...commitGeneration(parsed.data.generation, parsed.data.generatedAt) });
  });
}
