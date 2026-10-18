import test from "node:test";
import assert from "node:assert/strict";
import express, { type Request, type Response } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DRIVE_FILES_DB_FILE = ":memory:";
const { registerDriveFilesRoutes, resetDriveFilesDbForTests, searchBlob } = await import("../server/lib/drive-files");

const TOKEN = "files-sync-token-for-tests-0123456789";
const OWNER = "owner-ok";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

function server(env: NodeJS.ProcessEnv = { FILES_SYNC_TOKEN: TOKEN }) {
  resetDriveFilesDbForTests();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const rejectOwner = (req: Request, res: Response) => {
    if (req.get("x-paid-order-access-code") === OWNER) return false;
    res.status(401).json({ ok: false });
    return true;
  };
  registerDriveFilesRoutes(app, rejectOwner, env);
  const s = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, init);
    if (process.env.DEBUG_FILES && !(r.headers.get("content-type") ?? "").includes("json")) console.error("NONJSON", r.status, path, (await r.clone().text()).slice(0, 200));
    return r;
  };
  const sync = (path: string, body?: unknown) =>
    call(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const owner = (path: string) => call(path, { headers: { "x-paid-order-access-code": OWNER } });
  return { s, call, sync, owner };
}

const rows = [
  { id: "f1", name: "Dark_Angels_DW_Torso.stl", category: "model", path: "Sources/Angeles Oscuros", parent: "d1", size: 1200, modifiedTime: "2026-01-01T00:00:00Z", webViewLink: "https://drive.google.com/file/d/f1/view", tags: { faction: "Dark Angels" }, thumbSource: "folder-photo", thumbKey: "p1.jpg" },
  { id: "d1", name: "Angeles Oscuros", category: "folder", path: "Sources", webViewLink: "https://drive.google.com/drive/folders/d1", tags: {}, thumbSource: "folder-photo", thumbKey: "p1.jpg" },
  { id: "p1", name: "render front.jpg", category: "photo", path: "Sources/Angeles Oscuros", parent: "d1", webViewLink: "https://drive.google.com/file/d/p1/view", tags: {}, thumbSource: "drive", thumbKey: "p1.jpg" },
  { id: "x9", name: "Leman Russ hull.stl", category: "model", path: "Client job/Leman Russ", tags: {}, thumbSource: "icon" },
];

