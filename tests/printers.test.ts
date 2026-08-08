/**
 * Printer fleet matching, usage rollups, lifecycle, and ULTX best-effort parse.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import express from "express";

const dbFile = path.join(os.tmpdir(), `printers-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "printer-owner-code";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");

const store = await import("../server/lib/order-links");
const {
  ensureDefaultPrinters,
  matchPrinterId,
  normalizePrinterKey,
  buildPrinterFleetSnapshot,
  addPrinterLifecycleEvent,
  assignPrinterProfile,
  assignPrintFilePrinter,
  isSharedModelPrinterProfile,
  resolvePrinterIdForRecord,
} = await import("../server/lib/printers");
const {
  parseUltxFile,
  extractZipTextMembers,
  listUltxZipMembers,
  countUltxLayersFromMembers,
  extractPasswordsFromSliceLog,
  extractUltxMetricsFromSliceLog,
  matchSliceLogMetrics,
  parseUltxExportStampMs,
  BLUEPRINT_ASSET_ZIP_PASSWORD,
} = await import("../server/lib/ultx");
const { createPrintFileRecord, stagePrintFile } = await import("../server/lib/print-files");
const { registerRoutes } = await import("../server/routes");

let mock: http.Server;
let app: http.Server;
let appBase = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function jsonOwnerRequest(method: string, url: string, body?: unknown) {
  const response = await fetch(`${appBase}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function fixtureCtb(machineName = "Mighty 8K NEWX1"): Buffer {
  const file = Buffer.alloc(0x180);
  file.writeUInt32LE(0x12fd0086, 0x00);
  file.writeUInt32LE(4, 0x04);
  file.writeFloatLE(218, 0x08);
  file.writeFloatLE(123, 0x0c);
  file.writeFloatLE(260, 0x10);
  file.writeFloatLE(42.5, 0x1c);
  file.writeFloatLE(0.05, 0x20);
  file.writeFloatLE(2.5, 0x24);
  file.writeFloatLE(35, 0x28);
  file.writeFloatLE(1, 0x2c);
  file.writeUInt32LE(8, 0x30);
  file.writeUInt32LE(1440, 0x34);
  file.writeUInt32LE(2560, 0x38);
  file.writeUInt32LE(420, 0x44);
  file.writeUInt32LE(14_400, 0x4c);
  file.writeUInt32LE(0x80, 0x54);
  file.writeUInt32LE(0x40, 0x58);
  file.writeUInt32LE(0xc0, 0x6c);
  file.writeFloatLE(8, 0x80);
  file.writeFloatLE(65, 0x84);
  file.writeFloatLE(5, 0x88);
  file.writeFloatLE(120, 0x8c);
  file.writeFloatLE(150, 0x90);
  file.writeFloatLE(31.25, 0x94);
  file.writeFloatLE(34.5, 0x98);
  file.writeFloatLE(4.75, 0x9c);
  file.writeFloatLE(2, 0xa0);
  file.writeFloatLE(0.5, 0xa4);
  file.writeUInt32LE(8, 0xa8);
  file.writeUInt32LE(0x100, 0xdc);
  file.writeUInt32LE(machineName.length, 0xe0);
  file.write(machineName, 0x100, "ascii");
  return file;
}

function zipTextMember(fileName: string, contents: string): Buffer {
  const payload = Buffer.from(contents, "utf8");
  const name = Buffer.from(fileName, "utf8");
  const compressed = zlib.deflateRawSync(payload);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);
  return local;
}

function fixtureUltxZip(): Buffer {
  return zipTextMember(
    "printinfo.json",
    JSON.stringify({
      machineName: "HeyGears Reflex Turbo",
      printTime: 3600,
      layerCount: 800,
      resinVolume: 42.5,
      resinMass: 46.2,
      layerHeight: 0.05,
      exposureTime: 2.2,
    }),
  );
}

before(async () => {
  mock = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "ok", results: [], stages: [] }));
  });
  const mockPort = await listen(mock);
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";

  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  const port = await listen(app);
  appBase = `http://127.0.0.1:${port}`;
});

after(() => {
  mock?.close();
  app?.close();
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* cleanup */
    }
  }
});

