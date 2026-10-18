import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { zipSync, strToU8 } from "fflate";
import { parseMeshFile, parseBinaryStl, parseAsciiStl } from "../shared/stl-mesh";
import {
  DEFAULT_STL_QUOTE_SETTINGS,
  charmUp,
  computeStlQuote,
  costMarkups,
  marketStats,
  normalizeStlQuoteSettings,
  scaleForTarget,
  checkFit,
  buildQuoteSummary,
  DEFAULT_QUOTE_PRINTERS,
  resinCostPerMl,
  roundUp,
  searchTermFromFileName,
  suggestFinalPrice,
} from "../shared/stl-quote";
import { checkMarket, parseEbaySearchHtml } from "../server/lib/market-comps";
import { registerStlQuoteRoutes } from "../server/lib/stl-quote-routes";

type V = [number, number, number];
/** Outward-wound cube triangles, side s, min corner at origin. */
function cubeTris(s: number): Array<[V, V, V]> {
  const p = (x: number, y: number, z: number): V => [x * s, y * s, z * s];
  const q = (a: V, b: V, c: V, d: V): Array<[V, V, V]> => [[a, b, c], [a, c, d]];
  return [
    ...q(p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)), // bottom (-z)
    ...q(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)), // top (+z)
    ...q(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)), // -y
    ...q(p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)), // +y
    ...q(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)), // -x
    ...q(p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)), // +x
  ];
}
function binaryStl(tris: Array<[V, V, V]>): Uint8Array {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.flat().forEach((v, k) => dv.setFloat32(84 + i * 50 + 12 + k * 4, v, true)));
  return new Uint8Array(buf);
}
function asciiStl(tris: Array<[V, V, V]>): string {
  return `solid cube\n${tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((v) => `  vertex ${v.join(" ")}`).join("\n")}\n endloop\nendfacet`).join("\n")}\nendsolid cube\n`;
}

test("binary STL cube: 20 mm cube = 8 ml, bbox 20^3, area 2400", () => {
  const m = parseMeshFile("cube.stl", binaryStl(cubeTris(20)));
  assert.equal(m.format, "stl-binary");
  assert.equal(m.triangles, 12);
  assert.equal(m.volumeMl, 8);
  assert.deepEqual(m.bbox, { x: 20, y: 20, z: 20 });
  assert.equal(m.heightMm, 20);
  assert.equal(m.surfaceAreaMm2, 2400);
  assert.equal(m.inverted, false);
});

test("ASCII STL cube matches binary; inverted winding still gives absolute volume", () => {
  const a = parseMeshFile("cube.stl", strToU8(asciiStl(cubeTris(10))));
  assert.equal(a.format, "stl-ascii");
  assert.equal(a.volumeMl, 1);
  const inv = parseBinaryStl(binaryStl(cubeTris(10).map(([x, y, z]) => [x, z, y] as [V, V, V])));
  assert.equal(inv.volumeMl, 1);
  assert.equal(inv.inverted, true);
  assert.throws(() => parseAsciiStl("solid empty\nendsolid"), /No triangles/);
});

test("binary STL whose header starts with 'solid' is still read as binary", () => {
  const bytes = binaryStl(cubeTris(10));
  bytes.set(strToU8("solid exported-by-cad"), 0);
  assert.equal(parseMeshFile("x.stl", bytes).volumeMl, 1);
});

test("OBJ quads and 3MF (cm units) cubes", () => {
  const obj = "v 0 0 0\nv 10 0 0\nv 10 10 0\nv 0 10 0\nv 0 0 10\nv 10 0 10\nv 10 10 10\nv 0 10 10\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 4 8 7 3\nf 1 5 8 4\nf 2 3 7 6\n";
  assert.equal(parseMeshFile("c.obj", strToU8(obj)).volumeMl, 1);
  const verts = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,3,2],[0,2,1],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  const xml = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${verts.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")}</vertices><triangles>${faces.map(([a,b,c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("")}</triangles></mesh></object></resources></model>`;
  const m = parseMeshFile("c.3mf", zipSync({ "3D/3dmodel.model": strToU8(xml) }));
  assert.equal(m.volumeMl, 1); // 1 cm cube = 1 ml
  assert.equal(m.heightMm, 10);
  assert.throws(() => parseMeshFile("c.step", new Uint8Array(10)), /Unsupported/);
});

