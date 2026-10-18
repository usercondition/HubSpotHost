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
const m8k = "Manufacturer spec: System Power 120 W (DC 24V 5A); Phrozen UPS guide lists Sonic Mighty 8K at 120 W. Same rating used for every Mighty 8K revision.";
const m12k = "Manufacturer spec: System Power 120 W (DC 24V 5A). Same rating used for Old and New units.";

export const DEFAULT_QUOTE_PRINTERS: QuotePrinter[] = [
  { id: "mega-8k-s", name: "Phrozen Sonic Mega 8K S", watts: 240, secondsPerLayer: 8, specNote: "Manufacturer spec: System Power Max 240 W (AC 100-240V).", specUrl: "https://phrozen3d.com/en/products/sonic-mega-8k-s" },
  { id: "mighty-12k-new", name: "Phrozen Sonic Mighty 12K New", watts: 120, secondsPerLayer: 8, specNote: m12k, specUrl: MIGHTY_12K },
  { id: "mighty-12k-old", name: "Phrozen Sonic Mighty 12K Old", watts: 120, secondsPerLayer: 8, specNote: m12k, specUrl: MIGHTY_12K },
  { id: "mighty-8k-old", name: "Phrozen Sonic Mighty 8K Old", watts: 120, secondsPerLayer: 8, specNote: m8k, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx2", name: "Phrozen Sonic Mighty 8K NEWX2", watts: 120, secondsPerLayer: 8, specNote: m8k, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx1", name: "Phrozen Sonic Mighty 8K New X1", watts: 120, secondsPerLayer: 8, specNote: m8k, specUrl: MIGHTY_8K },
  { id: "mighty-8k-newx3", name: "Phrozen Sonic Mighty 8K NEWX3", watts: 120, secondsPerLayer: 8, specNote: m8k, specUrl: MIGHTY_8K },
  { id: "heygears-reflex", name: "HeyGears (UltraCraft Reflex)", watts: 180, secondsPerLayer: 6, specNote: "Manufacturer spec: UltraCraft Reflex RS rated power 180 W (no separate Turbo figure published; RS rating used). HeyGears lab avg 4.5 s/layer with PAWW10, default set to 6 s.", specUrl: "https://www.heygears.com/hardware/Reflex-RS" },
  { id: "mighty-revo", name: "Phrozen Sonic Mighty Revo", watts: 240, secondsPerLayer: 8, specNote: "Manufacturer spec: System Power Max 240 W (AC 100-240V); avg 450 layers/hr = 8 s/layer.", specUrl: "https://phrozen3d.com/en/products/sonic-mighty-revo" },
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
};

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
  costs: { resin: number; electricity: number; plateTime: number; packaging: number };
  rawCost: number;
  flatMarkupPct: number;
  flatPrice: number;
  markups: CostMarkups;
  math: Record<string, string>;
};

export function suggestPackagingTier(maxSideMm: number, s: Pick<StlQuoteSettings, "packagingMaxMm">): PackagingTier {
  if (maxSideMm <= s.packagingMaxMm.small) return "small";
  if (maxSideMm <= s.packagingMaxMm.medium) return "medium";
  return "large";
}

/**
 * Parts are printed together on one plate: resin adds up, print time follows
 * the tallest part. quantity multiplies resin (copies on the same plate).
 */
export function computeStlQuote(parts: QuotePart[], s: StlQuoteSettings, opts: QuoteOptions = {}): QuoteResult {
  if (parts.length === 0) throw new Error("Add at least one model");
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
  const packaging = s.packagingUsd[packagingTier];

  const costs = { resin: r2(resin), electricity: r2(electricity), plateTime: r2(plateTime), packaging: r2(packaging) };
  const rawCost = r2(resin + electricity + plateTime + packaging);
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
    rawCost,
    flatMarkupPct: s.flatMarkupPct,
    flatPrice,
    markups,
    math: {
      resin: `(${r2(modelMl)} ml model + ${r2(supportMl)} ml support est. ${s.supportAllowancePct}%) x $${perMl.toFixed(4)}/ml x waste ${s.wasteFactor}${opts.hollow ? ` (hollow, ${s.hollowWallMm} mm wall est.)` : ""}`,
      printTime: `${r2(heightMm)} mm / ${s.layerHeightMm} mm = ${layers} layers x ${spl} s = ${r2(printHours)} h (estimate)`,
      electricity: `${printer.watts ?? 0} W x ${r2(printHours)} h = ${Math.round(kwh * 1000) / 1000} kWh x $${s.electricityUsdPerKwh}/kWh`,
      plateTime: `${r2(printHours)} h x $${s.plateTimeUsdPerHour}/h`,
      packaging: `${packagingTier} (largest side ${r2(maxSideMm)} mm${opts.packagingTier ? ", manual" : ", auto"})`,
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