test("default fleet includes HeyGears Reflex Turbo and NEWX printers", () => {
  const fleet = ensureDefaultPrinters();
  const names = fleet.map((printer) => printer.name);
  assert.ok(names.includes("Mighty 8K NEWX1"));
  assert.ok(names.includes("Mighty 8K NEWX2"));
  assert.ok(names.includes("Mighty 8K NEWX3"));
  assert.ok(names.includes("Mighty 12K NEW"));
  assert.ok(names.includes("Mighty 12K OLD"));
  assert.ok(names.includes("MEGA 8K"));
  assert.ok(names.includes("Mighty 8K OLD"));
  assert.ok(names.includes("HeyGears Reflex Turbo"));
});

test("machine-name matching prefers distinctive aliases like NEWX1", () => {
  const fleet = ensureDefaultPrinters();
  const newx1 = fleet.find((printer) => printer.name === "Mighty 8K NEWX1")!;
  const mega = fleet.find((printer) => printer.name === "MEGA 8K")!;
  const heygears = fleet.find((printer) => printer.name === "HeyGears Reflex Turbo")!;

  assert.equal(matchPrinterId("Mighty 8K NEWX1", fleet), newx1.id);
  assert.equal(matchPrinterId("NEWX2", fleet), fleet.find((p) => p.name === "Mighty 8K NEWX2")!.id);
  assert.equal(matchPrinterId("ELEGOO Mega 8K", fleet), mega.id);
  assert.equal(matchPrinterId("Phrozen Sonic Mega 8K S", fleet), mega.id);
  assert.equal(matchPrinterId("Phrozen Sonic Mega 8K", fleet), mega.id);
  assert.equal(matchPrinterId("Reflex RS Turbo", fleet), heygears.id);
  assert.equal(matchPrinterId("totally unknown box", fleet), null);
  // Shared model-only names must NOT latch onto NEWX1 via substring containment.
  assert.equal(matchPrinterId("Mighty 8K", fleet), null);
  assert.equal(matchPrinterId("Phrozen Sonic Mighty 8K", fleet), null);
  assert.equal(isSharedModelPrinterProfile("Mighty 8K", fleet), true);
  assert.equal(isSharedModelPrinterProfile("Mighty 8K NEWX1", fleet), false);
  assert.equal(normalizePrinterKey("Mighty  8K!!! NEWX1"), "mighty 8k newx1");
});

test("per-plate fleet printer assignment attributes shared Mighty 8K hours", () => {
  const fleet = ensureDefaultPrinters();
  const newx2 = fleet.find((printer) => printer.name === "Mighty 8K NEWX2")!;
  const staged = stagePrintFile("shared-mighty.ctb", fixtureCtb("Phrozen Sonic Mighty 8K"));
  const record = createPrintFileRecord({
    analysisId: staged.analysisId,
    hubspotDealId: "9002",
    hubspotDealName: "Shared Mighty plate",
    dealStage: "In work",
    metrics: staged.metrics,
  });
  assert.equal(matchPrinterId(record.printerProfile, fleet), null);
  assert.equal(resolvePrinterIdForRecord(record, fleet), null);

  const assigned = assignPrintFilePrinter({ recordId: record.id, printerId: newx2.id });
  assert.ok(assigned);
  assert.equal(assigned!.record.fleetPrinterId, newx2.id);
  const snapshot = buildPrinterFleetSnapshot();
  const usage = snapshot.printers.find((printer) => printer.printerId === newx2.id);
  assert.ok(usage);
  assert.ok(usage!.recentJobs.some((job) => job.recordId === record.id));
  assert.ok(usage!.totalPrintHours > 0);
});

test("manual profile assignment maps odd labels onto a fleet printer", () => {
  const fleet = ensureDefaultPrinters();
  const mega = fleet.find((printer) => printer.name === "MEGA 8K")!;
  assert.equal(matchPrinterId("Custom Booth Label XYZ", fleet), null);

  const assigned = assignPrinterProfile({
    profile: "Custom Booth Label XYZ",
    printerId: mega.id,
  });
  assert.ok(assigned);
  assert.equal(matchPrinterId("Custom Booth Label XYZ", ensureDefaultPrinters()), mega.id);
  assert.ok(!assigned!.fleet.unassigned.profiles.some((row) => row.profile === "Custom Booth Label XYZ"));
});

