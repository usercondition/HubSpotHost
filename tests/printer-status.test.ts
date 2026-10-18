/**
 * Printers IDLE / PRINTING board: pure status logic + owner-gated start/done API.
 * No test (and no code under test) contacts a printer.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  buildPrinterStatusBoard,
  computePrinterStatus,
  formatRemaining,
  isRunPrinting,
  runEtaMs,
  startPrinterRunSchema,
  statusRoster,
  type PrinterRun,
} from "../shared/printer-status";
import { DEFAULT_QUOTE_PRINTERS } from "../shared/stl-quote";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const P = { key: "mighty-8k-newx1", name: "Phrozen Sonic Mighty 8K New X1", watts: 120 };
let nextId = 1;
function run(over: Partial<PrinterRun>): PrinterRun {
  return {
    id: nextId++,
    printerKey: P.key,
    recordId: null,
    dealId: null,
    jobLabel: "Job",
    fileName: null,
    startedAt: new Date(NOW - 3_600_000).toISOString(),
    estSeconds: 4 * 3_600,
    finishedAt: null,
    ...over,
  };
}

test("roster reuses the STL Quote printers, drops parked Formlabs and the Mighty Revo", () => {
  const roster = statusRoster(DEFAULT_QUOTE_PRINTERS);
  const keys = roster.map((p) => p.key);
  assert.equal(roster.length, 8);
  assert.ok(!keys.includes("mighty-revo"));
  assert.ok(!keys.includes("formlabs"));
  assert.deepEqual(
    roster.map((p) => p.name),
    [
      "Phrozen Sonic Mega 8K S",
      "Phrozen Sonic Mighty 12K New",
      "Phrozen Sonic Mighty 12K Old",
      "Phrozen Sonic Mighty 8K Old",
      "Phrozen Sonic Mighty 8K NEWX2",
      "Phrozen Sonic Mighty 8K New X1",
      "Phrozen Sonic Mighty 8K NEWX3",
      "HeyGears (UltraCraft Reflex)",
    ],
  );
  assert.equal(roster.find((p) => p.key === "mega-8k-s")!.watts, 240);
  assert.equal(roster.find((p) => p.key === "heygears-reflex")!.watts, 180);
});

test("no runs -> IDLE with nothing running", () => {
  const s = computePrinterStatus(P, [], NOW);
  assert.equal(s.state, "idle");
  assert.equal(s.current, null);
  assert.equal(s.last, null);
});

test("started run with ETA in the future -> PRINTING with start, ETA, remaining, progress", () => {
  const s = computePrinterStatus(P, [run({ jobLabel: "Knight Castellan" })], NOW);
  assert.equal(s.state, "printing");
  assert.equal(s.current!.jobLabel, "Knight Castellan");
  assert.equal(s.current!.startedAt, "2026-10-17T19:00:00.000Z");
  assert.equal(s.current!.etaAt, "2026-10-17T23:00:00.000Z");
  assert.equal(s.current!.remainingSeconds, 3 * 3_600);
  assert.equal(s.current!.progress, 0.25);
  assert.equal(formatRemaining(s.current!.remainingSeconds), "3h 00m left");
});

test("ETA already passed and not marked done -> IDLE, last job shown as estimated done at ETA", () => {
  const r = run({ startedAt: new Date(NOW - 5 * 3_600_000).toISOString(), jobLabel: "Old plate" });
  const s = computePrinterStatus(P, [r], NOW);
  assert.equal(s.state, "idle");
  assert.equal(s.current, null);
  assert.deepEqual(s.last, { jobLabel: "Old plate", endedAt: new Date(NOW - 3_600_000).toISOString(), autoEnded: true });
});

test("marked done -> IDLE even before ETA", () => {
  const r = run({ finishedAt: new Date(NOW - 60_000).toISOString() });
  const s = computePrinterStatus(P, [r], NOW);
  assert.equal(s.state, "idle");
  assert.equal(s.last!.autoEnded, false);
  assert.equal(s.last!.endedAt, new Date(NOW - 60_000).toISOString());
});

test("marked in-progress with no print time -> PRINTING with no ETA or progress", () => {
  const s = computePrinterStatus(P, [run({ estSeconds: null })], NOW);
  assert.equal(s.state, "printing");
  assert.equal(s.current!.etaAt, null);
  assert.equal(s.current!.remainingSeconds, null);
  assert.equal(s.current!.progress, null);
});

test("runs on other printers and bad dates are ignored; newest open run wins", () => {
  const older = run({ startedAt: new Date(NOW - 2 * 3_600_000).toISOString(), jobLabel: "older" });
  const newer = run({ startedAt: new Date(NOW - 600_000).toISOString(), jobLabel: "newer" });
  const other = run({ printerKey: "mega-8k-s", jobLabel: "elsewhere" });
  const bad = run({ startedAt: "not a date", jobLabel: "bad" });
  const s = computePrinterStatus(P, [older, other, bad, newer], NOW);
  assert.equal(s.current!.jobLabel, "newer");
  assert.equal(isRunPrinting(bad, NOW), false);
  assert.equal(runEtaMs({ startedAt: "x", estSeconds: 10 }), null);
  assert.equal(runEtaMs({ startedAt: new Date(NOW).toISOString(), estSeconds: 0 }), null);
});

test("board counts printing vs idle", () => {
  const roster = statusRoster(DEFAULT_QUOTE_PRINTERS);
  const board = buildPrinterStatusBoard(roster, [run({}), run({ printerKey: "mega-8k-s" })], NOW);
  assert.equal(board.printingCount, 2);
  assert.equal(board.idleCount, 6);
  assert.equal(board.printers.length, 8);
});

test("formatRemaining and start schema", () => {
  assert.equal(formatRemaining(null), "");
  assert.equal(formatRemaining(30), "under 1m left");
  assert.equal(formatRemaining(12 * 60), "12m left");
  assert.equal(formatRemaining(4 * 3_600 + 5 * 60), "4h 05m left");
  assert.equal(startPrinterRunSchema.safeParse({}).success, false);
  assert.equal(startPrinterRunSchema.safeParse({ jobLabel: "  " }).success, false);
  assert.equal(startPrinterRunSchema.safeParse({ recordId: 3 }).success, true);
  assert.equal(startPrinterRunSchema.safeParse({ jobLabel: "Bits", estHours: "2.5" }).success, true);
});

// ---- API (temp SQLite, fake HubSpot) ----
const dbFile = path.join(os.tmpdir(), `printer-status-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "printer-status-owner";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update(OWNER_CODE, "utf8").digest("hex");
const store = await import("../server/lib/order-links");
const { createPrintFileRecord, stagePrintFile } = await import("../server/lib/print-files");
const { registerRoutes } = await import("../server/routes");

let mock: http.Server;
let app: http.Server;
let appBase = "";
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}
async function owner(method: string, url: string, body?: unknown) {
  const response = await fetch(`${appBase}${url}`, {
    method,
    headers: { "content-type": "application/json", "x-paid-order-access-code": OWNER_CODE },
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



before(async () => {
  mock = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "ok", results: [], stages: [] }));
  });
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${await listen(mock)}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  appBase = `http://127.0.0.1:${await listen(app)}`;
});

after(() => {
  mock?.close();
  app?.close();
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

test("status API is owner-only", async () => {
  assert.equal((await fetch(`${appBase}/api/printers/status`)).status, 401);
  assert.equal((await fetch(`${appBase}/api/printers/status/mega-8k-s/done`, { method: "POST" })).status, 401);
  const wrong = await fetch(`${appBase}/api/printers/status/mega-8k-s/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-paid-order-access-code": "nope" },
    body: JSON.stringify({ jobLabel: "x" }),
  });
  assert.equal(wrong.status, 401);
});

test("start a plate -> PRINTING with CTB print time as ETA; done -> IDLE", async () => {
  const staged = stagePrintFile("newx1-plate.ctb", fixtureCtb("Mighty 8K NEWX1"));
  const record = createPrintFileRecord({
    analysisId: staged.analysisId,
    hubspotDealId: "9101",
    hubspotDealName: "Order 9101",
    dealStage: "In work",
    metrics: staged.metrics,
  });

  const initial = await owner("GET", "/api/printers/status");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.printers.length, 8);
  assert.equal(initial.body.printingCount, 0);
  assert.equal(initial.body.idleCount, 8);
  const plate = initial.body.plates.find((p: any) => p.recordId === record.id);
  assert.equal(plate.suggestedPrinterKey, "mighty-8k-newx1");
  assert.equal(plate.printTimeSeconds, 14_400);
  assert.equal(plate.started, false);

  const unknown = await owner("POST", "/api/printers/status/mighty-revo/start", { jobLabel: "x" });
  assert.equal(unknown.status, 404);
  const empty = await owner("POST", "/api/printers/status/mighty-8k-newx1/start", {});
  assert.equal(empty.status, 400);

  const started = await owner("POST", "/api/printers/status/mighty-8k-newx1/start", { recordId: record.id });
  assert.equal(started.status, 201);
  assert.equal(started.body.run.estSeconds, 14_400);
  assert.equal(started.body.run.jobLabel, "Order 9101");
  const card = started.body.printers.find((p: any) => p.key === "mighty-8k-newx1");
  assert.equal(card.state, "printing");
  assert.equal(card.current.fileName, "newx1-plate.ctb");
  assert.ok(Math.abs(Date.parse(card.current.etaAt) - Date.parse(card.current.startedAt) - 14_400_000) < 1000);
  assert.equal(started.body.printingCount, 1);

  // Starting another job on the same printer replaces the first one.
  const typed = await owner("POST", "/api/printers/status/mighty-8k-newx1/start", { jobLabel: "Extra bits", estHours: 1.5 });
  assert.equal(typed.status, 201);
  assert.equal(typed.body.run.estSeconds, 5_400);
  assert.equal(typed.body.printers.find((p: any) => p.key === "mighty-8k-newx1").current.jobLabel, "Extra bits");
  assert.equal(typed.body.printingCount, 1);

  const done = await owner("POST", "/api/printers/status/mighty-8k-newx1/done");
  assert.equal(done.status, 200);
  assert.equal(done.body.closed, 1);
  const after = done.body.printers.find((p: any) => p.key === "mighty-8k-newx1");
  assert.equal(after.state, "idle");
  assert.equal(after.last.jobLabel, "Extra bits");
  assert.equal(done.body.printingCount, 0);

  const again = await owner("GET", "/api/printers/status");
  assert.equal(again.body.plates.find((p: any) => p.recordId === record.id).started, true);
});
