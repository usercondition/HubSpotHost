/**
 * STL Quote: settings, printer power specs, and pricing math.
 *
 * The 2x / 3x / 4x quote markups (don't-go-below / floor / ask) and the
 * charm rounding are a faithful port of the shop's single pricing engine
 * `~/nerve-center/bin/prometheus-quote` v2.0 (Mac mini) with the numbers from
 * `~/nerve-center/config/prometheus-costs.json` (markup_over_direct_cost
 * dont_go_below 1.0 / floor 2.0 / ask 3.0, minimum_quote_usd 15,
 * rounding_increment_usd 1). Keep both in sync; tests pin the port.
 */

export type PackagingTier = "small" | "medium" | "large";

export type QuotePrinter = {
  id: string;
  /** Official ChituBox / fleet name. */
  name: string;
  /** Manufacturer rated / max system power in watts (null when parked/unknown). */
  watts: number | null;
  /** Default seconds per layer (exposure + lift), an estimate. */
  secondsPerLayer: number;
  /** "manufacturer spec" note shown in settings. */
  specNote: string;
  specUrl: string;
  /** Manufacturer build volume in mm (W x D x H); null = unknown, fit warning skipped. */
  buildMm?: { x: number; y: number; z: number } | null;
  parked?: boolean;
};

export type StlQuoteSettings = {
  version: 1;
  resinName: string;
  bottlePriceUsd: number;
  bottleMassG: number;
  resinDensityGPerMl: number;
  wasteFactor: number;
  /** Estimated support resin as % of model resin. */
  supportAllowancePct: number;
  hollowWallMm: number;
  electricityUsdPerKwh: number;
  electricityNote: string;
  electricityUrl: string;
  layerHeightMm: number;
  plateTimeUsdPerHour: number;
  packagingUsd: Record<PackagingTier, number>;
  /** Largest bounding-box side (mm) that still fits each tier. */
  packagingMaxMm: { small: number; medium: number };
  flatMarkupPct: number;
  /** Fractions over cost, same as prometheus-costs.json markup_over_direct_cost. */
  markups: { dontGoBelow: number; floor: number; ask: number };
  minimumQuoteUsd: number;
  roundingIncrementUsd: number;
  defaultPrinterId: string;
  printers: QuotePrinter[];
};

const PHROZEN_UPS_GUIDE =
  "https://helpcenter.phrozen3d.com/hc/en-us/articles/33355891695897-Comprehensive-Guide-to-Selecting-an-Uninterruptible-Power-Supply-UPS-for-Your-Phrozen-3D-Printer";
const MIGHTY_8K = "https://phrozen3d.com/en/products/sonic-mighty-8k";
const MIGHTY_12K = "https://us.phrozen3d.com/products/sonic-mighty-12k";
const m8k = "Manufacturer spec: System Power 120 W (DC 24V 5A); Phrozen UPS guide lists Sonic Mighty 8K at 120 W. Same rating used for every Mighty 8K revision. Build volume 218 x 123 x 235 mm.";
const m12k = "Manufacturer spec: System Power 120 W (DC 24V 5A). Same rating used for Old and New units. Build volume 218 x 123 x 235 mm.";