test("ULTX zip metadata is harvested into print metrics", () => {
  const members = extractZipTextMembers(fixtureUltxZip());
  assert.ok(members.some((text) => text.includes("printTime")));

  const metrics = parseUltxFile("reflex-plate.ultx", fixtureUltxZip());
  assert.equal(metrics.format, "ULTX");
  assert.equal(metrics.printTimeSeconds, 3600);
  assert.equal(metrics.layerCount, 800);
  assert.equal(metrics.resinVolumeMl, 42.5);
  assert.equal(metrics.printerProfile, "HeyGears Reflex Turbo");
});

test("ULTX plaintext parameters.ini harvests Blueprint field names", () => {
  const buffer = fs.readFileSync(path.join("tests", "fixtures", "sample-plaintext.ultx"));
  const metrics = parseUltxFile("plate.ultx", buffer);
  assert.equal(metrics.printTimeSeconds, 7200);
  assert.equal(metrics.resinMassG, 88.5);
  assert.equal(metrics.resinVolumeMl, 80);
  // Layer PNGs win over the parameters.ini layerCount=400 placeholder.
  assert.equal(metrics.layerCount, 10);
  assert.equal(metrics.layerHeightMm, 0.05);
  assert.equal(metrics.printerProfile, "HeyGears Reflex Turbo");
  assert.equal(metrics.modelHeightMm, 0.5);
});

test("ULTX AES archive yields layer count without password and full metrics with password", () => {
  const buffer = fs.readFileSync(path.join("tests", "fixtures", "sample-encrypted.ultx"));
  const members = listUltxZipMembers(buffer);
  assert.ok(members.length >= 7);
  assert.equal(countUltxLayersFromMembers(members), 5);

  const sealed = parseUltxFile("P_demo-Plate01.rs.ultx", buffer, { password: null });
  assert.equal(sealed.layerCount, 5);
  assert.equal(sealed.printTimeSeconds, null);
  assert.equal(sealed.resinMassG, null);
  assert.equal(sealed.printerProfile, "Reflex RS");
  assert.match(sealed.formatRevision, /AES-encrypted|metadata sealed/i);

  const opened = parseUltxFile("P_demo-Plate01.rs.ultx", buffer, { password: "heygears-test-pass" });
  assert.equal(opened.printTimeSeconds, 12457);
  assert.equal(opened.resinMassG, 44);
  assert.equal(opened.resinVolumeMl, 40.2);
  assert.equal(opened.layerHeightMm, 0.03);
  assert.equal(opened.layerCount, 5);
  assert.equal(opened.modelHeightMm, 0.15);
  assert.equal(opened.printerProfile, "Reflex RS");
  assert.equal(opened.resinCostLabel, "Open Material");
  assert.match(opened.formatRevision, /decrypted/i);
});

test("ULTX harvests Blueprint Slice.log / UI-style phrases with spaced keys", () => {
  // Simulate decrypted parameters.ini + Slice.log fragments from Blueprint AppCache.
  const dump = [
    "Time Cost: 03:27:37",
    "materialWeight: 44g",
    "Techbag file volume: 161.701311",
    "layerThickness=0.03",
    "platformSizeX=228.1",
    "platformSizeY=128.3",
    "platformSizeZ=228",
    "Use open material",
    'openMaterialConfig={"normalLayerExposure":1300,"firstLayerExposure":10000}',
  ].join("\n");
  const metrics = parseUltxFile("P_demo-Plate01.rs.ultx", zipTextMember("parameters.ini", dump));
  assert.equal(metrics.printTimeSeconds, 3 * 3600 + 27 * 60 + 37);
  assert.equal(metrics.resinMassG, 44);
  assert.equal(metrics.resinVolumeMl, 161.701);
  assert.equal(metrics.layerHeightMm, 0.03);
  assert.equal(metrics.buildVolumeXmm, 228.1);
  assert.equal(metrics.buildVolumeYmm, 128.3);
  assert.equal(metrics.buildVolumeZmm, 228);
  assert.equal(metrics.resinCostLabel, "Open Material");
  assert.equal(metrics.exposureSeconds, 1.3);
  assert.equal(metrics.bottomExposureSeconds, 10);
});