test("sync is disabled without FILES_SYNC_TOKEN and rejects a wrong token", async () => {
  const a = server({});
  try {
    assert.equal((await a.sync("/api/ops/files/sync/thumbs")).status, 503);
  } finally {
    a.s.close();
  }
  const b = server();
  try {
    const r = await b.call("/api/ops/files/sync/rows", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
  } finally {
    b.s.close();
  }
});

test("read route needs the owner code", async () => {
  const a = server();
  try {
    assert.equal((await a.call("/api/files?q=dark")).status, 401);
  } finally {
    a.s.close();
  }
});

test("sync rows + thumbs, AND search, category filter, inline thumbs, commit drops stale rows", async () => {
  const a = server();
  try {
    const thumbs = [
      { key: "p1.jpg", sha: "abcdef12", mime: "image/jpeg", data: JPEG },
      { key: "bad.jpg", sha: "abcdef12", mime: "image/jpeg", data: Buffer.from("not an image").toString("base64") },
    ];
    const stored = await (await a.sync("/api/ops/files/sync/thumbs", { thumbs })).json();
    assert.equal(stored.stored, 1);
    const have = await (await a.sync("/api/ops/files/sync/thumbs")).json();
    assert.deepEqual(have.keys, { "p1.jpg": "abcdef12" });
    const up = await a.sync("/api/ops/files/sync/rows", { generation: "gen-1", rows });
    assert.equal(up.status, 200, await up.clone().text());
    assert.equal((await (await a.sync("/api/ops/files/sync/commit", { generation: "gen-1", generatedAt: "2026-10-18T10:20:00Z" })).json()).removed, 0);

    const r = await (await a.owner("/api/files?q=dark%20angels%20torso")).json();
    assert.equal(r.total, 1);
    assert.equal(r.items[0].id, "f1");
    assert.match(r.items[0].thumb, /^data:image\/jpeg;base64,/);
    assert.equal(r.generatedAt, "2026-10-18T10:20:00Z");

    const joined = await (await a.owner("/api/files?q=darkangels")).json();
    assert.equal(joined.total, 1);

    const all = await (await a.owner("/api/files?q=oscuros")).json();
    assert.equal(all.counts.folder, 1);
    const onlyFolders = await (await a.owner("/api/files?q=oscuros&cat=folder")).json();
    assert.deepEqual(onlyFolders.items.map((i: { id: string }) => i.id), ["d1"]);

    const iconOnly = await (await a.owner("/api/files?q=leman")).json();
    assert.equal(iconOnly.items[0].thumb, null);

    // empty generation never wipes the index
    assert.equal((await (await a.sync("/api/ops/files/sync/commit", { generation: "g-empty" })).json()).skipped, true);
    assert.equal((await (await a.owner("/api/files")).json()).total, 4);

    // next generation without x9 removes it
    await a.sync("/api/ops/files/sync/rows", { generation: "gen-2", rows: rows.slice(0, 3) });
    assert.equal((await (await a.sync("/api/ops/files/sync/commit", { generation: "gen-2" })).json()).removed, 1);
    assert.equal((await (await a.owner("/api/files?q=leman")).json()).total, 0);
  } finally {
    a.s.close();
  }
});

test("rows with non-Drive links or bad ids are refused", async () => {
  const a = server();
  try {
    const bad = await a.sync("/api/ops/files/sync/rows", { generation: "gen-1", rows: [{ ...rows[0], webViewLink: "https://evil.example/x" }] });
    assert.equal(bad.status, 400);
    const badId = await a.sync("/api/ops/files/sync/rows", { generation: "gen-1", rows: [{ ...rows[0], id: "../../etc" }] });
    assert.equal(badId.status, 400);
  } finally {
    a.s.close();
  }
});

test("searchBlob keeps a joined form of name and path", () => {
  assert.match(searchBlob({ name: "Dark_Angels", path: "A/B", tags: {} }), /darkangels/);
});

const shopRows = [
  { id: "sd_kit1", source: "shop", name: "Chubby Pattern Ground Plunderer Mk2B - Bum-Fluff", category: "folder", path: "X:", size: 9_000_000, tags: { drive: "X:", files: "42 files" }, keywords: "side door steps magnet", thumbSource: "icon" },
  { id: "sd_doors", source: "shop", name: "Doors", category: "folder", path: "X:/Land Raider Ares/Bum Fluff", tags: { drive: "X:" }, keywords: "ground plunderer side door with steps", thumbSource: "icon" },
  { id: "sd_zip1", source: "shop", name: "grimdark_ground_plunderer_doors_for_the_20th_legion.zip", category: "archive", path: "X:", size: 1000, tags: { drive: "X:" }, thumbSource: "icon" },
  { id: "sd_other", source: "shop", name: "Heavy Intercessors", category: "folder", path: "Z:/Space Marines", tags: { drive: "Z:" }, thumbSource: "icon" },
];
const driveRows = [
  { id: "dg1", name: "Land Raider_S.P.R.U.E.+Ground+Pluderer+r", category: "folder", path: "Sources/Land Raider", webViewLink: "https://drive.google.com/drive/folders/dg1", tags: {}, thumbSource: "icon" },
  { id: "dg2", name: "Leman Russ hull.stl", category: "model", path: "Leman Russ", tags: {}, thumbSource: "icon" },
];

async function seeded() {
  const a = server();
  await a.sync("/api/ops/files/sync/rows", { generation: "gen-d1", rows: driveRows });
  await a.sync("/api/ops/files/sync/commit", { generation: "gen-d1" });
  const up = await a.sync("/api/ops/files/sync/rows", { generation: "gen-s1", rows: shopRows });
  assert.equal(up.status, 200, await up.clone().text());
  await a.sync("/api/ops/files/sync/commit", { generation: "gen-s1", source: "shop" });
  return a;
}
const ids = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id);

