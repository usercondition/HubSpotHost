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
} = await import("../server/lib/printers");
const { parseUltxFile, extractZipTextMembers, listUltxZipMembers, countUltxLayersFromMembers } =
  await import("../server/lib/ultx");
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

function fixtureUltxZip(): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      machineName: "HeyGears Reflex Turbo",
      printTime: 3600,
      layerCount: 800,
      resinVolume: 42.5,
      resinMass: 46.2,
      layerHeight: 0.05,
      exposureTime: 2.2,
    }),
    "utf8",
  );
  const name = Buffer.from("printinfo.json", "utf8");
  const compressed = zlib.deflateRawSync(json);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(json.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);
  return local;
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
  assert.equal(matchPrinterId("ELEGOO Mega 8K", fleet), mega.id);
  assert.equal(matchPrinterId("Phrozen Sonic Mega 8K S", fleet), mega.id);
  assert.equal(matchPrinterId("Phrozen Sonic Mega 8K", fleet), mega.id);
  assert.equal(matchPrinterId("Reflex RS Turbo", fleet), heygears.id);
  assert.equal(matchPrinterId("totally unknown box", fleet), null);
  assert.equal(normalizePrinterKey("Mighty  8K!!! NEWX1"), "mighty 8k newx1");
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