test("ULTX scrapes Codex zip passwords from Blueprint Slice.log lines", () => {
  const passwords = extractPasswordsFromSliceLog(
    ["[Slice] Use open material", "[Slice] password: ab12cd34ef", "[Slice] password: ab12cd34ef", "noise"].join(
      "\n",
    ),
  );
  assert.deepEqual(passwords, ["ab12cd34ef"]);
  assert.equal(BLUEPRINT_ASSET_ZIP_PASSWORD, "heygears008");
});

test("ULTX harvests print estimates from Blueprint Slice.log Output JSON", () => {
  const sliceLog = [
    '1786060093550|info|ALG|[Slice] Techbag file volume: 33.51452|ed4909aa-1ea8-4a0d-a3f5-3215bed8c027|16:48:13:550',
    '1786060094161|info|ALG|[Slice] material cost: 43.568876 g, print time cost: 12457725 ms|ed4909aa-1ea8-4a0d-a3f5-3215bed8c027|16:48:14:161',
    '1786060108784|info|ALG|[Slice] Output: {"calcMValueTime":12714,"compressTime":12891,"numberOfSlices":1113,"printEstimateMaterials":43.568875999999996,"printEstimateTime":12457,"sliceFileName":"Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx","sliceTime":35453,"sliceTotalTime":63421}|ed4909aa-1ea8-4a0d-a3f5-3215bed8c027|16:48:28:784',
    '1786060028480|info|ALG|[Slice] Output: {"numberOfSlices":2073,"printEstimateMaterials":138.0576704,"printEstimateTime":22921,"sliceFileName":"Slice-54265a30-b458-467a-865e-be177354167c.ultx","sliceTotalTime":127340}|54265a30-b458-467a-865e-be177354167c|16:47:08:480',
  ].join("\n");

  const entries = extractUltxMetricsFromSliceLog(sliceLog);
  assert.equal(entries.length, 2);

  const byName = matchSliceLogMetrics(
    entries,
    "Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx",
  );
  assert.ok(byName);
  assert.equal(byName!.printTimeSeconds, 12457);
  assert.equal(byName!.resinMassG, 43.569);
  assert.equal(byName!.resinVolumeMl, 33.515);
  assert.equal(byName!.layerCount, 1113);

  const byUuid = matchSliceLogMetrics(entries, "P_plate-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.rs.ultx");
  assert.equal(byUuid?.printTimeSeconds, 12457);

  const byLayers = matchSliceLogMetrics(entries, "mystery-plate.ultx", 2073);
  assert.equal(byLayers?.resinMassG, 138.058);
  assert.equal(byLayers?.printTimeSeconds, 22921);

  // Blueprint export names keep a local stamp, not the Slice-*.ultx uuid.
  const exportName = "P_20260806_164828-Plate01.rs.ultx";
  const stamp = parseUltxExportStampMs(exportName);
  assert.ok(stamp);
  // Align the first Output line's epoch prefix to the export stamp for the matcher.
  const stampedLog = sliceLog.replace("1786060108784|", `${stamp}|`);
  const stampedEntries = extractUltxMetricsFromSliceLog(stampedLog);
  const byStamp = matchSliceLogMetrics(stampedEntries, exportName, 1113);
  assert.equal(byStamp?.printTimeSeconds, 12457);
  assert.equal(byStamp?.resinMassG, 43.569);

  const prev = process.env.ULTX_SLICE_LOG;
  const logFile = path.join(os.tmpdir(), `slice-log-${crypto.randomUUID()}.log`);
  fs.writeFileSync(logFile, sliceLog, "utf8");
  process.env.ULTX_SLICE_LOG = logFile;
  try {
    const buffer = fs.readFileSync(path.join("tests", "fixtures", "sample-encrypted.ultx"));
    // Sealed AES fixture has 5 layers — force a UUID filename match instead.
    const renamed = Buffer.from(buffer);
    const metrics = parseUltxFile("Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx", renamed, {
      password: null,
    });
    assert.equal(metrics.layerCount, 5); // ZIP PNG inventory wins over log layer count
    assert.equal(metrics.printTimeSeconds, 12457);
    assert.equal(metrics.resinMassG, 43.569);
    assert.equal(metrics.resinVolumeMl, 33.515);
    assert.match(metrics.formatRevision, /Slice\.log/i);
  } finally {
    if (prev === undefined) delete process.env.ULTX_SLICE_LOG;
    else process.env.ULTX_SLICE_LOG = prev;
    fs.unlinkSync(logFile);
  }

  // Uploaded Slice.log text (analyze form) works without ULTX_SLICE_LOG.
  delete process.env.ULTX_SLICE_LOG;
  const uploaded = parseUltxFile(
    "Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx",
    fs.readFileSync(path.join("tests", "fixtures", "sample-encrypted.ultx")),
    { password: null, sliceLogText: sliceLog },
  );
  assert.equal(uploaded.printTimeSeconds, 12457);
  assert.equal(uploaded.resinMassG, 43.569);
});