test("shop-drive source: separate commit, source filter + counts, keywords searchable but not returned", async () => {
  const a = await seeded();
  try {
    assert.deepEqual((await (await a.sync("/api/ops/files/sync/sources")).json()).sources, ["drive", "shop"]);
    const r = await (await a.owner("/api/files?q=ground%20plunderer")).json();
    assert.ok(ids(r).includes("sd_kit1") && ids(r).includes("sd_zip1") && ids(r).includes("sd_doors"));
    assert.equal(r.sources.shop, 3);
    assert.equal(r.items[0].id, "sd_kit1"); // folder name hit first
    assert.equal(r.items[0].source, "shop");
    assert.equal(r.items[0].keywords, undefined);
    const onlyShop = await (await a.owner("/api/files?q=heavy%20intercessors&src=drive")).json();
    assert.equal(onlyShop.total, 0);
    // a Drive commit never drops shop rows
    await a.sync("/api/ops/files/sync/rows", { generation: "gen-d2", rows: driveRows.slice(0, 1) });
    assert.equal((await (await a.sync("/api/ops/files/sync/commit", { generation: "gen-d2" })).json()).removed, 1);
    assert.equal((await (await a.owner("/api/files?q=plunderer&src=shop")).json()).total, 3);
  } finally {
    a.s.close();
  }
});

test("forgiving search: separators, camelCase, word order, joined words, typos, short words", async () => {
  const a = await seeded();
  try {
    for (const q of ["ground_plunderer", "Ground-Plunderer", "plunderer ground", "GroundPlunderer", "groundplunderer", "PLUNDERER"]) {
      const r = await (await a.owner(`/api/files?q=${encodeURIComponent(q)}`)).json();
      assert.ok(ids(r).includes("sd_kit1"), `${q} -> ${ids(r)}`);
    }
    // typo: no exact hit, close spellings returned and flagged
    const typo = await (await a.owner("/api/files?q=grund%20plundrer")).json();
    assert.equal(typo.exactTotal, 0);
    assert.equal(typo.fuzzy, true);
    assert.ok(ids(typo).includes("sd_kit1"));
    // data typo ("Pluderer") still reachable when exact hits are scarce
    const drv = await (await a.owner("/api/files?q=ground%20plunderer&src=drive")).json();
    assert.ok(drv.fuzzy);
    // prefix + file-name keywords inside a folder
    const pre = await (await a.owner("/api/files?q=plund%20side%20door")).json();
    assert.ok(ids(pre).includes("sd_doors"));
    // letter+digit runs stay whole and hit the squashed name; 2-letter words use word-start matching (no FTS)
    const mk = await (await a.owner("/api/files?q=mk2b")).json();
    assert.deepEqual(ids(mk), ["sd_kit1"]);
    const two = await (await a.owner("/api/files?q=mk%20chubby")).json();
    assert.deepEqual(ids(two), ["sd_kit1"]);
    const lr = await (await a.owner("/api/files?q=russ%20leman")).json();
    assert.equal(lr.items[0].id, "dg2");
  } finally {
    a.s.close();
  }
});

test("rows from the #265 schema are migrated and indexed on open", async () => {
  const Database = (await import("better-sqlite3")).default;
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dfm-")), "drive-files.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE drive_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', parent TEXT, size INTEGER,
    modified_time TEXT, web_view_link TEXT, mime_type TEXT, tags TEXT NOT NULL DEFAULT '{}', thumb_source TEXT NOT NULL DEFAULT 'icon', thumb_key TEXT,
    web_source_url TEXT, search TEXT NOT NULL DEFAULT '', generation TEXT NOT NULL);
    CREATE TABLE drive_files_meta (k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO drive_files (id,name,category,path,search,generation) VALUES ('h1','HeavyIntercessors','folder','Space Marines','heavyintercessors space marines','g1');
    INSERT INTO drive_files_meta VALUES ('generatedAt','2026-10-17T00:00:00Z');`);
  old.close();
  const prev = process.env.DRIVE_FILES_DB_FILE;
  process.env.DRIVE_FILES_DB_FILE = file;
  const mod = await import("../server/lib/drive-files");
  mod.resetDriveFilesDbForTests();
  try {
    const r = mod.searchFiles({ q: "heavy intercessors", category: null, offset: 0, limit: 10 });
    assert.deepEqual(r.items.map((i) => i.id), ["h1"]);
    assert.equal(r.items[0].source, "drive");
  } finally {
    mod.resetDriveFilesDbForTests();
    process.env.DRIVE_FILES_DB_FILE = prev;
  }
});
