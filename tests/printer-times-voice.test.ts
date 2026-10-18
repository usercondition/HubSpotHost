/**
 * Printers page: PT time math, voice-transcript matching, and the owner-only assign / start / clear /
 * voice endpoints. Only data in the app; nothing here contacts a printer.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { describeLastRun, describeRunTimes, formatClockPT, formatDurationShort, formatHours } from "../shared/printer-times";
import { matchVoiceToPrinter, normalizeVoiceText } from "../shared/printer-voice";
import { computePrinterStatus, isAssignableSliceName, statusRoster } from "../shared/printer-status";
import { DEFAULT_QUOTE_PRINTERS } from "../shared/stl-quote";

// 2026-10-17 1:00 PM PDT
const NOW = Date.parse("2026-10-17T20:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ---------- time math ----------

test("durations format without NaN", () => {
  assert.equal(formatDurationShort(4 * 3600 + 5 * 60), "4h 05m");
  assert.equal(formatDurationShort(45 * 60), "45m");
  assert.equal(formatDurationShort(20), "under 1m");
  for (const bad of [null, undefined, NaN, -5, 0, Infinity]) assert.equal(formatDurationShort(bad as number), "");
  assert.equal(formatHours(19_080), "5.3 h");
  assert.equal(formatHours(NaN), "");
});

test("clock is always Pacific, whatever the server/browser zone", () => {
  // Process TZ is UTC in CI; 20:00Z must still read as 1:00 PM PT.
  assert.equal(formatClockPT(iso(NOW), NOW), "1:00 PM");
  // 10:10 UTC on the 18th is 3:10 AM PT Sunday: a different PT day -> weekday prefix.
  assert.equal(formatClockPT("2026-10-18T10:10:00Z", NOW), "Sun 3:10 AM");
  // 06:30 UTC on the 18th is still Saturday 11:30 PM PT: same PT day, no prefix.
  assert.equal(formatClockPT("2026-10-18T06:30:00Z", NOW), "11:30 PM");
  assert.equal(formatClockPT("not a date", NOW), "");
  assert.equal(formatClockPT(null, NOW), "");
});

test("printing card: started, total, time left, finish in PT, progress", () => {
  const t = describeRunTimes({ startedAt: iso(NOW - 3_600_000), estSeconds: 4 * 3600 }, NOW);
  assert.equal(t.started, "12:00 PM PT");
  assert.equal(t.total, "4h 00m");
  assert.equal(t.left, "3h 00m left");
  assert.equal(t.finish, "4:00 PM PT");
  assert.equal(t.hasEstimate, true);
  assert.equal(t.pct, 25);
  // etaAt alone (older rows) gives the same answer.
  const viaEta = describeRunTimes({ startedAt: iso(NOW - 3_600_000), etaAt: iso(NOW + 3 * 3_600_000) }, NOW);
  assert.equal(viaEta.total, "4h 00m");
  assert.equal(viaEta.finish, "4:00 PM PT");
  // Past ETA but not marked done.
  const late = describeRunTimes({ startedAt: iso(NOW - 5 * 3_600_000), estSeconds: 3600 }, NOW);
  assert.equal(late.left, "should be done");
  assert.equal(late.pct, 100);
});

test("no-duration job (manual Porsche 944): start shown, finish unknown, no bar, no NaN", () => {
  const t = describeRunTimes({ startedAt: iso(NOW - 2 * 3_600_000), etaAt: null, estSeconds: null }, NOW);
  assert.equal(t.started, "11:00 AM PT");
  assert.equal(t.finish, "finish unknown");
  assert.equal(t.total, "");
  assert.equal(t.left, "");
  assert.equal(t.pct, null);
  assert.equal(t.hasEstimate, false);
  for (const v of Object.values(t)) assert.ok(!String(v).includes("NaN"));

  const P = { key: "mighty-12k-old", name: "Phrozen Sonic Mighty 12K Old", watts: 120 };
  const s = computePrinterStatus(
    P,
    [{ id: 1, printerKey: P.key, recordId: 1, dealId: null, jobLabel: "Porsche 944", fileName: null, startedAt: iso(NOW - 2 * 3_600_000), estSeconds: null, finishedAt: null }],
    NOW,
  );
  assert.equal(s.state, "printing");
  assert.equal(s.current!.estSeconds, null);
  assert.equal(s.current!.progress, null);
  assert.equal(s.current!.etaAt, null);
});

test("idle card: last run duration and end time", () => {
  const P = { key: "mega-8k-s", name: "Phrozen Sonic Mega 8K S", watts: 240 };
  const s = computePrinterStatus(
    P,
    [{ id: 2, printerKey: P.key, recordId: null, dealId: null, jobLabel: "Knights", fileName: null, startedAt: iso(NOW - 6 * 3_600_000), estSeconds: 4 * 3600 + 300, finishedAt: null }],
    NOW,
  );
  assert.equal(s.state, "idle");
  assert.equal(s.last!.durationSeconds, 4 * 3600 + 300);
  const d = describeLastRun(s.last!, NOW);
  assert.equal(d.duration, "4h 05m");
  assert.equal(d.ended, "11:05 AM PT");
  // Marked done early: duration is the real run time.
  const early = describeLastRun({ startedAt: iso(NOW - 3_600_000), endedAt: iso(NOW - 600_000) }, NOW);
  assert.equal(early.duration, "50m");
  assert.equal(describeLastRun({ endedAt: "garbage" }, NOW).ended, "");
});

// ---------- voice matching ----------

const ROSTER = statusRoster(DEFAULT_QUOTE_PRINTERS).map((p) => ({ key: p.key, name: p.name, aliases: [] as string[] }));

test("garbled transcripts match the right printer", () => {
  assert.equal(matchVoiceToPrinter("9012 12K old print started", ROSTER).printerKey, "mighty-12k-old");
  assert.equal(matchVoiceToPrinter("9012K new", ROSTER).printerKey, "mighty-12k-new");
  assert.equal(matchVoiceToPrinter("90X2 print started", ROSTER).printerKey, "mighty-8k-newx2");
  for (const t of ["9012 12K old print started", "9012K new", "90X2 print started"]) assert.equal(matchVoiceToPrinter(t, ROSTER).status, "match");
  assert.equal(matchVoiceToPrinter("ninety 8k old print started", ROSTER).printerKey, "mighty-8k-old");
  assert.equal(matchVoiceToPrinter("90 X3", ROSTER).printerKey, "mighty-8k-newx3");
  assert.equal(matchVoiceToPrinter("mega print started", ROSTER).printerKey, "mega-8k-s");
  assert.equal(matchVoiceToPrinter("hey gears print started", ROSTER).printerKey, "heygears-reflex");
  assert.match(normalizeVoiceText("Phrozen Mighty Twelve K Old print started"), /mighty 12k old/);
});

test("ambiguous transcripts return candidates instead of a printer", () => {
  const m = matchVoiceToPrinter("mighty 8k print started", ROSTER);
  assert.equal(m.status, "ambiguous");
  assert.equal(m.printerKey, null);
  assert.deepEqual(
    m.candidates.map((c) => c.key).sort(),
    ["mighty-8k-newx1", "mighty-8k-newx2", "mighty-8k-newx3", "mighty-8k-old"],
  );
  const twelve = matchVoiceToPrinter("9012K print started", ROSTER);
  assert.equal(twelve.status, "ambiguous");
  assert.deepEqual(twelve.candidates.map((c) => c.key).sort(), ["mighty-12k-new", "mighty-12k-old"]);
  const none = matchVoiceToPrinter("banana", ROSTER);
  assert.equal(none.status, "none");
  assert.equal(none.candidates.length, ROSTER.length);
});

test("only .ctb is assignable", () => {
  assert.ok(isAssignableSliceName("Plate A.CTB"));
  for (const n of ["plate.ultx", "model.stl", "notes.txt", "ctb", ""]) assert.ok(!isAssignableSliceName(n), n);
});

// ---------- endpoints ----------

const dbFile = path.join(os.tmpdir(), `printer-times-voice-${crypto.randomUUID()}.db`);
const OWNER_CODE = "printer-voice-owner";
process.env.ORDER_LINKS_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update(OWNER_CODE, "utf8").digest("hex");
const store = await import("../server/lib/order-links");
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
async function assign(key: string, fileName: string, bytes: Buffer, code = OWNER_CODE, fullSize = bytes.length) {
  const qs = new URLSearchParams({ fileName, fullFileSize: String(fullSize) });
  const response = await fetch(`${appBase}/api/printers/status/${key}/assign?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-paid-order-access-code": code },
    body: bytes,
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** Classic CTB header: 420 layers, 14 400 s print time, 0.05 mm. */
function fixtureCtb(machineName = "Mighty 12K"): Buffer {
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
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* ignore */
    }
  }
});

