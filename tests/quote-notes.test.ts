import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { parseBinaryStl } from "../shared/stl-mesh";
import { DEFAULT_ADDON_AMOUNTS, DEFAULT_STL_QUOTE_SETTINGS, buildQuoteSummary, computeStlQuote, overallDims, scaleForTarget, unmeasurableReason, type QuotePart } from "../shared/stl-quote";
import { activeChips, applyNoteChips, interpretNotes, notesSummaryLines, validateAiChanges, type QuoteModifierState } from "../shared/quote-notes";
import { notesAiConfig, interpretNotesWithAi } from "../server/lib/quote-notes-ai";
import { registerStlQuoteRoutes } from "../server/lib/stl-quote-routes";

type V = [number, number, number];
function cubeStl(s: number): Uint8Array {
  const p = (x: number, y: number, z: number): V => [x * s, y * s, z * s];
  const q = (a: V, b: V, c: V, d: V): Array<[V, V, V]> => [[a, b, c], [a, c, d]];
  const tris = [
    ...q(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), ...q(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)),
    ...q(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), ...q(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)),
    ...q(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), ...q(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)),
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.forEach((v, j) => v.forEach((c, k) => dv.setFloat32(84 + i * 50 + 12 + j * 12 + k * 4, c, true))));
  return new Uint8Array(buf);
}
const stats = parseBinaryStl(cubeStl(20));
const part: QuotePart = { name: "cube.stl", volumeMl: stats.volumeMl, surfaceAreaMm2: stats.surfaceAreaMm2, heightMm: stats.heightMm, bbox: stats.bbox };
const base: QuoteModifierState = {
  sizeMode: "percent", sizeValue: "", quantity: 1, hollow: false, separate: false,
  addOn: { rush: false, rushUsd: DEFAULT_ADDON_AMOUNTS.rushUsd, base: false, baseUsd: DEFAULT_ADDON_AMOUNTS.baseMagnetUsdEach, finishing: false, finHours: DEFAULT_ADDON_AMOUNTS.finishingHours, finRate: DEFAULT_ADDON_AMOUNTS.finishingUsdPerHour, custom: false, customLabel: "Custom fee", customUsd: DEFAULT_ADDON_AMOUNTS.customUsd },
};
function quoteFor(notes: string, removed = new Set<string>(), accepted = new Set<string>()) {
  const live = activeChips(interpretNotes(notes).chips, removed, accepted);
  const e = applyNoteChips(base, live);
  const scale = e.sizeValue ? scaleForTarget(e.sizeMode, Number(e.sizeValue), overallDims([part])) : 1;
  const a = e.addOn;
  return computeStlQuote([part], DEFAULT_STL_QUOTE_SETTINGS, {
    hollow: e.hollow, quantity: e.quantity, scale, separatePackages: e.separate,
    addOns: { rushUsd: a.rush ? a.rushUsd : null, baseMagnetUsdEach: a.base ? a.baseUsd : null, finishing: a.finishing ? { hours: a.finHours, usdPerHour: a.finRate } : null, custom: a.custom ? { label: a.customLabel, usd: a.customUsd } : null },
  });
}
const one = (t: string) => interpretNotes(t).chips.filter((c) => !c.overridden).map((c) => c.change);

test("Miguel's note: '6mm tall' rescales the real STL and reprices", () => {
  const before = quoteFor("");
  const after = quoteFor("the client wants this be 6mm tall");
  assert.equal(before.scaledDims.z, 20);
  assert.equal(after.scaledDims.z, 6);
  assert.equal(after.scaledDims.x, 6); // aspect locked
  assert.ok(Math.abs(after.scale - 0.3) < 1e-9);
  assert.ok(after.costs.resin < before.costs.resin / 10, "resin scales with volume");
  assert.ok(after.rawCost < before.rawCost);
  assert.deepEqual(interpretNotes("the client wants this be 6mm tall").unparsed, []);
});