test("prometheus-quote port: round_up, charm_up, cost markups", () => {
  assert.equal(charmUp(10), 14.99);
  assert.equal(charmUp(14.99), 14.99);
  assert.equal(charmUp(15), 19.99);
  assert.equal(roundUp(12.01, 1, 15), 15);
  assert.equal(roundUp(17.2, 1, 15), 18);
  // direct $10: dgb 2x=20, floor 3x=30 -> 34.99, ask 4x=40 -> 44.99
  const m = costMarkups(10, DEFAULT_STL_QUOTE_SETTINGS);
  assert.deepEqual([m.dontGoBelow, m.floor, m.ask], [20, 34.99, 44.99]);
  assert.deepEqual(m.multipliers, { dontGoBelow: 2, floor: 3, ask: 4 });
  // tiny job: minimum $15 governs
  const t = costMarkups(2, DEFAULT_STL_QUOTE_SETTINGS);
  assert.deepEqual([t.dontGoBelow, t.floor, t.ask], [15, 19.99, 19.99]);
});

test("STL quote math with defaults (20 mm cube on Mighty 8K)", () => {
  const cube = { name: "cube.stl", volumeMl: 8, surfaceAreaMm2: 2400, heightMm: 20, bbox: { x: 20, y: 20, z: 20 } };
  const q = computeStlQuote([cube], DEFAULT_STL_QUOTE_SETTINGS, { printerId: "mighty-8k-newx1" });
  const perMl = 33.99 / (2000 / 1.1);
  assert.ok(Math.abs(resinCostPerMl(DEFAULT_STL_QUOTE_SETTINGS) - perMl) < 1e-12);
  assert.equal(q.modelMl, 8);
  assert.equal(q.supportMl, 1.2);
  assert.equal(q.costs.resin, Math.round(9.2 * perMl * 1.1 * 100) / 100); // 0.19
  assert.equal(q.layers, 400);
  assert.equal(q.printHours, Math.round((400 * 8) / 36) / 100); // 0.89
  const hours = 3200 / 3600;
  assert.equal(q.costs.electricity, Math.round(0.12 * hours * 0.456 * 100) / 100); // 0.05
  assert.equal(q.costs.plateTime, Math.round(hours * 2 * 100) / 100); // 1.78
  assert.equal(q.packagingTier, "small");
  assert.equal(q.costs.packaging, 1.5);
  const raw = Math.round((9.2 * perMl * 1.1 + 0.12 * hours * 0.456 + hours * 2 + 1.5) * 100) / 100;
  assert.equal(q.rawCost, raw);
  assert.equal(q.flatPrice, Math.round(raw * 1.1 * 100) / 100);
  assert.equal(q.markups.floor, 19.99); // min $15 governs
  // hollow uses min(solid, area x wall): 2400*2/1000 = 4.8 ml
  assert.equal(computeStlQuote([cube], DEFAULT_STL_QUOTE_SETTINGS, { hollow: true }).modelMl, 4.8);
  // multiple parts: resin adds, time follows tallest, packaging by largest side
  const tall = { ...cube, name: "tall.stl", heightMm: 100, bbox: { x: 30, y: 30, z: 100 } };
  const both = computeStlQuote([cube, tall], DEFAULT_STL_QUOTE_SETTINGS, { quantity: 2 });
  assert.equal(both.modelMl, 32);
  assert.equal(both.layers, 2000);
  assert.equal(both.packagingTier, "medium");
  assert.equal(computeStlQuote([cube], DEFAULT_STL_QUOTE_SETTINGS, { packagingTier: "large" }).costs.packaging, 5);
});

