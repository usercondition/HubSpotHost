import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "library-drive-"));
process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
process.env.DRIVE_FILES_DB_FILE = ":memory:";
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("lib-owner", "utf8").digest("hex");

const { resetOrderLinkStore, getSqlite } = await import("../server/lib/order-links");
const { upsertRows, commitGeneration, resetDriveFilesDbForTests, driveFilesDb } = await import("../server/lib/drive-files");
const { upsertPlateFiles, listPlateFiles, getPlateFile, listPlateIdsNeedingMesh, linkPlateFile, savePlatePreview } = await import("../server/lib/plate-files");
const { reconcileLibraryDrive, readLibraryDriveRows, libraryDriveStatus, subfolderOf, resetLibraryDriveThrottleForTests } = await import(
  "../server/lib/library-drive"
);
const { registerPlateLibraryRoutes } = await import("../server/lib/plate-routes");
const { libraryDedupeKey, maskLibraryClientText } = await import("../shared/plate-files");

const FOLDER = "1MnLB0U8mm-rVrmtxposF-GWI3LJG6kui";
const ROOT = "Chitubox Sliced files";
const SHA = "a".repeat(64);

type Row = Parameters<typeof upsertRows>[1][number];
function row(id: string, name: string, size: number | null, extra: Partial<Row> = {}): Row {
  return {
    id,
    name,
    category: name.endsWith(".stl") ? "model" : name.endsWith(".ctb") ? "sliced" : "photo",
    path: ROOT,
    parent: FOLDER,
    size,
    modifiedTime: "2026-10-01T00:00:00.000Z",
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    mimeType: "application/octet-stream",
    tags: {},
    thumbSource: "icon",
    thumbKey: null,
    ...extra,
  } as Row;
}
const folderRow = { id: FOLDER, name: ROOT, category: "folder", path: "", parent: "root", tags: {}, thumbSource: "icon" } as Row;

function push(generation: string, rows: Row[]) {
  upsertRows(generation, rows);
  return commitGeneration(generation, `2026-10-17T10:${generation.slice(-2)}:00.000Z`);
}