test("sizes: mm, inches, percent, multipliers, width/height/depth, bare mm", () => {
  assert.deepEqual(one("75 mm"), [{ field: "size", mode: "height", value: 75 }]);
  assert.deepEqual(one("3 inches tall"), [{ field: "size", mode: "height", value: 76.2 }]);
  assert.deepEqual(one("2.5cm wide"), [{ field: "size", mode: "width", value: 25 }]);
  assert.deepEqual(one("30 mm deep"), [{ field: "size", mode: "depth", value: 30 }]);
  assert.deepEqual(one("height 120mm"), [{ field: "size", mode: "height", value: 120 }]);
  assert.deepEqual(one("150%"), [{ field: "size", mode: "percent", value: 150 }]);
  assert.deepEqual(one("twice as big"), [{ field: "size", mode: "percent", value: 200 }]);
  assert.deepEqual(one("half size"), [{ field: "size", mode: "percent", value: 50 }]);
  assert.deepEqual(one("1.5x bigger"), [{ field: "size", mode: "percent", value: 150 }]);
  assert.deepEqual(one("20% smaller"), [{ field: "size", mode: "percent", value: 80 }]);
  assert.equal(quoteFor("40mm wide").scaledDims.x, 40);
});

test("'28mm scale' is only a suggestion until accepted", () => {
  const { chips } = interpretNotes("28mm scale");
  assert.equal(chips.length, 1);
  assert.equal(chips[0]!.confidence, "suggested");
  assert.equal(quoteFor("28mm scale").scale, 1);
  assert.equal(quoteFor("28mm scale", new Set(), new Set([chips[0]!.id])).scaledDims.z, 28);
});

test("copies, rush, base/magnet, finishing, hollow, packaging, custom fee", () => {
  for (const [t, n] of [["x4", 4], ["4 copies", 4], ["set of 3", 3], ["three copies", 3], ["qty 5", 5], ["a pair of them", 2]] as const) {
    assert.deepEqual(one(t), [{ field: "quantity", value: n }], t);
  }
  assert.deepEqual(one("need it by friday"), [{ field: "rush", on: true }]);
  assert.deepEqual(one("$15 rush"), [{ field: "rush", on: true, usd: 15 }]);
  assert.deepEqual(one("no rush"), [{ field: "rush", on: false }]);
  assert.deepEqual(one("on a magnetized base"), [{ field: "baseMagnet", on: true }]);
  assert.deepEqual(one("painted and primed"), [{ field: "finishing", on: true }]);
  assert.deepEqual(one("supports cleanup 2 hours"), [{ field: "finishing", on: true, hours: 2 }]);
  assert.deepEqual(one("hollow please"), [{ field: "hollow", on: true }]);
  assert.deepEqual(one("solid"), [{ field: "hollow", on: false }]);
  assert.deepEqual(one("package each separately"), [{ field: "separatePackages", on: true }]);
  assert.deepEqual(one("+$10 for decals"), [{ field: "custom", usd: 10, label: "Decals" }]);

  const q = quoteFor("set of 3, magnetized base, need it by friday, +$10 for decals, package separately");
  assert.equal(q.quantity, 3);
  assert.equal(q.separatePackages, true);
  const byKey = Object.fromEntries(q.addOnLines.map((l) => [l.key, l.usd]));
  assert.equal(byKey.rush, DEFAULT_ADDON_AMOUNTS.rushUsd);
  assert.equal(byKey.baseMagnet, DEFAULT_ADDON_AMOUNTS.baseMagnetUsdEach * 3);
  assert.equal(byKey.custom, 10);
  assert.ok(q.rawCost > quoteFor("").rawCost);
});

test("never invents: unknown text and non-size numbers stay as notes", () => {
  assert.deepEqual(interpretNotes("wants it in red").unparsed, ["wants it in red"]);
  const d = interpretNotes("10% off if they buy 2");
  assert.equal(d.chips.length, 0);
  assert.equal(d.unparsed.length, 1);
  const m = interpretNotes("6mm magnets");
  assert.ok(!m.chips.some((c) => c.change.field === "size"), "6mm magnets is not a size");
  assert.equal(interpretNotes("40x30x60mm").chips.length, 0);
});

test("removing a chip reverts the change; last size wins", () => {
  const { chips } = interpretNotes("6mm tall");
  assert.equal(quoteFor("6mm tall", new Set([chips[0]!.id])).scale, 1);
  const two = interpretNotes("75 mm, actually 6mm tall");
  assert.equal(two.chips.filter((c) => c.overridden).length, 1);
  assert.equal(quoteFor("75 mm, actually 6mm tall").scaledDims.z, 6);
});