test("assign / clear / voice are owner-only", async () => {
  assert.equal((await assign("mighty-12k-old", "a.ctb", fixtureCtb(), "nope")).status, 401);
  assert.equal((await fetch(`${appBase}/api/printers/status/mighty-12k-old/assign`, { method: "DELETE" })).status, 401);
  const voice = await fetch(`${appBase}/api/printers/voice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "mega print started" }),
  });
  assert.equal(voice.status, 401);
  const board = await owner("GET", "/api/printers/status");
  assert.ok(board.body.printers.every((p: any) => p.assigned == null));
});

test("assign rejects wrong types and unreadable files inline", async () => {
  const stl = await assign("mighty-12k-old", "dragon.stl", Buffer.alloc(512, 1));
  assert.equal(stl.status, 415);
  assert.match(stl.body.error, /\.ctb/);
  const junk = await assign("mighty-12k-old", "broken.ctb", Buffer.alloc(512, 7));
  assert.equal(junk.status, 422);
  const missing = await assign("mighty-revo", "a.ctb", fixtureCtb());
  assert.equal(missing.status, 404);
});

test("assign stores parsed metadata, start uses the file's time and clears it, clear works", async () => {
  // Prefix-only upload of a "larger" file: real size is reported separately.
  const put = await assign("mighty-12k-old", "Knight Squad.ctb", fixtureCtb(), OWNER_CODE, 48_000_000);
  assert.equal(put.status, 200);
  const card = put.body.printers.find((p: any) => p.key === "mighty-12k-old");
  assert.equal(card.assigned.fileName, "Knight Squad.ctb");
  assert.equal(card.assigned.layerCount, 420);
  assert.equal(card.assigned.printTimeSeconds, 14_400);
  assert.equal(card.assigned.sizeBytes, 48_000_000);

  // Replace with another file.
  const replaced = await assign("mighty-12k-old", "Knight Squad v2.ctb", fixtureCtb());
  assert.equal(replaced.body.printers.find((p: any) => p.key === "mighty-12k-old").assigned.fileName, "Knight Squad v2.ctb");

  const started = await owner("POST", "/api/printers/status/mighty-12k-old/start", { useAssigned: true });
  assert.equal(started.status, 201);
  assert.equal(started.body.run.estSeconds, 14_400);
  assert.equal(started.body.run.jobLabel, "Knight Squad v2");
  assert.equal(started.body.run.fileName, "Knight Squad v2.ctb");
  const printing = started.body.printers.find((p: any) => p.key === "mighty-12k-old");
  assert.equal(printing.state, "printing");
  assert.equal(printing.current.estSeconds, 14_400);
  assert.equal(printing.assigned, null);

  const again = await owner("POST", "/api/printers/status/mighty-12k-old/start", { useAssigned: true });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /No slice file/);
  await owner("POST", "/api/printers/status/mighty-12k-old/done");

  await assign("mega-8k-s", "mega.ctb", fixtureCtb("MEGA 8K"));
  const cleared = await owner("DELETE", "/api/printers/status/mega-8k-s/assign");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.printers.find((p: any) => p.key === "mega-8k-s").assigned, null);
});

test("voice: no file -> asks, ambiguous -> candidates, clear match + file -> starts with est hours", async () => {
  const noFile = await owner("POST", "/api/printers/voice", { text: "9012 12K old print started" });
  assert.equal(noFile.status, 200);
  assert.equal(noFile.body.started, false);
  assert.equal(noFile.body.reason, "no_file");
  assert.equal(noFile.body.printerKey, "mighty-12k-old");
  assert.equal(noFile.body.board.printers.find((p: any) => p.key === "mighty-12k-old").state, "idle");

  await assign("mighty-12k-new", "Tank.ctb", fixtureCtb());
  await assign("mighty-8k-newx2", "Bust.ctb", fixtureCtb("Mighty 8K"));

  const ambiguous = await owner("POST", "/api/printers/voice", { text: "9012K print started" });
  assert.equal(ambiguous.body.started, false);
  assert.equal(ambiguous.body.reason, "ambiguous");
  assert.deepEqual(ambiguous.body.candidates.map((c: any) => c.key).sort(), ["mighty-12k-new", "mighty-12k-old"]);
  const tankCandidate = ambiguous.body.candidates.find((c: any) => c.key === "mighty-12k-new");
  assert.equal(tankCandidate.assigned.fileName, "Tank.ctb");
  assert.equal(tankCandidate.estHours, "4 h");
  assert.equal(ambiguous.body.board.printingCount, 0);

  const none = await owner("POST", "/api/printers/voice", { text: "banana bread" });
  assert.equal(none.body.started, false);
  assert.equal(none.body.reason, "no_match");
  assert.equal(none.body.board.printingCount, 0);

  const go = await owner("POST", "/api/printers/voice", { text: "9012K new print started" });
  assert.equal(go.status, 201);
  assert.equal(go.body.started, true);
  assert.equal(go.body.printerKey, "mighty-12k-new");
  assert.equal(go.body.estHours, "4 h");
  assert.equal(go.body.run.estSeconds, 14_400);

  // Confirm a pick from the prompt (printerKey) starts that one.
  const pick = await owner("POST", "/api/printers/voice", { text: "90X2 print started", printerKey: "mighty-8k-newx2" });
  assert.equal(pick.body.started, true);
  assert.equal(pick.body.printerKey, "mighty-8k-newx2");

  // Already printing: asks before replacing the run.
  await assign("mighty-12k-new", "Tank 2.ctb", fixtureCtb());
  const busy = await owner("POST", "/api/printers/voice", { text: "9012K new print started" });
  assert.equal(busy.body.started, false);
  assert.equal(busy.body.reason, "busy");

  const bad = await owner("POST", "/api/printers/voice", { text: "" });
  assert.equal(bad.status, 400);
});