let dbSeq = 0;
function fresh() {
  dbSeq += 1;
  process.env.ORDER_LINKS_DB_FILE = join(dir, `test-${dbSeq}.db`);
  resetOrderLinkStore();
  resetDriveFilesDbForTests();
  resetLibraryDriveThrottleForTests();
  getSqlite();
  driveFilesDb();
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("dedupe key and client mask", () => {
  assert.equal(libraryDedupeKey("Mighty 8K NEWX1 Castellan Bits 2.ctb", 100), libraryDedupeKey("mighty 8k  newx1 castellan_bits 2.CTB", 100));
  assert.notEqual(libraryDedupeKey("a.ctb", 100), libraryDedupeKey("a.ctb", 101));
  assert.equal(libraryDedupeKey("a.ctb", null), "");
  assert.equal(maskLibraryClientText("CTB Pricing for William.ctb"), "CTB Pricing for Client job.ctb");
  assert.equal(maskLibraryClientText("Mighty 8K NEWX3 Castellan Bits Plate 1.ctb"), "Mighty 8K NEWX3 Castellan Bits Plate 1.ctb");
  assert.equal(maskLibraryClientText("Bits for Castellan.ctb"), "Bits for Castellan.ctb");
  assert.equal(maskLibraryClientText("Knight Glenn Chandler plate.ctb", ["Glenn Chandler"]), "Knight Client job plate.ctb");
  assert.equal(subfolderOf(`${ROOT}/Titans/Warlord`, ROOT), "Titans/Warlord");
  assert.equal(subfolderOf(ROOT, ROOT), "");
});

test("Library lists the Drive folder plates from the Files index; skips other files and folders", () => {
  fresh();
  push("gen-0001", [
    folderRow,
    row("d1", "MEGA 8K Castellan Final.ctb", 1000),
    row("d2", "Mighty 12K OLD Gretchen Full.ctb", 2000),
    row("d3", "treegen_best_supported.stl", 3000),
    row("d4", "render.jpg", 10),
    row("d5", "Warlord arm.ctb", 4000, { path: `${ROOT}/Titans`, parent: "sub1" }),
    row("x1", "Elsewhere.ctb", 5000, { path: "Sources/Other", parent: "zz" }),
    row("p1", "CTB Pricing for William.ctb", 6000),
  ]);
  const read = readLibraryDriveRows();
  assert.equal(read.indexed, true);
  assert.deepEqual(read.rows.map((r) => r.id).sort(), ["d1", "d2", "d5", "p1"]);
  const result = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(result.inserted, 4);
  const files = listPlateFiles({}).files;
  assert.equal(files.length, 4);
  const castellan = files.find((f) => f.driveFileId === "d1")!;
  assert.equal(castellan.source, "drive");
  assert.equal(castellan.printer, "MEGA 8K");
  assert.equal(castellan.driveFolder, "");
  assert.equal(castellan.kit, ROOT);
  assert.equal(castellan.sizeBytes, 1000);
  assert.equal(castellan.modifiedAt, "2026-10-01T00:00:00.000Z");
  assert.match(castellan.webViewLink, /drive\.google\.com\/file\/d\/d1/);
  const warlord = files.find((f) => f.driveFileId === "d5")!;
  assert.equal(warlord.driveFolder, "Titans");
  assert.equal(warlord.kit, "Titans");
  assert.equal(files.find((f) => f.driveFileId === "p1")!.name, "CTB Pricing for Client job.ctb");
  // Drive-only plates are never meshed/backfilled (server cannot read their bytes).
  assert.deepEqual(listPlateIdsNeedingMesh().filter((id) => id.startsWith("d")), []);
  // Idempotent.
  const again = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(again.inserted, 0);
  assert.equal(listPlateFiles({}).files.length, 4);
  const status = libraryDriveStatus();
  assert.equal(status.indexed, true);
  assert.equal(status.folderName, ROOT);
  assert.equal(status.plates, 4);
});

test("a manual upload and its Drive copy are one Library item; manual metadata wins", () => {
  fresh();
  upsertPlateFiles(
    [
      {
        driveFileId: "up1",
        name: "Mighty 8K NEWX1 Castellan Bits 2.ctb",
        webViewLink: "",
        sizeBytes: 352972576,
        modifiedAt: "2026-09-27T03:15:11.275Z",
        printer: "Mighty 8K",
        kit: "Knight Castellan",
        notes: "manual note",
        sha256: SHA,
        orderKeys: ["deal:111"],
      },
    ],
    "upload",
  );
  savePlatePreview(SHA, null, { printerProfile: "Mighty 8K", layerCount: 2400, layerHeightMm: 0.05, printTimeSeconds: 36000, resinVolumeMl: 210, resinCost: null });
  push("gen-0002", [
    folderRow,
    row("dc1", "Mighty 8K NEWX1 Castellan Bits 2.ctb", 352972576, { modifiedTime: "2026-10-05T00:00:00.000Z" }),
    row("dc2", "Mighty 8K NEWX1 Castellan Bits 2.ctb", 352972000), // re-slice: different size
  ]);
  const result = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(result.merged, 1);
  assert.equal(result.inserted, 1);
  const files = listPlateFiles({}).files;
  assert.equal(files.length, 2);
  const merged = getPlateFile("up1")!;
  assert.equal(merged.source, "upload");
  assert.equal(merged.kit, "Knight Castellan");
  assert.equal(merged.notes, "manual note");
  assert.equal(merged.modifiedAt, "2026-09-27T03:15:11.275Z");
  assert.equal(merged.stats?.printTimeSeconds, 36000);
  assert.deepEqual(merged.orderKeys, ["deal:111"]);
  assert.equal(merged.driveCopies?.length, 1);
  assert.equal(merged.driveCopies?.[0]?.driveFileId, "dc1");
  assert.equal(merged.driveCopies?.[0]?.matchedBy, "name+size");
  assert.equal(merged.driveFolder, "");
  assert.equal(getPlateFile("dc2")?.source, "drive");
  // Second run changes nothing.
  const again = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(again.merged + again.inserted, 0);
  assert.equal(listPlateFiles({}).files.length, 2);
});

test("a Drive-only plate folds into a later manual upload (links move, no duplicate)", () => {
  fresh();
  push("gen-0003", [folderRow, row("dx", "MEGA 8K Squast OPR.ctb", 777)]);
  reconcileLibraryDrive(undefined, { contactNames: [] });
  linkPlateFile("dx", "deal:222");
  upsertPlateFiles(
    [{ driveFileId: "upx", name: "MEGA 8K Squast OPR.ctb", webViewLink: "", sizeBytes: 777, printer: "MEGA 8K", kit: "Squats", sha256: SHA, orderKeys: ["deal:333"] }],
    "upload",
  );
  const result = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(result.folded, 1);
  const files = listPlateFiles({}).files;
  assert.equal(files.length, 1);
  const kept = files[0]!;
  assert.equal(kept.driveFileId, "upx");
  assert.deepEqual(kept.orderKeys, ["deal:222", "deal:333"]);
  assert.equal(kept.kit, "Squats");
  assert.deepEqual(kept.driveCopies?.map((c) => c.driveFileId), ["dx"]);
  // Next reconcile treats dx as the recorded copy, not a new item.
  const again = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(again.inserted, 0);
  assert.equal(listPlateFiles({}).files.length, 1);
});

test("sha256 from a pusher matches even when the name differs", () => {
  fresh();
  upsertPlateFiles([{ driveFileId: "ups", name: "castellan plate.ctb", webViewLink: "", sizeBytes: 50, sha256: SHA, orderKeys: ["deal:1"] }], "upload");
  const result = reconcileLibraryDrive(
    {
      indexed: true,
      folderPath: ROOT,
      rows: [{ id: "dsha", name: "renamed on PC.ctb", path: ROOT, parent: FOLDER, size: 50, modifiedTime: null, webViewLink: null, mimeType: null, thumbSource: "icon", thumbKey: null, sha256: SHA }],
    },
    { contactNames: [] },
  );
  assert.equal(result.merged, 1);
  assert.equal(getPlateFile("ups")?.driveCopies?.[0]?.matchedBy, "sha256");
});

test("removed Drive files drop out unless linked; an empty push never wipes the Library", () => {
  fresh();
  push("gen-0004", [folderRow, row("r1", "Keep linked.ctb", 10), row("r2", "Gone.ctb", 20), row("r3", "Stays.ctb", 30)]);
  reconcileLibraryDrive(undefined, { contactNames: [] });
  linkPlateFile("r1", "deal:9");
  // Aborted push: commit skipped, nothing removed.
  assert.equal(commitGeneration("gen-empty").skipped, true);
  reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(listPlateFiles({}).files.length, 3);
  push("gen-0005", [folderRow, row("r3", "Stays.ctb", 30)]);
  const result = reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(result.pruned, 1);
  const ids = listPlateFiles({}).files.map((f) => f.driveFileId).sort();
  assert.deepEqual(ids, ["r1", "r3"]);
  assert.equal(getPlateFile("r1")?.driveFolder, undefined);
  // Index without the folder row at all (folder not indexed): no pruning.
  push("gen-0006", [row("other", "x.stl", 1, { path: "Sources", parent: "s" })]);
  reconcileLibraryDrive(undefined, { contactNames: [] });
  assert.equal(listPlateFiles({}).files.length, 2);
});

test("Library route: owner-only, reconciles on open, returns Drive status, thumb route is scoped", async () => {
  fresh();
  push("gen-0007", [folderRow, row("t1", "Mighty 8K OLD Vulan Base.ctb", 123, { thumbSource: "drive", thumbKey: "t1.jpg" })]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  driveFilesDb().prepare("INSERT INTO drive_thumbs (key, sha, mime, data) VALUES (?,?,?,?)").run("t1.jpg", "abcdef12", "image/jpeg", jpeg);
  driveFilesDb().prepare("INSERT INTO drive_thumbs (key, sha, mime, data) VALUES (?,?,?,?)").run("private.jpg", "abcdef13", "image/jpeg", jpeg);
  const app = express();
  app.use(express.json());
  registerPlateLibraryRoutes(app);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = { "x-paid-order-access-code": "lib-owner" };
  try {
    assert.equal((await fetch(`${base}/api/plate-files`)).status, 401);
    assert.equal((await fetch(`${base}/api/plate-files/drive-thumbs/t1.jpg`)).status, 401);
    const listed = (await (await fetch(`${base}/api/plate-files`, { headers: owner })).json()) as {
      files: Array<{ driveFileId: string; source: string; driveThumbKey: string }>;
      drive: { plates: number; folderName: string; indexed: boolean };
    };
    assert.equal(listed.files.length, 1);
    assert.equal(listed.files[0]!.source, "drive");
    assert.equal(listed.files[0]!.driveThumbKey, "t1.jpg");
    assert.equal(listed.drive.plates, 1);
    assert.equal(listed.drive.indexed, true);
    const thumb = await fetch(`${base}/api/plate-files/drive-thumbs/t1.jpg`, { headers: owner });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");
    assert.equal((await fetch(`${base}/api/plate-files/drive-thumbs/private.jpg`, { headers: owner })).status, 404);
    const sync = (await (await fetch(`${base}/api/plate-files/drive-sync`, { method: "POST", headers: owner })).json()) as { ok: boolean; inserted: number };
    assert.equal(sync.ok, true);
    assert.equal(sync.inserted, 0);
    const summary = (await (await fetch(`${base}/api/plate-files?summary=1`, { headers: owner })).json()) as { total: number };
    assert.equal(summary.total, 1);
  } finally {
    server.close();
  }
});