test("settings normalization clamps junk and keeps defaults", () => {
  const s = normalizeStlQuoteSettings({ wasteFactor: 0.2, flatMarkupPct: "7", printers: [{ id: "mega-8k-s", watts: -5 }], defaultPrinterId: "nope" });
  assert.equal(s.wasteFactor, 1.1);
  assert.equal(s.flatMarkupPct, 7);
  assert.equal(s.printers.length, 1);
  assert.equal(s.printers[0]!.watts, 240);
  assert.equal(s.defaultPrinterId, "mega-8k-s");
  assert.deepEqual(s.printers[0]!.buildMm, { x: 330, y: 185, z: 300 });
  assert.equal(normalizeStlQuoteSettings({ printers: [{ id: "mega-8k-s", buildMm: { x: 0, y: 1, z: 1 } }] }).printers[0]!.buildMm, null);
});

test("market stats, suggested price, search term", () => {
  const comps = [20, 30, 25, 50].map((p, i) => ({ source: "eBay" as const, title: `t${i}`, priceUsd: p, url: `https://www.ebay.com/itm/${i}` }));
  assert.deepEqual(marketStats(comps), { count: 4, low: 20, median: 27.5, high: 50 });
  assert.equal(marketStats([]), null);
  const markups = costMarkups(10, DEFAULT_STL_QUOTE_SETTINGS); // floor 34.99, ask 44.99
  assert.equal(suggestFinalPrice({ markups }, { count: 3, low: 30, median: 52, high: 80 }).price, 54.99);
  assert.equal(suggestFinalPrice({ markups }, { count: 3, low: 10, median: 20, high: 30 }).price, 34.99);
  const none = suggestFinalPrice({ markups }, null);
  assert.equal(none.price, 44.99);
  assert.equal(none.basis, "cost");
  assert.equal(searchTermFromFileName("Dragon_Bust_v2_supported.stl"), "dragon bust resin print");
  assert.equal(searchTermFromFileName("KnightCastellan-75mm.3mf"), "knight castellan resin print");
  assert.equal(searchTermFromFileName("123.stl"), "resin print miniature");
});

test("market check: blocked public pages give an honest unavailable state", async () => {
  const fake = (async () => new Response("blocked", { status: 403 })) as typeof fetch;
  const r = await checkMarket("dragon resin print", {}, fake);
  assert.equal(r.ok, false);
  assert.equal(r.comps.length, 0);
  assert.equal(r.stats, null);
  assert.deepEqual(r.sources.map((s) => s.status), ["blocked", "blocked"]);
  assert.equal(r.credentialsNeeded.length, 2);
});