test("attached CTB plates roll into the matched printer usage breakdown", () => {
  const staged = stagePrintFile("newx1-plate.ctb", fixtureCtb("Mighty 8K NEWX1"));
  createPrintFileRecord({
    analysisId: staged.analysisId,
    hubspotDealId: "9001",
    hubspotDealName: "Knight on NEWX1",
    dealStage: "In work",
    metrics: staged.metrics,
  });

  const snapshot = buildPrinterFleetSnapshot();
  const newx1 = snapshot.printers.find((printer) => printer.name === "Mighty 8K NEWX1");
  assert.ok(newx1);
  assert.ok(newx1!.plateCount >= 1);
  assert.ok(newx1!.totalPrintHours > 0);
  assert.ok(newx1!.recentJobs.some((job) => job.dealName === "Knight on NEWX1"));
});

test("owner API returns the fleet and accepts a FEP lifecycle event", async () => {
  const blocked = await fetch(`${appBase}/api/printers`);
  assert.equal(blocked.status, 401);

  const listed = await jsonOwnerRequest("GET", "/api/printers");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.printers.length >= 8);
  assert.ok(listed.body.fleetTotals.activePrinters >= 8);

  const target = listed.body.printers.find((printer: any) => printer.name === "Mighty 8K NEWX2");
  assert.ok(target);

  const event = await jsonOwnerRequest("POST", `/api/printers/${target.printerId}/events`, {
    eventType: "fep_replaced",
    occurredAt: new Date().toISOString(),
    notes: "Fresh nFEP film",
  });
  assert.equal(event.status, 201);
  assert.equal(event.body.event.eventType, "fep_replaced");

  const after = await jsonOwnerRequest("GET", "/api/printers");
  const updated = after.body.printers.find((printer: any) => printer.printerId === target.printerId);
  assert.ok(updated.fepInstalledAt);
  assert.ok(updated.lifecycleEvents.some((item: any) => item.notes.includes("nFEP")));
});

test("owner API can assign an unassigned profile to MEGA 8K", async () => {
  const listed = await jsonOwnerRequest("GET", "/api/printers");
  const mega = listed.body.printers.find((printer: any) => printer.name === "MEGA 8K");
  assert.ok(mega);

  const assigned = await jsonOwnerRequest("POST", "/api/printers/assign-profile", {
    profile: "Workshop Label Mega S",
    printerId: mega.printerId,
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.map.printerId, mega.printerId);

  const refreshed = await jsonOwnerRequest("GET", "/api/printers");
  assert.ok(
    !refreshed.body.unassigned.profiles.some((row: any) => row.profile === "Workshop Label Mega S"),
  );
});

test("addPrinterLifecycleEvent can retire and reactivate a machine", () => {
  const fleet = ensureDefaultPrinters();
  const old = fleet.find((printer) => printer.name === "Mighty 8K OLD")!;
  addPrinterLifecycleEvent(old.id, {
    eventType: "retired",
    occurredAt: new Date().toISOString(),
    notes: "Spare parts only",
  });
  let snapshot = buildPrinterFleetSnapshot();
  assert.equal(snapshot.printers.find((printer) => printer.printerId === old.id)?.status, "retired");

  addPrinterLifecycleEvent(old.id, {
    eventType: "reactivated",
    occurredAt: new Date().toISOString(),
    notes: "Back in rotation",
  });
  snapshot = buildPrinterFleetSnapshot();
  assert.equal(snapshot.printers.find((printer) => printer.printerId === old.id)?.status, "active");
});
