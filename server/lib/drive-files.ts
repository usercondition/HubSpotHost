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
 * Two sources share the table: source='drive' (Google Drive, above) and source='shop' (the X:/Y:/Z: shop JBOD drives,
 * pushed by ~/.hermes/scripts/shop_files_sync.py from the Mac's nightly ~/.drive-index/files.tsv: folders + archives
 * with the same privacy filter and client-name mask). Commit only replaces rows of the source being committed.
 *
 * Search: normalized text (case, _ - . +, camelCase) in an FTS5 trigram index (substring/prefix, any word order,
 * AND across name + folder path). When exact matches are scarce it adds close matches: typo variants from the
 * index vocabulary (edit distance 1-2) and joined words split ("groundplunderer" -> ground + plunderer).
 *
 * Read: GET /api/files?q=&cat=&src=&offset=&limit= behind the normal Print Ops owner code. Thumbnails are
 * returned inline as data: URLs so <img> never needs a separate unauthenticated route.
 * Read-only toward Drive: links only (Open in Drive / Download / Share link); nothing is moved or shared.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { fuzzyVariants, normalizeText, searchTokens, splitJoined } from "../../shared/file-search";
import {
  DRIVE_FILE_CATEGORIES,
  DRIVE_FILE_SOURCES,
  type DriveFileSource,
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

/** Columns added after #265; applied idempotently on open. */
const ADDED_COLUMNS: Array<[string, string]> = [
  ["source", "TEXT NOT NULL DEFAULT 'drive'"],
  ["name_norm", "TEXT NOT NULL DEFAULT ''"],
  ["keywords", "TEXT NOT NULL DEFAULT ''"],
];

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS drive_files_fts USING fts5(search, content='drive_files', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS drive_files_ai AFTER INSERT ON drive_files BEGIN
  INSERT INTO drive_files_fts(rowid, search) VALUES (new.rowid, new.search);
END;
CREATE TRIGGER IF NOT EXISTS drive_files_ad AFTER DELETE ON drive_files BEGIN
  INSERT INTO drive_files_fts(drive_files_fts, rowid, search) VALUES ('delete', old.rowid, old.search);
END;
CREATE TRIGGER IF NOT EXISTS drive_files_au AFTER UPDATE OF search ON drive_files BEGIN
  INSERT INTO drive_files_fts(drive_files_fts, rowid, search) VALUES ('delete', old.rowid, old.search);
  INSERT INTO drive_files_fts(rowid, search) VALUES (new.rowid, new.search);
END;
CREATE INDEX IF NOT EXISTS drive_files_src ON drive_files(source);
`;
const SEARCH_VERSION = "2";

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
  migrate(sqlite);
  return sqlite;
}

function migrate(d: Database.Database) {
  const have = new Set((d.prepare("PRAGMA table_info(drive_files)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [col, def] of ADDED_COLUMNS) if (!have.has(col)) d.exec(`ALTER TABLE drive_files ADD COLUMN ${col} ${def}`);
  const ver = (d.prepare("SELECT v FROM drive_files_meta WHERE k='searchVersion'").get() as { v: string } | undefined)?.v;
  if (ver === SEARCH_VERSION) {
    d.exec(FTS);
    return;
  }
  // One-time: re-normalize rows synced by older code, then build the trigram index from the table. The FTS table and
  // its triggers are dropped first: an external-content 'delete' of values the index never saw corrupts it.
  d.exec(`DROP TRIGGER IF EXISTS drive_files_ai; DROP TRIGGER IF EXISTS drive_files_ad; DROP TRIGGER IF EXISTS drive_files_au;
    DROP TABLE IF EXISTS drive_files_fts;`);
  const rows = d.prepare("SELECT rowid, name, path, tags, keywords FROM drive_files").all() as Array<{ rowid: number; name: string; path: string; tags: string; keywords: string }>;
  const upd = d.prepare("UPDATE drive_files SET search = ?, name_norm = ? WHERE rowid = ?");
  d.transaction(() => {
    for (const r of rows) {
      let tags: Record<string, string> = {};
      try {
        tags = JSON.parse(r.tags) as Record<string, string>;
      } catch {
        /* ignore */
      }
      upd.run(searchBlob({ name: r.name, path: r.path, tags, keywords: r.keywords }), normalizeText(r.name), r.rowid);
    }
    d.exec(FTS);
    d.exec("INSERT INTO drive_files_fts(drive_files_fts) VALUES ('rebuild')");
    d.prepare("INSERT INTO drive_files_meta (k,v) VALUES ('searchVersion', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(SEARCH_VERSION);
  })();
}

/** Test hook. */
export function resetDriveFilesDbForTests() {
  sqlite?.close();
  sqlite = null;
  vocabCache = null;
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
  source: z.enum(DRIVE_FILE_SOURCES).default("drive"),
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
  /** Search-only words (shop folders: names of the files inside). Never returned to the client. */
  keywords: z.string().max(2000).default(""),
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
const commitSchema = z.object({
  generation: z.string().min(4).max(40),
  generatedAt: z.string().max(40).optional(),
  source: z.enum(DRIVE_FILE_SOURCES).default("drive"),
});

/** Tag keys that are display facts, not search words. */
const NON_SEARCH_TAGS = new Set(["files", "types", "drive"]);

/**
 * Normalized search text: name | folder path | tags | keywords. Name and path are also kept squashed (no spaces)
 * so a query typed joined ("darkangels") hits "Dark_Angels" by substring.
 */
export function searchBlob(r: { name: string; path: string; tags: Record<string, string>; keywords?: string }): string {
  const tagText = Object.entries(r.tags)
    .filter(([k]) => !NON_SEARCH_TAGS.has(k))
    .map(([, v]) => v)
    .join(" ");
  const name = normalizeText(r.name);
  const pathText = normalizeText(r.path);
  const squash = (t: string) => t.replace(/ /g, "");
  return [name, pathText, normalizeText(tagText), normalizeText(r.keywords ?? ""), `${squash(name)} ${squash(pathText)}`]
    .filter(Boolean)
    .join(" | ");
}

export function upsertRows(generation: string, rows: z.infer<typeof rowSchema>[]) {
  const d = driveFilesDb();
  const stmt = d.prepare(`INSERT INTO drive_files (id,source,name,name_norm,keywords,category,path,parent,size,modified_time,web_view_link,mime_type,tags,thumb_source,thumb_key,web_source_url,search,generation)
    VALUES (@id,@source,@name,@nameNorm,@keywords,@category,@path,@parent,@size,@modifiedTime,@webViewLink,@mimeType,@tags,@thumbSource,@thumbKey,@webSourceUrl,@search,@generation)
    ON CONFLICT(id) DO UPDATE SET source=excluded.source, name=excluded.name, name_norm=excluded.name_norm, keywords=excluded.keywords, category=excluded.category, path=excluded.path, parent=excluded.parent,
      size=excluded.size, modified_time=excluded.modified_time, web_view_link=excluded.web_view_link, mime_type=excluded.mime_type,
      tags=excluded.tags, thumb_source=excluded.thumb_source, thumb_key=excluded.thumb_key, web_source_url=excluded.web_source_url,
      search=excluded.search, generation=excluded.generation`);
  const tx = d.transaction((items: typeof rows) => {
    for (const r of items) {
      stmt.run({
        ...r,
        source: r.source ?? "drive",
        nameNorm: normalizeText(r.name),
        keywords: r.keywords ?? "",
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
  vocabCache = null;
}

export function commitGeneration(generation: string, generatedAt?: string, source: DriveFileSource = "drive") {
  const d = driveFilesDb();
  const seen = (d.prepare("SELECT COUNT(*) n FROM drive_files WHERE generation = ? AND source = ?").get(generation, source) as { n: number }).n;
  // Never wipe the index on an empty/aborted push.
  if (seen === 0) return { kept: 0, removed: 0, skipped: true };
  // Only this source's stale rows: a Drive push never removes shop-drive rows and vice versa.
  const removed = d.prepare("DELETE FROM drive_files WHERE generation <> ? AND source = ?").run(generation, source).changes;
  vocabCache = null;
  const orphanThumbs = d
    .prepare("DELETE FROM drive_thumbs WHERE key NOT IN (SELECT thumb_key FROM drive_files WHERE thumb_key IS NOT NULL)")
    .run().changes;
  const metaKey = source === "drive" ? "generatedAt" : `generatedAt:${source}`;
  d.prepare("INSERT INTO drive_files_meta (k,v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(
    metaKey,
    generatedAt || new Date().toISOString(),
  );
  // Warm the typo vocabulary off the request path so the first close-match search after a sync stays fast.
  setImmediate(() => {
    try {
      searchVocab();
    } catch {
      /* next search builds it */
    }
  });
  return { kept: seen, removed, orphanThumbs, skipped: false };
}

type Row = {
  id: string; source: string; name: string; category: DriveFileCategory; path: string; size: number | null; modified_time: string | null;
  web_view_link: string | null; mime_type: string | null; tags: string; thumb_source: DriveThumbSource; thumb_key: string | null;
  web_source_url: string | null; tmime: string | null; tdata: Buffer | null;
};

const CAT_BOOST = "CASE f.category WHEN 'folder' THEN 10 WHEN 'archive' THEN 6 WHEN 'model' THEN 4 WHEN 'sliced' THEN 2 ELSE 0 END";
/** Below this many exact hits the search also returns close (typo / joined-word) matches, ranked after exact ones. */
export const FUZZY_MIN_EXACT = 12;

let vocabCache: Map<string, number> | null = null;

/** Word -> number of rows using it (names, folder paths, keywords). Rebuilt lazily after each sync batch. */
export function searchVocab(): Map<string, number> {
  if (vocabCache) return vocabCache;
  const m = new Map<string, number>();
  const it = driveFilesDb().prepare("SELECT name_norm, path, keywords FROM drive_files").iterate() as IterableIterator<{ name_norm: string; path: string; keywords: string }>;
  for (const r of it) {
    const words = new Set(`${r.name_norm} ${normalizeText(r.path)} ${normalizeText(r.keywords)}`.split(" "));
    for (const w of words) if (w.length >= 3 && !/^\d+$/.test(w)) m.set(w, (m.get(w) ?? 0) + 1);
  }
  vocabCache = m;
  return m;
}

type Term = { token: string; alts: string[][] };

/** FTS5 trigram needs >= 3 chars; shorter words fall back to a word-start LIKE on the search column. */
function termSql(alts: string[][], args: Record<string, unknown>, key: string): { fts: string | null; like: string | null } {
  const ftsAlts: string[] = [];
  const likeAlts: string[] = [];
  alts.forEach((words, ai) => {
    if (words.every((w) => w.length >= 3)) ftsAlts.push(words.length === 1 ? `"${words[0]}"` : `(${words.map((w) => `"${w}"`).join(" AND ")})`);
    else {
      likeAlts.push(
        `(${words
          .map((w, wi) => {
            const k = `${key}_${ai}_${wi}`;
            args[k] = `% ${w}%`;
            return `(' ' || f.search) LIKE @${k}`;
          })
          .join(" AND ")})`,
      );
    }
  });
  return { fts: ftsAlts.length ? `(${ftsAlts.join(" OR ")})` : null, like: likeAlts.length ? likeAlts.join(" OR ") : null };
}

/** WHERE fragment matching every term (any order) on name + folder path + tags + keywords. */
function matchWhere(terms: Term[], args: Record<string, unknown>, key: string): string {
  const fts: string[] = [];
  const parts: string[] = [];
  terms.forEach((t, i) => {
    const s = termSql(t.alts, args, `${key}${i}`);
    if (s.fts && s.like) parts.push(`(f.rowid IN (SELECT rowid FROM drive_files_fts WHERE drive_files_fts MATCH @${key}m${i}) OR ${s.like})`), (args[`${key}m${i}`] = s.fts);
    else if (s.fts) fts.push(s.fts);
    else if (s.like) parts.push(`(${s.like})`);
  });
  if (fts.length) {
    args[`${key}m`] = fts.join(" AND ");
    parts.unshift(`f.rowid IN (SELECT rowid FROM drive_files_fts WHERE drive_files_fts MATCH @${key}m)`);
  }
  return parts.join(" AND ");
}

export function searchFiles(opts: {
  q: string;
  category: DriveFileCategory | null;
  source?: DriveFileSource | null;
  offset: number;
  limit: number;
}): DriveFilesResponse {
  const d = driveFilesDb();
  const tokens = searchTokens(opts.q);
  const args: Record<string, unknown> = {};
  const strictTerms: Term[] = tokens.map((t) => ({ token: t, alts: [[t]] }));
  let where = tokens.length ? matchWhere(strictTerms, args, "s") : "";
  const countExact = () =>
    (d.prepare(`SELECT COUNT(*) n FROM drive_files f ${where ? `WHERE ${where}` : ""}`).get(args) as { n: number }).n;
  const exactTotal = tokens.length ? countExact() : 0;
  let fuzzy = false;
  let rankTerms = strictTerms;
  const strictWhere = where;
  if (tokens.length && exactTotal < FUZZY_MIN_EXACT) {
    const vocab = searchVocab();
    const loose: Term[] = tokens.map((t) => {
      const alts: string[][] = [[t]];
      const split = splitJoined(t, vocab);
      if (split) alts.push(split);
      for (const v of fuzzyVariants(t, vocab)) alts.push([v]);
      return { token: t, alts };
    });
    if (loose.some((t) => t.alts.length > 1)) {
      where = matchWhere(loose, args, "z");
      fuzzy = true;
      rankTerms = loose;
    }
  }

  const base = where ? `WHERE ${where}` : "";
  const srcCountRows = d.prepare(`SELECT f.source, COUNT(*) n FROM drive_files f ${base} GROUP BY f.source`).all(args) as Array<{ source: DriveFileSource; n: number }>;
  const sources: DriveFilesResponse["sources"] = {};
  for (const c of srcCountRows) sources[c.source] = c.n;
  const srcArgs = { ...args };
  let srcWhere = base;
  if (opts.source) {
    srcWhere = `${base ? `${base} AND` : "WHERE"} f.source = @src`;
    srcArgs.src = opts.source;
  }
  const countRows = d.prepare(`SELECT f.category, COUNT(*) n FROM drive_files f ${srcWhere} GROUP BY f.category`).all(srcArgs) as Array<{ category: DriveFileCategory; n: number }>;
  const counts: DriveFilesResponse["counts"] = {};
  for (const c of countRows) counts[c.category] = c.n;
  const catWhere = opts.category ? `${srcWhere ? `${srcWhere} AND` : "WHERE"} f.category = @cat` : srcWhere;
  if (opts.category) srcArgs.cat = opts.category;
  const total = opts.category ? counts[opts.category] ?? 0 : countRows.reduce((s, c) => s + c.n, 0);

  // Ranking: exact before close matches; whole-name match > name starts with query > words starting in the name >
  // words anywhere in the name > folder path only; folders/kits and archives before loose files; real pictures first.
  const phrase = tokens.join(" ");
  srcArgs.phrase = phrase;
  srcArgs.phrasePrefix = `${phrase}%`;
  // Per query word: 12 when a word of the name starts with it (or a close spelling of it), 6 when the name contains it
  // anywhere, including joined ("groundplunderer" inside "Ground Plunderer").
  const nameScore = rankTerms
    .map((t, i) => {
      const starts: string[] = [];
      const inside: string[] = [];
      t.alts.forEach((words, ai) => {
        const ws = words.map((w, wi) => {
          srcArgs[`nw${i}_${ai}_${wi}`] = `% ${w}%`;
          return `(' ' || f.name_norm) LIKE @nw${i}_${ai}_${wi}`;
        });
        starts.push(`(${ws.join(" AND ")})`);
        srcArgs[`nc${i}_${ai}`] = `%${words.join("")}%`;
        inside.push(`replace(f.name_norm, ' ', '') LIKE @nc${i}_${ai}`);
      });
      return `(CASE WHEN ${starts.join(" OR ")} THEN 12 WHEN ${inside.join(" OR ")} THEN 6 ELSE 0 END)`;
    })
    .join(" + ");
  const exactBoost = fuzzy && strictWhere ? `(CASE WHEN ${strictWhere} THEN 200 ELSE 0 END)` : "0";
  const score = tokens.length
    ? `${exactBoost} + (CASE WHEN f.name_norm = @phrase THEN 100 WHEN f.name_norm LIKE @phrasePrefix THEN 50 ELSE 0 END) + ${nameScore} + ${CAT_BOOST} + (CASE WHEN f.thumb_source <> 'icon' THEN 3 ELSE 0 END)`
    : `${CAT_BOOST} + (CASE WHEN f.thumb_source <> 'icon' THEN 3 ELSE 0 END)`;
  const rows = d
    .prepare(
      `SELECT f.*, t.mime tmime, t.data tdata FROM drive_files f LEFT JOIN drive_thumbs t ON t.key = f.thumb_key
       ${catWhere}
       ORDER BY (${score}) DESC, f.modified_time DESC, f.name
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...srcArgs, limit: opts.limit, offset: opts.offset }) as Row[];
  const meta = (k: string) => (d.prepare("SELECT v FROM drive_files_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v ?? null;
  const generatedAt = meta("generatedAt");
  const generatedAtShop = meta("generatedAt:shop");
  return {
    ok: true,
    q: opts.q,
    category: opts.category,
    source: opts.source ?? null,
    total,
    exactTotal: tokens.length ? exactTotal : total,
    fuzzy,
    offset: opts.offset,
    counts,
    sources,
    generatedAt,
    generatedAtShop,
    configured: generatedAt !== null || generatedAtShop !== null,
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
    source: r.source === "shop" ? "shop" : "drive",
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
  src: z.enum(DRIVE_FILE_SOURCES).optional().catch(undefined),
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
    const { q, cat, src, offset, limit } = parsed.data;
    res.json(searchFiles({ q, category: cat ?? null, source: src ?? null, offset, limit }));
  });

  // Capability probe for the Mac sync scripts: an older server (404 here) would silently drop `source`.
  app.get("/api/ops/files/sync/sources", (req, res) => {
    if (rejectFilesSync(req, res, env)) return;
    res.json({ ok: true, sources: DRIVE_FILE_SOURCES });
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
    res.json({ ok: true, ...commitGeneration(parsed.data.generation, parsed.data.generatedAt, parsed.data.source) });
  });
}