test("market check: eBay Browse API + Etsy v3 when credentials exist", async () => {
  const calls: string[] = [];
  const fake = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("oauth2/token")) return Response.json({ access_token: "tok", expires_in: 7200 });
    if (u.includes("item_summary/search")) return Response.json({ itemSummaries: [{ title: "A", itemWebUrl: "https://www.ebay.com/itm/1", price: { value: "24.00", currency: "USD" } }, { title: "B", itemWebUrl: "https://www.ebay.com/itm/2", price: { value: "40.00", currency: "USD" } }] });
    if (u.includes("openapi.etsy.com")) return Response.json({ results: [{ title: "C", url: "https://www.etsy.com/listing/3", price: { amount: 3000, divisor: 100, currency_code: "USD" } }] });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const r = await checkMarket("dragon", { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s", ETSY_API_KEY: "k" }, fake);
  assert.equal(r.ok, true);
  assert.deepEqual(r.stats, { count: 3, low: 24, median: 30, high: 40 });
  assert.equal(r.credentialsNeeded.length, 0);
  assert.ok(!calls.some((c) => c.includes("www.ebay.com/sch") || c.includes("www.etsy.com/search")));
});

test("eBay HTML parser reads s-card listings and skips the placeholder card", () => {
  const html = `<ul><li class="s-card s-card--horizontal"><a href="https://www.ebay.com/itm/111?x=1"><div class="s-card__title"><span>Shop on eBay</span></div></a><span class="s-card__price">$20.00</span></li>
  <li class="s-card"><a href="https://www.ebay.com/itm/222?hash=1"><div class="s-card__title"><span>Resin dragon bust</span></div></a><span class="s-card__price">$31.50</span></li></ul>`;
  assert.deepEqual(parseEbaySearchHtml(html), [{ source: "eBay", title: "Resin dragon bust", priceUsd: 31.5, url: "https://www.ebay.com/itm/222" }]);
});

test("routes: owner gate, settings round-trip, market validation", async () => {
  const app = express();
  app.use(express.json());
  registerStlQuoteRoutes(app, (req, res) => {
    if (req.header("x-paid-order-access-code") === "ok") return false;
    res.status(401).json({ ok: false });
    return true;
  }, { fetch: (async () => new Response("", { status: 403 })) as typeof fetch, env: {} });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const h = { "content-type": "application/json", "x-paid-order-access-code": "ok" };
  try {
    assert.equal((await fetch(`${base}/api/stl-quote/settings`)).status, 401);
    assert.equal((await fetch(`${base}/api/stl-quote/market`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    await fetch(`${base}/api/stl-quote/settings`, { method: "DELETE", headers: h });
    const put = await fetch(`${base}/api/stl-quote/settings`, { method: "PUT", headers: h, body: JSON.stringify({ settings: { ...DEFAULT_STL_QUOTE_SETTINGS, flatMarkupPct: 5 } }) });
    assert.equal(put.status, 200);
    const got = await (await fetch(`${base}/api/stl-quote/settings`, { headers: h })).json();
    assert.equal(got.settings.flatMarkupPct, 5);
    assert.ok(got.updatedAt);
    assert.equal((await fetch(`${base}/api/stl-quote/market`, { method: "POST", headers: h, body: JSON.stringify({ query: "" }) })).status, 400);
    const m = await (await fetch(`${base}/api/stl-quote/market`, { method: "POST", headers: h, body: JSON.stringify({ query: "dragon" }) })).json();
    assert.equal(m.stats, null);
    await fetch(`${base}/api/stl-quote/settings`, { method: "DELETE", headers: h });
  } finally {
    server.close();
  }
});

const cube20 = { name: "cube.stl", volumeMl: 8, surfaceAreaMm2: 2400, heightMm: 20, bbox: { x: 20, y: 20, z: 20 } };

test("Revo removed from default printers; Mighty/Mega/HeyGears have build volumes", () => {
  assert.ok(!DEFAULT_QUOTE_PRINTERS.some((p) => /revo/i.test(p.id + p.name)));
  for (const p of DEFAULT_QUOTE_PRINTERS.filter((x) => !x.parked)) assert.ok(p.buildMm, p.id);
});

test("scaling: 200% gives 8x volume, 2x height and time; dims and packaging re-pick", () => {
  const s = DEFAULT_STL_QUOTE_SETTINGS;
  const base = computeStlQuote([cube20], s);
  const big = computeStlQuote([cube20], s, { scale: 2 });
  assert.equal(big.modelMl, 64); // 8 ml x 2^3
  assert.equal(big.originalModelMl, 8);
  assert.equal(big.heightMm, 40);
  assert.equal(big.layers, base.layers * 2);
  assert.deepEqual(big.originalDims, { x: 20, y: 20, z: 20 });
  assert.deepEqual(big.scaledDims, { x: 40, y: 40, z: 40 });
  assert.ok(Math.abs(big.printHours - base.printHours * 2) < 0.011);
  assert.equal(computeStlQuote([cube20], s, { scale: 3.75 }).packagingTier, "small"); // 75 mm = small limit
  assert.equal(computeStlQuote([cube20], s, { scale: 4 }).packagingTier, "medium"); // 80 mm
  assert.equal(computeStlQuote([cube20], s, { scale: 8 }).packagingTier, "large"); // 160 mm
  // hollow shell scales with area (s^2)
  assert.equal(computeStlQuote([cube20], s, { scale: 2, hollow: true }).modelMl, 19.2);
  // markups follow the new cost
  assert.ok(big.rawCost > base.rawCost);
  assert.equal(big.markups.dontGoBelow, Math.max(15, Math.ceil(big.rawCost * 2)));
});

test("target size helpers lock aspect", () => {
  const d = { x: 44, y: 44, z: 62 };
  assert.equal(scaleForTarget("percent", 150, d), 1.5);
  assert.equal(scaleForTarget("height", 124, d), 2);
  assert.equal(scaleForTarget("longest", 31, d), 0.5);
  assert.equal(scaleForTarget("height", 0, d), 1);
  assert.equal(scaleForTarget("percent", NaN, d), 1);
});

test("fit check against printer build volume (rotation on the plate allowed)", () => {
  const p = { name: "M8K", buildMm: { x: 218, y: 123, z: 235 } };
  assert.equal(checkFit([{ name: "a", bbox: { x: 120, y: 200, z: 100 } }], p).status, "fits");
  assert.equal(checkFit([{ name: "a", bbox: { x: 50, y: 50, z: 240 } }], p).status, "too-big");
  assert.equal(checkFit([{ name: "a", bbox: { x: 130, y: 130, z: 50 } }], p).status, "too-big");
  assert.equal(checkFit([{ name: "a", bbox: { x: 1, y: 1, z: 1 } }], { name: "X", buildMm: null }).status, "unknown");
  const q = computeStlQuote([cube20], DEFAULT_STL_QUOTE_SETTINGS, { printerId: "mighty-8k-newx1", scale: 12 }); // 240 mm tall
  assert.equal(q.fit.status, "too-big");
});

test("quantity: resin x qty, time unchanged, packaging x qty only when separate", () => {
  const s = DEFAULT_STL_QUOTE_SETTINGS;
  const one = computeStlQuote([cube20], s);
  const three = computeStlQuote([cube20], s, { quantity: 3 });
  const sep = computeStlQuote([cube20], s, { quantity: 3, separatePackages: true });
  assert.equal(three.modelMl, 24);
  assert.equal(three.printHours, one.printHours);
  assert.equal(three.costs.packaging, 1.5);
  assert.equal(sep.costs.packaging, 4.5);
  assert.ok(three.notes.some((n) => /one plate/.test(n)));
});

test("add-ons are off by default and added to raw cost before markups", () => {
  const s = DEFAULT_STL_QUOTE_SETTINGS;
  const plain = computeStlQuote([cube20], s, { quantity: 2 });
  assert.equal(plain.addOnLines.length, 0);
  assert.equal(plain.costs.addOns, 0);
  const q = computeStlQuote([cube20], s, {
    quantity: 2,
    addOns: { rushUsd: 10, baseMagnetUsdEach: 2, finishing: { hours: 0.5, usdPerHour: 15 }, custom: { label: "Paint test", usd: 5 } },
  });
  assert.deepEqual(q.addOnLines.map((l) => [l.key, l.usd]), [["rush", 10], ["baseMagnet", 4], ["finishing", 7.5], ["custom", 5]]);
  assert.equal(q.costs.addOns, 26.5);
  assert.equal(q.rawCost, Math.round((plain.rawCost + 26.5) * 100) / 100);
  assert.equal(q.flatPrice, Math.round(q.rawCost * 1.1 * 100) / 100);
  assert.equal(q.markups.dontGoBelow, Math.ceil(q.rawCost * 2));
  assert.equal(computeStlQuote([cube20], s, { addOns: { rushUsd: null, custom: { label: "", usd: 3 } } }).addOnLines[0]!.label, "Custom fee");
});

test("quote summary text has item, size, qty, add-ons, ask, and notes", () => {
  const q = computeStlQuote([cube20], DEFAULT_STL_QUOTE_SETTINGS, { scale: 2, quantity: 2, addOns: { rushUsd: 10 } });
  const text = buildQuoteSummary({ items: ["cube.stl"], quote: q, hollow: false, clientNotes: "Wants it 40 mm tall", suggested: null });
  assert.match(text, /Quote: cube\.stl/);
  assert.match(text, /Size: 40\.0 × 40\.0 × 40\.0 mm .* at 200% of original 20\.0 × 20\.0 × 20\.0 mm/);
  assert.match(text, /Quantity: 2 \(one package\)/);
  assert.match(text, /Add-ons: Rush \$10\.00/);
  assert.match(text, new RegExp(`Ask: \\$${q.markups.ask.toFixed(2).replace(".", "\\.")}`));
  assert.match(text, /Client notes:\nWants it 40 mm tall/);
});