export const DEFAULT_QUOTE_PRINTERS: QuotePrinter[] = [
  { id: "mega-8k-s", name: "Phrozen Sonic Mega 8K S", watts: 240, secondsPerLayer: 8, specNote: "Manufacturer spec: System Power Max 240 W (AC 100-240V); build volume 330 x 185 x 300 mm.", buildMm: { x: 330, y: 185, z: 300 }, specUrl: "https://phrozen3d.com/en/products/sonic-mega-8k-s" },
  { id: "mighty-12k-new", name: "Phrozen Sonic Mighty 12K New", watts: 120, secondsPerLayer: 8, specNote: m12k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_12K },
  { id: "mighty-12k-old", name: "Phrozen Sonic Mighty 12K Old", watts: 120, secondsPerLayer: 8, specNote: m12k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_12K },
  { id: "mighty-8k-old", name: "Phrozen Sonic Mighty 8K Old", watts: 120, secondsPerLayer: 8, specNote: m8k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx2", name: "Phrozen Sonic Mighty 8K NEWX2", watts: 120, secondsPerLayer: 8, specNote: m8k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx1", name: "Phrozen Sonic Mighty 8K New X1", watts: 120, secondsPerLayer: 8, specNote: m8k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx3", name: "Phrozen Sonic Mighty 8K NEWX3", watts: 120, secondsPerLayer: 8, specNote: m8k, buildMm: { x: 218, y: 123, z: 235 }, specUrl: MIGHTY_8K },
  { id: "heygears-reflex", name: "HeyGears (UltraCraft Reflex)", watts: 180, secondsPerLayer: 6, specNote: "Manufacturer spec: UltraCraft Reflex RS rated power 180 W, build volume 222 x 122 x 228 mm (no separate Turbo figure published; RS rating used). HeyGears lab avg 4.5 s/layer with PAWW10, default set to 6 s.", buildMm: { x: 222, y: 122, z: 228 }, specUrl: "https://www.heygears.com/hardware/Reflex-RS" },
  { id: "formlabs", name: "Formlabs (parked)", watts: null, secondsPerLayer: 8, specNote: "Parked: not used for quotes.", specUrl: "", parked: true },
];

export const PHROZEN_POWER_GUIDE_URL = PHROZEN_UPS_GUIDE;

export const DEFAULT_STL_QUOTE_SETTINGS: StlQuoteSettings = {
  version: 1,
  resinName: "Elegoo ABS-Like 8K 3.0",
  bottlePriceUsd: 33.99,
  bottleMassG: 2000,
  resinDensityGPerMl: 1.1,
  wasteFactor: 1.1,
  supportAllowancePct: 15,
  hollowWallMm: 2,
  electricityUsdPerKwh: 0.456,
  electricityNote:
    "SDG&E bundled residential average 45.6¢/kWh (Aug 2026 rate alert, AL 4868-E; excludes climate credit). Your TOU tier may differ.",
  electricityUrl: "https://marketplace.sdge.com/sites/default/files/August%202026%20Electric%20Rate%20Change%20Alert.pdf",
  layerHeightMm: 0.05,
  plateTimeUsdPerHour: 2,
  packagingUsd: { small: 1.5, medium: 3, large: 5 },
  packagingMaxMm: { small: 75, medium: 150 },
  flatMarkupPct: 10,
  markups: { dontGoBelow: 1, floor: 2, ask: 3 },
  minimumQuoteUsd: 15,
  roundingIncrementUsd: 1,
  defaultPrinterId: "mighty-8k-newx1",
  printers: DEFAULT_QUOTE_PRINTERS,
};

const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const str = (v: unknown, fallback: string, max = 300) => (typeof v === "string" ? v.slice(0, max) : fallback);

function normalizeBuild(v: unknown): { x: number; y: number; z: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const x = num(o.x, NaN, 1, 5000), y = num(o.y, NaN, 1, 5000), z = num(o.z, NaN, 1, 5000);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

/** Merge untrusted input onto defaults, clamping every number. */
export function normalizeStlQuoteSettings(input: unknown): StlQuoteSettings {
  const d = DEFAULT_STL_QUOTE_SETTINGS;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const printersIn: unknown[] = Array.isArray(i.printers) ? i.printers.slice(0, 30) : d.printers;
  const printers = printersIn
    .map((p: any, idx): QuotePrinter | null => {
      if (!p || typeof p !== "object") return null;
      const base = d.printers.find((x) => x.id === p.id);
      const id = str(p.id, base?.id ?? `printer-${idx}`, 60).trim();
      if (!id) return null;
      return {
        id,
        name: str(p.name, base?.name ?? id, 120),
        watts: p.watts === null ? null : num(p.watts, base?.watts ?? 120, 0, 5000),
        secondsPerLayer: num(p.secondsPerLayer, base?.secondsPerLayer ?? 8, 0.5, 120),
        specNote: str(p.specNote, base?.specNote ?? "", 500),
        specUrl: str(p.specUrl, base?.specUrl ?? "", 500),
        buildMm: normalizeBuild(p.buildMm === undefined ? base?.buildMm : p.buildMm),
        ...(p.parked ? { parked: true } : {}),
      };
    })
    .filter((p): p is QuotePrinter => p !== null);
  const pk = i.packagingUsd ?? {};
  const pm = i.packagingMaxMm ?? {};
  const mk = i.markups ?? {};
  const small = num(pm.small, d.packagingMaxMm.small, 1, 2000);
  const out: StlQuoteSettings = {
    version: 1,
    resinName: str(i.resinName, d.resinName, 120),
    bottlePriceUsd: num(i.bottlePriceUsd, d.bottlePriceUsd, 0.01, 10_000),
    bottleMassG: num(i.bottleMassG, d.bottleMassG, 1, 100_000),
    resinDensityGPerMl: num(i.resinDensityGPerMl, d.resinDensityGPerMl, 0.5, 3),
    wasteFactor: num(i.wasteFactor, d.wasteFactor, 1, 3),
    supportAllowancePct: num(i.supportAllowancePct, d.supportAllowancePct, 0, 200),
    hollowWallMm: num(i.hollowWallMm, d.hollowWallMm, 0.3, 20),
    electricityUsdPerKwh: num(i.electricityUsdPerKwh, d.electricityUsdPerKwh, 0, 5),
    electricityNote: str(i.electricityNote, d.electricityNote, 500),
    electricityUrl: str(i.electricityUrl, d.electricityUrl, 500),
    layerHeightMm: num(i.layerHeightMm, d.layerHeightMm, 0.01, 0.3),
    plateTimeUsdPerHour: num(i.plateTimeUsdPerHour, d.plateTimeUsdPerHour, 0, 1000),
    packagingUsd: {
      small: num(pk.small, d.packagingUsd.small, 0, 1000),
      medium: num(pk.medium, d.packagingUsd.medium, 0, 1000),
      large: num(pk.large, d.packagingUsd.large, 0, 1000),
    },
    packagingMaxMm: { small, medium: Math.max(small, num(pm.medium, d.packagingMaxMm.medium, 1, 5000)) },
    flatMarkupPct: num(i.flatMarkupPct, d.flatMarkupPct, 0, 100),
    markups: {
      dontGoBelow: num(mk.dontGoBelow, d.markups.dontGoBelow, 0, 20),
      floor: num(mk.floor, d.markups.floor, 0, 20),
      ask: num(mk.ask, d.markups.ask, 0, 20),
    },
    minimumQuoteUsd: num(i.minimumQuoteUsd, d.minimumQuoteUsd, 0, 10_000),
    roundingIncrementUsd: num(i.roundingIncrementUsd, d.roundingIncrementUsd, 0, 100),
    defaultPrinterId: str(i.defaultPrinterId, d.defaultPrinterId, 60),
    printers: printers.length ? printers : d.printers,
  };
  if (!out.printers.some((p) => p.id === out.defaultPrinterId && !p.parked)) {
    out.defaultPrinterId = out.printers.find((p) => !p.parked)?.id ?? out.printers[0]!.id;
  }
  return out;
}

export function resinCostPerMl(s: Pick<StlQuoteSettings, "bottlePriceUsd" | "bottleMassG" | "resinDensityGPerMl">): number {
  return s.bottlePriceUsd / (s.bottleMassG / s.resinDensityGPerMl);
}

// ---- prometheus-quote v2.0 port -------------------------------------------
const r2 = (v: number) => Math.round(v * 100) / 100;

/** prometheus round_up: ceil to increment, then at least minimum. */
export function roundUp(value: number, inc: number, minimum: number | null): number {
  let v = inc > 0 ? Math.ceil(Number((value / inc).toFixed(9))) * inc : value;
  if (minimum != null) v = Math.max(v, minimum);
  return r2(v);
}

/** Smallest price ending in 4.99 or 9.99 that is >= x. */
export function charmUp(x: number): number {
  return r2(Math.ceil(Number(((x + 0.01) / 5).toFixed(9))) * 5 - 0.01);
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

export type CostMarkups = {
  /** cost x 2 by default (1 + dont_go_below), rounded up to increment, >= minimum. */
  dontGoBelow: number;
  /** charm_up(max(cost x 3, minimum, don't-go-below)). */
  floor: number;
  /** charm_up(max(cost x 4, minimum, floor)). */
  ask: number;
  multipliers: { dontGoBelow: number; floor: number; ask: number };
  raw: { floor: number; ask: number };
};

/** Cost-only branch of prometheus-quote (no comps, no official ceiling). */
export function costMarkups(direct: number, s: Pick<StlQuoteSettings, "markups" | "minimumQuoteUsd" | "roundingIncrementUsd">): CostMarkups {
  const min = s.minimumQuoteUsd;
  const dgb = roundUp(direct * (1 + s.markups.dontGoBelow), s.roundingIncrementUsd, min);
  const costFloor = Math.max(direct * (1 + s.markups.floor), min);
  const costAsk = Math.max(direct * (1 + s.markups.ask), min);
  const floor = charmUp(Math.max(costFloor, dgb));
  const ask = Math.max(charmUp(Math.max(costAsk, floor)), floor);
  return {
    dontGoBelow: dgb,
    floor,
    ask,
    multipliers: { dontGoBelow: 1 + s.markups.dontGoBelow, floor: 1 + s.markups.floor, ask: 1 + s.markups.ask },
    raw: { floor: r2(direct * (1 + s.markups.floor)), ask: r2(direct * (1 + s.markups.ask)) },
  };
}

// ---- STL quote ---------------------------------------------------------------
export type QuotePart = {
  name: string;
  volumeMl: number;
  surfaceAreaMm2: number;
  heightMm: number;
  bbox: { x: number; y: number; z: number };
};

export type QuoteOptions = {
  printerId?: string;
  hollow?: boolean;
  /** Force a packaging tier instead of the bbox suggestion. */
  packagingTier?: PackagingTier | null;
  /** Override seconds per layer for this quote. */
  secondsPerLayer?: number | null;
  quantity?: number;
  /** Uniform scale factor, aspect locked (1 = 100%). */
  scale?: number;
  /** Each copy ships in its own package (packaging x quantity). */
  separatePackages?: boolean;
  addOns?: QuoteAddOns;
};

/** Optional line items, all included in raw cost before the markups. null/undefined = off. */
export type QuoteAddOns = {
  rushUsd?: number | null;
  /** Base / magnet, charged per copy. */
  baseMagnetUsdEach?: number | null;
  finishing?: { hours: number; usdPerHour: number } | null;
  custom?: { label: string; usd: number } | null;
};

/** Starting amounts when an add-on is switched on (editable per quote). */
export const DEFAULT_ADDON_AMOUNTS = { rushUsd: 10, baseMagnetUsdEach: 2, finishingHours: 0.5, finishingUsdPerHour: 15, customUsd: 5 };

export type AddOnLine = { key: "rush" | "baseMagnet" | "finishing" | "custom"; label: string; usd: number; detail: string };

export type Dims = { x: number; y: number; z: number };

export type FitCheck = { status: "fits" | "too-big" | "unknown"; detail: string };

export type QuoteResult = {
  printer: QuotePrinter;
  quantity: number;
  modelMl: number;
  supportMl: number;
  totalResinMl: number;
  heightMm: number;
  maxSideMm: number;
  layers: number;
  secondsPerLayer: number;
  printHours: number;
  kwh: number;
  packagingTier: PackagingTier;
  suggestedPackagingTier: PackagingTier;
  costs: { resin: number; electricity: number; plateTime: number; packaging: number; addOns: number };
  addOnLines: AddOnLine[];
  scale: number;
  originalDims: Dims;
  scaledDims: Dims;
  originalModelMl: number;
  fit: FitCheck;
  separatePackages: boolean;
  notes: string[];
  rawCost: number;
  flatMarkupPct: number;
  flatPrice: number;
  markups: CostMarkups;
  math: Record<string, string>;
};

const roundDims = (d: Dims): Dims => ({ x: r2(d.x), y: r2(d.y), z: r2(d.z) });

export function suggestPackagingTier(maxSideMm: number, s: Pick<StlQuoteSettings, "packagingMaxMm">): PackagingTier {
  if (maxSideMm <= s.packagingMaxMm.small) return "small";
  if (maxSideMm <= s.packagingMaxMm.medium) return "medium";
  return "large";
}

/** Overall W x D x H of the parts (largest of each axis). */
export function overallDims(parts: Array<Pick<QuotePart, "bbox">>): Dims {
  return {
    x: Math.max(...parts.map((p) => p.bbox.x)),
    y: Math.max(...parts.map((p) => p.bbox.y)),
    z: Math.max(...parts.map((p) => p.bbox.z)),
  };
}

export type TargetSizeMode = "percent" | "height" | "longest" | "width" | "depth";

/** Uniform scale factor from a target (aspect locked). Returns 1 for empty/invalid input. */
export function scaleForTarget(mode: TargetSizeMode, value: number, dims: Dims): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  if (mode === "percent") return value / 100;
  const base = mode === "height" ? dims.z : mode === "width" ? dims.x : mode === "depth" ? dims.y : Math.max(dims.x, dims.y, dims.z);
  return base > 0 ? value / base : 1;
}

/** Scale a part: lengths x s, area x s², volume x s³. */
export function scalePart<T extends QuotePart>(p: T, s: number): T {
  return {
    ...p,
    volumeMl: p.volumeMl * s ** 3,
    surfaceAreaMm2: p.surfaceAreaMm2 * s ** 2,
    heightMm: p.heightMm * s,
    bbox: { x: p.bbox.x * s, y: p.bbox.y * s, z: p.bbox.z * s },
  };
}

/** Does every part fit the printer build volume as modeled (Z up, free to rotate on the plate)? */
export function checkFit(parts: Array<Pick<QuotePart, "name" | "bbox">>, printer: Pick<QuotePrinter, "name" | "buildMm">): FitCheck {
  const b = printer.buildMm;
  if (!b) return { status: "unknown", detail: `No build volume on file for ${printer.name}` };
  const [bx, by] = [b.x, b.y].sort((m, n) => n - m) as [number, number];
  const over = parts.filter((p) => {
    const [px, py] = [p.bbox.x, p.bbox.y].sort((m, n) => n - m) as [number, number];
    return p.bbox.z > b.z || px > bx || py > by;
  });
  if (over.length === 0) return { status: "fits", detail: `Fits ${printer.name} (${b.x} × ${b.y} × ${b.z} mm)` };
  return {
    status: "too-big",
    detail: `${over.map((p) => p.name).join(", ")} exceeds ${printer.name} build volume ${b.x} × ${b.y} × ${b.z} mm. Split, re-orient, or pick a bigger printer.`,
  };
}

export function addOnLines(addOns: QuoteAddOns | undefined, qty: number): AddOnLine[] {
  const out: AddOnLine[] = [];
  if (!addOns) return out;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (ok(addOns.rushUsd)) out.push({ key: "rush", label: "Rush", usd: r2(addOns.rushUsd), detail: "flat" });
  if (ok(addOns.baseMagnetUsdEach)) out.push({ key: "baseMagnet", label: "Base / magnet", usd: r2(addOns.baseMagnetUsdEach * qty), detail: `$${addOns.baseMagnetUsdEach} x ${qty}` });
  if (addOns.finishing && ok(addOns.finishing.hours) && ok(addOns.finishing.usdPerHour)) {
    out.push({ key: "finishing", label: "Supports cleanup / finishing", usd: r2(addOns.finishing.hours * addOns.finishing.usdPerHour), detail: `${addOns.finishing.hours} h x $${addOns.finishing.usdPerHour}/h` });
  }
  if (addOns.custom && ok(addOns.custom.usd)) out.push({ key: "custom", label: addOns.custom.label.trim().slice(0, 60) || "Custom fee", usd: r2(addOns.custom.usd), detail: "flat" });
  return out;
}

/**
 * Parts are printed together on one plate: resin adds up, print time follows
 * the tallest part. quantity multiplies resin (copies on the same plate).
 */
export function computeStlQuote(parts: QuotePart[], s: StlQuoteSettings, opts: QuoteOptions = {}): QuoteResult {
  if (parts.length === 0) throw new Error("Add at least one model");
  const scale = opts.scale && Number.isFinite(opts.scale) && opts.scale > 0 ? Math.min(opts.scale, 100) : 1;
  const originalParts = parts;
  parts = parts.map((p) => scalePart(p, scale));
  const printer =
    s.printers.find((p) => p.id === opts.printerId && !p.parked) ??
    s.printers.find((p) => p.id === s.defaultPrinterId) ??
    s.printers[0]!;
  const qty = Math.max(1, Math.min(500, Math.floor(opts.quantity ?? 1)));
  const perCopyMl = parts.reduce((sum, p) => {
    const solid = p.volumeMl;
    const shell = (p.surfaceAreaMm2 * s.hollowWallMm) / 1000;
    return sum + (opts.hollow ? Math.min(solid, shell) : solid);
  }, 0);
  const modelMl = perCopyMl * qty;
  const supportMl = modelMl * (s.supportAllowancePct / 100);
  const totalResinMl = modelMl + supportMl;
  const perMl = resinCostPerMl(s);
  const resin = totalResinMl * perMl * s.wasteFactor;

  const heightMm = Math.max(...parts.map((p) => p.heightMm));
  const maxSideMm = Math.max(...parts.map((p) => Math.max(p.bbox.x, p.bbox.y, p.bbox.z)));
  const layers = Math.ceil(Number((heightMm / s.layerHeightMm).toFixed(6)));
  const spl = opts.secondsPerLayer && opts.secondsPerLayer > 0 ? opts.secondsPerLayer : printer.secondsPerLayer;
  const printHours = (layers * spl) / 3600;
  const kwh = ((printer.watts ?? 0) / 1000) * printHours;
  const electricity = kwh * s.electricityUsdPerKwh;
  const plateTime = printHours * s.plateTimeUsdPerHour;
  const suggestedPackagingTier = suggestPackagingTier(maxSideMm, s);
  const packagingTier = opts.packagingTier ?? suggestedPackagingTier;
  const separatePackages = !!opts.separatePackages;
  const packaging = s.packagingUsd[packagingTier] * (separatePackages ? qty : 1);
  const lines = addOnLines(opts.addOns, qty);
  const addOnTotal = lines.reduce((sum, l) => sum + l.usd, 0);

  const costs = { resin: r2(resin), electricity: r2(electricity), plateTime: r2(plateTime), packaging: r2(packaging), addOns: r2(addOnTotal) };
  const rawCost = r2(resin + electricity + plateTime + packaging + addOnTotal);
  const notes: string[] = [];
  if (qty > 1) notes.push(`${qty} copies: resin x ${qty}; print time assumes they all fit on one plate (same height = same time).`);
  if (qty > 1 && !separatePackages) notes.push("Packaging counted once (all copies in one package).");
  const originalModelMl = originalParts.reduce((sum, p) => sum + p.volumeMl, 0);
  const flatPrice = r2(rawCost * (1 + s.flatMarkupPct / 100));
  const markups = costMarkups(rawCost, s);
  return {
    printer,
    quantity: qty,
    modelMl: r2(modelMl),
    supportMl: r2(supportMl),
    totalResinMl: r2(totalResinMl),
    heightMm: r2(heightMm),
    maxSideMm: r2(maxSideMm),
    layers,
    secondsPerLayer: spl,
    printHours: r2(printHours),
    kwh: Math.round(kwh * 1000) / 1000,
    packagingTier,
    suggestedPackagingTier,
    costs,
    addOnLines: lines,
    scale,
    originalDims: roundDims(overallDims(originalParts)),
    scaledDims: roundDims(overallDims(parts)),
    originalModelMl: r2(originalModelMl),
    fit: checkFit(parts, printer),
    separatePackages,
    notes,
    rawCost,
    flatMarkupPct: s.flatMarkupPct,
    flatPrice,
    markups,
    math: {
      resin: `(${r2(modelMl)} ml model + ${r2(supportMl)} ml support est. ${s.supportAllowancePct}%) x $${perMl.toFixed(4)}/ml x waste ${s.wasteFactor}${opts.hollow ? ` (hollow, ${s.hollowWallMm} mm wall est.)` : ""}`,
      printTime: `${r2(heightMm)} mm / ${s.layerHeightMm} mm = ${layers} layers x ${spl} s = ${r2(printHours)} h (estimate)`,
      electricity: `${printer.watts ?? 0} W x ${r2(printHours)} h = ${Math.round(kwh * 1000) / 1000} kWh x $${s.electricityUsdPerKwh}/kWh`,
      plateTime: `${r2(printHours)} h x $${s.plateTimeUsdPerHour}/h`,
      packaging: `${packagingTier} (largest side ${r2(maxSideMm)} mm${opts.packagingTier ? ", manual" : ", auto"})${separatePackages && qty > 1 ? ` x ${qty} packages` : ""}`,
      markups: `don't-go-below = cost x ${markups.multipliers.dontGoBelow}, floor = cost x ${markups.multipliers.floor}, ask = cost x ${markups.multipliers.ask}; min $${s.minimumQuoteUsd}, charm-rounded to $x4.99/$x9.99 (prometheus-quote)`,
    },
  };
}

// ---- market check -----------------------------------------------------------
export type MarketSource = "eBay" | "Etsy";
export type MarketComp = { source: MarketSource; title: string; priceUsd: number; url: string };
export type MarketSourceStatus = {
  source: MarketSource;
  status: "ok" | "empty" | "blocked" | "error" | "not-configured";
  method: "api" | "html" | "none";
  detail: string;
};
export type MarketStats = { count: number; low: number; median: number; high: number };
export type MarketCheckResult = {
  ok: boolean;
  query: string;
  checkedAt: string;
  comps: MarketComp[];
  stats: MarketStats | null;
  sources: MarketSourceStatus[];
  /** Env vars that would enable reliable data. */
  credentialsNeeded: string[];
};

export function marketStats(comps: MarketComp[]): MarketStats | null {
  const prices = comps.map((c) => c.priceUsd).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  return { count: prices.length, low: r2(prices[0]!), median: r2(median(prices)), high: r2(prices[prices.length - 1]!) };
}

export type SuggestedPrice = { price: number; rule: string; basis: "market" | "cost" };

/**
 * Suggested final price: the market median clamped up to the 3x floor
 * (never chase the market below the floor), then charm-rounded. Without
 * market data, fall back to the cost-based 4x ask.
 */
export function suggestFinalPrice(quote: Pick<QuoteResult, "markups">, stats: MarketStats | null): SuggestedPrice {
  const { floor, ask, dontGoBelow } = quote.markups;
  if (!stats) {
    return { price: ask, basis: "cost", rule: `No market data, so the cost-based ask ($${ask.toFixed(2)}, cost x ${quote.markups.multipliers.ask}) is suggested.` };
  }
  const target = Math.max(floor, stats.median, dontGoBelow);
  const price = charmUp(target);
  const rule =
    stats.median >= floor
      ? `Market median $${stats.median.toFixed(2)} is at or above the floor ($${floor.toFixed(2)}), so price at the median, charm-rounded up: $${price.toFixed(2)}.`
      : `Market median $${stats.median.toFixed(2)} is below the floor ($${floor.toFixed(2)}); we never undercut the floor, so the floor is suggested: $${price.toFixed(2)}.`;
  return { price, basis: "market", rule };
}

const NOISE = new Set(["stl", "obj", "3mf", "supported", "presupported", "pre", "unsupported", "support", "supports", "hollow", "hollowed", "final", "fixed", "print", "file", "model", "copy", "mm", "scale", "scaled", "v1", "v2", "v3", "v4", "v5", "lys", "chitubox", "lychee", "repaired"]);

/** Default market search term from a file name ("Dragon_Bust_v2_supported.stl" -> "dragon bust resin print"). */
export function searchTermFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "");
  const words = base
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w) && !/^\d+(mm|x|pct|%)$/.test(w) && !/^v\d+$/.test(w));
  const core = words.slice(0, 6).join(" ").trim();
  return core ? `${core} resin print` : "resin print miniature";
}