test("summary includes notes plus applied and not-applied lines", () => {
  const notes = "6mm tall, x4, wants it in red";
  const it = interpretNotes(notes);
  const live = activeChips(it.chips, new Set(), new Set());
  const text = buildQuoteSummary({ items: ["cube.stl"], quote: quoteFor(notes), hollow: false, clientNotes: notes, notesLines: notesSummaryLines(live, it.unparsed) });
  assert.match(text, /Client notes:\n6mm tall, x4, wants it in red/);
  assert.match(text, /Applied from notes: Target height 6 mm \("6mm tall"\); 4 copies \("x4"\)/);
  assert.match(text, /Not applied \(check by hand\): "wants it in red"/);
  assert.match(text, /Quantity: 4/);
});

test("no STL / degenerate model is unmeasurable (no near-zero quote)", () => {
  assert.equal(unmeasurableReason([]), "none");
  assert.match(unmeasurableReason([{ volumeMl: 0, bbox: { x: 0.01, y: 0.02, z: 0.1 } }])!, /0\.0 × 0\.0 × 0\.1 mm, 0\.00 ml/);
  assert.equal(unmeasurableReason([part]), null);
});

test("AI fallback: validation drops invented numbers and non-verbatim sources", () => {
  const notes = "make the sword arm about four cm longer, and they want it like the box art 32 tall";
  const chips = validateAiChanges({ changes: [
    { field: "size", mode: "height", value: 32, unit: "mm", source: "32 tall" },
    { field: "size", mode: "height", value: 40, unit: "mm", source: "four cm longer" }, // number not in source
    { field: "quantity", value: 2, source: "two copies" }, // not in notes
    { field: "printer", source: "box art" }, // unknown field
  ] }, notes);
  assert.equal(chips.length, 1);
  assert.equal(chips[0]!.confidence, "suggested");
  assert.equal(chips[0]!.origin, "ai");
  assert.deepEqual(chips[0]!.change, { field: "size", mode: "height", value: 32 });
});

test("AI fallback: config from existing key names only; off without a key", async () => {
  assert.equal(notesAiConfig({}), null);
  assert.deepEqual(notesAiConfig({ TRACKER_ASSISTANT_API_KEY: "k", TRACKER_ASSISTANT_BASE_URL: "https://api.x.ai/v1/" }), { apiKey: "k", baseUrl: "https://api.x.ai/v1", model: "grok-3-mini" });
  assert.equal(notesAiConfig({ OPENAI_API_KEY: "k" })!.model, "gpt-4o-mini");
  const r = await interpretNotesWithAi("x", ["x"], {}, (async () => { throw new Error("must not call"); }) as any);
  assert.equal(r.ok, false);
  let sent: any = null;
  const fake = (async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ changes: [{ field: "quantity", value: 6, source: "half a dozen" }, { field: "finishing", on: true, source: "weathered look" }] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const ok = await interpretNotesWithAi("half a dozen, weathered look, 6mm tall", ["half a dozen", "weathered look"], { TRACKER_ASSISTANT_API_KEY: "k" }, fake);
  assert.ok(ok.ok);
  assert.equal(sent.messages[1].content, "half a dozen\nweathered look"); // only unparsed text is sent
  if (ok.ok) assert.deepEqual(ok.chips.map((c) => c.change), [{ field: "finishing", on: true }]); // "6" is not in "half a dozen"
});

test("notes-ai routes are owner-gated and report availability", async () => {
  const app = express();
  app.use(express.json());
  let allow = false;
  registerStlQuoteRoutes(app, (_req, res) => { if (!allow) { res.status(401).json({ ok: false }); return true; } return false; }, { env: {} });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/stl-quote/notes-ai`)).status, 401);
    allow = true;
    const g = await (await fetch(`http://127.0.0.1:${port}/api/stl-quote/notes-ai`)).json();
    assert.deepEqual(g, { ok: true, available: false, model: null });
    const p = await fetch(`http://127.0.0.1:${port}/api/stl-quote/notes-ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: "red", unparsed: ["red"] }) });
    assert.equal(p.status, 503);
  } finally {
    server.close();
  }
});