/** A model with no measurable size (empty, broken, or exported in meters) cannot be priced. */
export function unmeasurableReason(parts: Array<Pick<QuotePart, "bbox" | "volumeMl">>): string | null {
  if (parts.length === 0) return "none";
  const d = overallDims(parts);
  const ml = parts.reduce((s, p) => s + p.volumeMl, 0);
  if (Math.max(d.x, d.y, d.z) < 1 || ml < 0.001) return `${formatDims(d)}, ${ml.toFixed(2)} ml`;
  return null;
}

export function formatDims(d: Dims): string {
  return `${d.x.toFixed(1)} × ${d.y.toFixed(1)} × ${d.z.toFixed(1)} mm`;
}

/** Plain-text quote summary for the clipboard. Nothing is sent anywhere. */
export function buildQuoteSummary(input: { items: string[]; quote: QuoteResult; hollow: boolean; clientNotes: string; suggested?: SuggestedPrice | null; notesLines?: string[] }): string {
  const q = input.quote;
  const lines = [
    `Quote: ${input.items.join(", ")}`,
    `Size: ${formatDims(q.scaledDims)} (W × D × H)${q.scale !== 1 ? ` at ${r2(q.scale * 100)}% of original ${formatDims(q.originalDims)}` : ""}`,
    `Quantity: ${q.quantity}${q.quantity > 1 ? (q.separatePackages ? " (packaged separately)" : " (one package)") : ""}`,
    `Printer: ${q.printer.name} · ${input.hollow ? "hollow" : "solid"}`,
    `Add-ons: ${q.addOnLines.length ? q.addOnLines.map((l) => `${l.label} $${l.usd.toFixed(2)}`).join("; ") : "none"}`,
    `Ask: $${q.markups.ask.toFixed(2)} (floor $${q.markups.floor.toFixed(2)})`,
  ];
  if (input.suggested) lines.push(`Suggested price: $${input.suggested.price.toFixed(2)}`);
  lines.push("Postage at label cost.");
  if (input.clientNotes.trim()) lines.push("", "Client notes:", input.clientNotes.trim());
  if (input.notesLines?.length) lines.push(...(input.clientNotes.trim() ? [] : [""]), ...input.notesLines);
  return lines.join("\n");
}
