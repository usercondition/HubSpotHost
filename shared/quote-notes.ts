/**
 * Quote notes interpreter: turns the free-text "Client notes" box into
 * concrete Quote modifier changes ("Applied from notes" chips).
 *
 * Deterministic and browser-safe (no network, no secrets). Rules:
 *  - Never invent values. A number only comes from the note itself; when a
 *    phrase has no amount (e.g. "rush"), the add-on uses the same default the
 *    manual toggle uses, and the chip says so.
 *  - Ambiguous phrases ("28mm scale") become *suggested* chips that the user
 *    must accept; they are not applied on their own.
 *  - Anything left over is returned as `unparsed` and shown as "not applied".
 */
import { DEFAULT_ADDON_AMOUNTS, type TargetSizeMode } from "./stl-quote";

export type NoteChange =
  | { field: "size"; mode: TargetSizeMode; value: number }
  | { field: "quantity"; value: number }
  | { field: "rush"; on: boolean; usd?: number }
  | { field: "baseMagnet"; on: boolean; usdEach?: number }
  | { field: "finishing"; on: boolean; hours?: number }
  | { field: "hollow"; on: boolean }
  | { field: "separatePackages"; on: boolean }
  | { field: "custom"; usd: number; label: string };

export type NoteField = NoteChange["field"];

export type NoteChip = {
  /** Stable across re-typing: field + normalized source text. */
  id: string;
  change: NoteChange;
  /** Human label, e.g. "Target height 6 mm". */
  label: string;
  /** The exact words in the note that produced this chip. */
  source: string;
  /** "sure" chips apply until removed; "suggested" chips apply only once accepted. */
  confidence: "sure" | "suggested";
  /** Extra context (assumptions, defaults used). */
  detail?: string;
  /** A later chip for the same field wins; this one is shown but not applied. */
  overridden?: boolean;
  origin: "parser" | "ai";
};

export type NotesInterpretation = { chips: NoteChip[]; unparsed: string[] };

/** The Quote page modifier state the chips act on. Mirrors client/src/pages/quote.tsx. */
export type QuoteModifierState = {
  sizeMode: TargetSizeMode;
  sizeValue: string;
  quantity: number;
  hollow: boolean;
  separate: boolean;
  addOn: {
    rush: boolean; rushUsd: number;
    base: boolean; baseUsd: number;
    finishing: boolean; finHours: number; finRate: number;
    custom: boolean; customLabel: string; customUsd: number;
  };
};

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, dozen: 12, pair: 2, couple: 2,
};
const NUM = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|a dozen|dozen)`;
const toNum = (s: string): number => {
  const t = s.trim().replace(/^a\s+/, "");
  return WORD_NUM[t] ?? Number(t);
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(r2(n)));
const UNIT = String.raw`(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|in\b|"|”|″)`;
function toMm(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("c")) return n * 10;
  if (u.startsWith("in") || u === '"' || u === "”" || u === "″") return n * 25.4;
  return n;
}
const unitLabel = (unit: string) => (unit.startsWith("c") ? "cm" : unit.startsWith("m") ? "mm" : "in");

const MODE_LABEL: Record<TargetSizeMode, string> = {
  percent: "Scale",
  height: "Target height",
  longest: "Target longest side",
  width: "Target width",
  depth: "Target depth",
};

export function changeLabel(c: NoteChange): string {
  switch (c.field) {
    case "size":
      return c.mode === "percent" ? `Scale ${fmt(c.value)}%` : `${MODE_LABEL[c.mode]} ${fmt(r2(c.value))} mm`;
    case "quantity":
      return `${c.value} ${c.value === 1 ? "copy" : "copies"}`;
    case "rush":
      return c.on ? `Rush${c.usd != null ? ` $${fmt(c.usd)}` : ""}` : "No rush";
    case "baseMagnet":
      return c.on ? `Base / magnet${c.usdEach != null ? ` $${fmt(c.usdEach)} each` : ""}` : "No base / magnet";
    case "finishing":
      return c.on ? `Supports cleanup / finishing${c.hours != null ? ` ${fmt(c.hours)} h` : ""}` : "No finishing";
    case "hollow":
      return c.on ? "Hollow" : "Solid";
    case "separatePackages":
      return c.on ? "Package each copy separately" : "One package";
    case "custom":
      return `${c.label} +$${fmt(c.usd)}`;
  }
}

type Span = [number, number];
type Hit = { change: NoteChange; source: string; span: Span; confidence?: "sure" | "suggested"; detail?: string };

const NEG = String.raw`(?:\bno\b|\bnot\b|\bdon'?t\b|\bdo not\b|\bwithout\b|\bskip\b|\bnever\b)`;

/** Split into clauses on newlines and sentence/list punctuation (keeps 1.5, $1,000). */
export function splitClauses(text: string): string[] {
  return text
    .split(/\r?\n|[;!?]|\.(?!\d)|,(?!\d{3}\b)|\s+-\s+|•/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const FILLER = new Set(
  ("the a an this that these those it its they them their he she him her his i me my we us our you your client customer buyer " +
    "wants want wanted wanting would like likes liked love needs need needed asking asked asks request requested requests " +
    "please pls plz can could should will be is are was were been being make made making get have has had do does " +
    "to of and or for at in on with by as so just also too very really about around roughly approx approximately ish " +
    "model models mini minis miniature figure figures print prints printed piece version one same thing stuff " +
    "if possible ok okay thanks thank hi hey hello").split(/\s+/),
);

function residualWords(clause: string, spans: Span[]): string {
  let out = "";
  let i = 0;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a > i) out += clause.slice(i, a);
    out += " ";
    i = Math.max(i, b);
  }
  out += clause.slice(i);
  return out
    .toLowerCase()
    .split(/[^a-z0-9$%']+/)
    .filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w))
    .join(" ")
    .trim();
}

type Matcher = (c: string, claim: (re: RegExp, fn: (m: RegExpExecArray) => Omit<Hit, "span" | "source"> | null) => void) => void;

const MATCHERS: Matcher[] = [
  // 1. money: "+$10 for decals", "$15 rush", "rush fee $15", "$3 each for magnets"
  (_c, claim) => {
    claim(/(?:\brush(?:\s+(?:fee|charge))?\s*(?:of|is|=|:)?\s*\$\s?(\d+(?:\.\d+)?))|(?:\$\s?(\d+(?:\.\d+)?)\s*(?:extra\s+)?(?:for\s+(?:the\s+)?)?rush(?:\s+(?:fee|charge))?\b)/g, (m) => {
      const usd = Number(m[1] ?? m[2]);
      return { change: { field: "rush", on: true, usd } };
    });
    claim(/\$\s?(\d+(?:\.\d+)?)\s*(?:each|per\s+(?:copy|piece|mini|model|base|magnet))?\s*(?:for\s+(?:the\s+|a\s+)?)?(?:base|bases|magnets?)\b(?:\s+each)?/g, (m) => ({
      change: { field: "baseMagnet", on: true, usdEach: Number(m[1]) },
      detail: "Charged per copy, as in the Base / magnet add-on.",
    }));
    claim(/(?:\+|\badd\b|\bplus\b|\bextra\b|\bcharge\b)?\s*\$\s?(\d+(?:\.\d+)?)\s*(?:extra\s+|fee\s+|surcharge\s+)?(?:for|to cover)\s+([a-z0-9][a-z0-9 '&/-]{0,58}[a-z0-9])/g, (m) => {
      const label = m[2]!.replace(/\s+/g, " ").trim();
      return { change: { field: "custom", usd: Number(m[1]), label: label.charAt(0).toUpperCase() + label.slice(1) } };
    });
    claim(/(?:\+|\badd\b|\bplus\b)\s*\$\s?(\d+(?:\.\d+)?)\s*(fee|surcharge|extra)?/g, (m) => ({
      change: { field: "custom", usd: Number(m[1]), label: "Extra (from notes)" },
    }));
  },
  // 2. mini scale: "28mm scale", "32 mm heroic scale" -> suggested height, never auto-applied
  (_c, claim) => {
    claim(new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s*${UNIT}\s*(?:heroic\s+|true\s+|tabletop\s+)?scale\b`, "g"), (m) => ({
      change: { field: "size", mode: "height", value: toMm(Number(m[1]), m[2]!) },
      confidence: "suggested",
      detail: `"${m[0].trim()}" is a miniature scale, not an exact size. This assumes the model is one human-sized figure about ${fmt(r2(toMm(Number(m[1]), m[2]!)))} mm tall. Accept only if that is right.`,
    }));
  },
  // 3. relative scale: "150%", "20% bigger", "twice as big", "half size", "1.5x bigger"
  (_c, claim) => {
    claim(/\b(\d+(?:\.\d+)?)\s*%\s*(bigger|larger|taller|smaller|shorter|off|discount|cheaper|deposit|down|upfront)?/g, (m) => {
      const n = Number(m[1]);
      const w = m[2];
      if (w && /off|discount|cheaper|deposit|down|upfront/.test(w)) return null;
      const value = w && /bigger|larger|taller/.test(w) ? 100 + n : w ? 100 - n : n;
      if (value <= 0 || value > 10000) return null;
      return { change: { field: "size", mode: "percent", value } };
    });
    claim(/\b(?:twice\s+(?:as\s+)?(?:big|large|tall|the\s+size)|double\s+(?:the\s+)?size|double\s+(?:as\s+)?(?:big|tall))\b/g, () => ({ change: { field: "size", mode: "percent", value: 200 } }));
    claim(/\b(?:three\s+times\s+(?:as\s+)?(?:big|large|tall|the\s+size)|triple\s+(?:the\s+)?size)\b/g, () => ({ change: { field: "size", mode: "percent", value: 300 } }));
    claim(/\b(?:half\s+(?:the\s+)?size|half\s+as\s+(?:big|large|tall)|half\s+scale)\b/g, () => ({ change: { field: "size", mode: "percent", value: 50 } }));
    claim(/\b(\d+(?:\.\d+)?)\s*(?:x|times)\s*(?:bigger|larger|taller|the\s+size|size|scale|as\s+big|as\s+large|as\s+tall)\b|\bscaled?\s+(?:up\s+|down\s+)?(?:by\s+|to\s+)?(\d+(?:\.\d+)?)\s*x\b/g, (m) => {
      const f = Number(m[1] ?? m[2]);
      return f > 0 && f <= 100 ? { change: { field: "size", mode: "percent", value: r2(f * 100) } } : null;
    });
  },
  // 4. absolute size with an axis: "6mm tall", "3 inches tall", "height 40mm", "40 mm wide"
  (_c, claim) => {
    const AX_AFTER = String.raw`\s*(?:in\s+)?(tall|high|height|wide|width|across|deep|depth|long|longest(?:\s+side)?|on\s+the\s+longest\s+side|max(?:imum)?)\b`;
    claim(new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s*${UNIT}${AX_AFTER}`, "g"), (m) => {
      const mode = axisMode(m[3]!);
      return { change: { field: "size", mode, value: r2(toMm(Number(m[1]), m[2]!)) }, detail: unitLabel(m[2]!) === "mm" ? undefined : `${m[1]} ${unitLabel(m[2]!)} = ${fmt(r2(toMm(Number(m[1]), m[2]!)))} mm` };
    });
    claim(new RegExp(String.raw`\b(height|tall|width|wide|depth|deep|length|longest\s+side)\s*(?:of|is|=|:|at|about|around|to\s+be)?\s*(?:about\s+|around\s+|~\s*)?(\d+(?:\.\d+)?)\s*${UNIT}`, "g"), (m) => {
      const mode = axisMode(m[1]!);
      return { change: { field: "size", mode, value: r2(toMm(Number(m[2]), m[3]!)) }, detail: unitLabel(m[3]!) === "mm" ? undefined : `${m[2]} ${unitLabel(m[3]!)} = ${fmt(r2(toMm(Number(m[2]), m[3]!)))} mm` };
    });
  },
  // 5. bare size "75 mm" -> height (assumed), but not "6mm magnets", "2mm wall", "40x30mm"
  (_c, claim) => {
    claim(new RegExp(String.raw`(?<![\dx×.]\s?)\b(\d+(?:\.\d+)?)\s*${UNIT}(?!\s*(?:magnet|magnets|wall|walls|hole|holes|rod|rods|pin|pins|thick|base|bases|round|square|x|×|by)\b)`, "g"), (m) => {
      const v = r2(toMm(Number(m[1]), m[2]!));
      return {
        change: { field: "size", mode: "height", value: v },
        detail: `No axis given, so height is assumed${unitLabel(m[2]!) === "mm" ? "" : ` (${m[1]} ${unitLabel(m[2]!)} = ${fmt(v)} mm)`}.`,
      };
    });
  },
  // 6. copies
  (c, claim) => {
    if (/\d\s*[x×]\s*\d/.test(c)) return; // "40x30" is dimensions, not copies
    claim(new RegExp(String.raw`\b${NUM}\s*(?:copies|copy|pcs|pieces|units|prints|of\s+(?:them|these|those|this|it|each))\b`, "g"), (m) => qty(toNum(m[1]!)));
    claim(new RegExp(String.raw`\b(?:set|pack|batch|run|lot)\s+of\s+${NUM}\b`, "g"), (m) => qty(toNum(m[1]!)));
    claim(/\b(?:qty|quantity|count)\s*[:=]?\s*(\d+)\b/g, (m) => qty(Number(m[1])));
    claim(/(?:^|[\s(])[x×]\s?(\d+)\b/g, (m) => qty(Number(m[1])));
    claim(/\b(\d+)\s?[x×](?=\s|$|[),.])(?!\s*(?:bigger|larger|taller|the\s+size|size|scale|as))/g, (m) => qty(Number(m[1])));
    claim(/\b(?:a\s+)?(pair|couple|dozen)\s+(?:of\s+)?(?:them|these|copies|prints|minis|models)?\b/g, (m) => qty(WORD_NUM[m[1]!]!));
  },
  // 7. rush / deadline
  (_c, claim) => {
    claim(/\b(?:no\s+rush|not\s+(?:in\s+a\s+)?(?:rush|urgent)|no\s+hurry|no\s+deadline|whenever|take\s+your\s+time)\b/g, () => ({ change: { field: "rush", on: false } }));
    claim(/\b(?:rush(?:\s+(?:order|job|it))?|asap|a\.s\.a\.p|urgent(?:ly)?|expedited?|as\s+soon\s+as\s+possible|in\s+a\s+hurry|(?:quick|fast)\s+turnaround|deadline(?:\s+is)?(?:\s+[a-z0-9]+)?|need(?:s|ed)?\s+(?:it|this|them)\s+by\s+[a-z0-9]+|by\s+(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun|this\s+week(?:end)?|next\s+week|the\s+weekend)|due\s+(?:by|on)\s+[a-z0-9]+)\b/g, (m) => ({
      change: { field: "rush", on: true },
      detail: `"${m[0].trim()}": rush add-on at your default amount. Change the amount in Add-ons if needed.`,
    }));
  },
  // 8. packaging
  (_c, claim) => {
    claim(/\b(?:(?:package[ds]?|packaged|packed|pack|ship(?:ped)?|wrap(?:ped)?|box(?:ed)?|bag(?:ged)?|send)\s+(?:each\s+(?:one\s+)?|them\s+|all\s+)?(?:separately|individually)|separate(?:ly)?\s+(?:packag(?:e|es|ing)|boxes|bags|packs)|individually\s+(?:packaged|packed|wrapped|boxed|bagged)|each\s+in\s+(?:its|their)\s+own\s+(?:box|bag|package)|(?:their|its)\s+own\s+(?:boxes|box|bags|packages))\b/g, () => ({ change: { field: "separatePackages", on: true } }));
    claim(/\b(?:all\s+in\s+one\s+(?:box|package|bag)|(?:same|one)\s+(?:box|package|bag)|packaged\s+together|ship(?:ped)?\s+together)\b/g, () => ({ change: { field: "separatePackages", on: false } }));
  },
  // 9. finishing
  (c, claim) => {
    claim(new RegExp(String.raw`(?:\bunpainted\b|\bunprimed\b|\bunfinished\b|\braw\s+print\b|${NEG}\s+(?:\w+\s+)?(?:paint(?:ed|ing)?|prim(?:e|ed|er|ing)|finish(?:ed|ing)?|clean(?:\s|-)?up)|\b(?:leave|keep|with)\s+(?:the\s+)?supports?(?:\s+on)?\b)`, "g"), () => ({ change: { field: "finishing", on: false } }));
    const hours = c.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/);
    claim(/\b(?:paint(?:ed|ing)?|prim(?:ed|er|ing)|prime\b|base\s?coat(?:ed)?|finish(?:ed|ing)?|sand(?:ed|ing)|supports?\s+(?:clean(?:\s|-)?up|removed|removal|off)|clean(?:ed)?(?:\s|-)?up|remove\s+(?:the\s+)?supports)\b/g, (m) => ({
      change: hours ? { field: "finishing", on: true, hours: Number(hours[1]) } : { field: "finishing", on: true },
      detail: hours ? `${hours[1]} h from the note.` : `"${m[0].trim()}": finishing add-on at your default hours and rate. Adjust in Add-ons.`,
    }));
    if (hours) claim(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/g, () => null);
  },
  // 10. base / magnet
  (_c, claim) => {
    claim(new RegExp(String.raw`(?:${NEG}\s+(?:a\s+|the\s+)?(?:bases?|magnets?)|\bunbased\b|\bbaseless\b)`, "g"), () => ({ change: { field: "baseMagnet", on: false } }));
    claim(/\b(?:bases?|based(?!\s+on)|magnets?|magneti[sz](?:ed|e)|on\s+a\s+base)\b(?!\s+on\b)/g, () => ({ change: { field: "baseMagnet", on: true }, detail: "Base / magnet add-on at your default per-copy amount." }));
  },
  // 11. hollow / solid
  (_c, claim) => {
    claim(new RegExp(String.raw`${NEG}\s+(?:be\s+)?hollow(?:ed)?`, "g"), () => ({ change: { field: "hollow", on: false } }));
    claim(/\bhollow(?:ed)?\b/g, () => ({ change: { field: "hollow", on: true } }));
    claim(/\bsolid\b/g, () => ({ change: { field: "hollow", on: false } }));
  },
];

function axisMode(word: string): TargetSizeMode {
  const w = word.toLowerCase();
  if (/tall|high|height/.test(w)) return "height";
  if (/wide|width|across/.test(w)) return "width";
  if (/deep|depth/.test(w)) return "depth";
  return "longest";
}

function qty(n: number): Omit<Hit, "span" | "source"> | null {
  if (!Number.isFinite(n) || n < 1 || n > 500 || !Number.isInteger(n)) return null;
  return { change: { field: "quantity", value: n } };
}

const normSource = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Parse the notes. Pure and deterministic. */
export function interpretNotes(text: string): NotesInterpretation {
  const chips: NoteChip[] = [];
  const unparsed: string[] = [];
  const seen = new Map<string, number>();
  for (const clause of splitClauses(text.slice(0, 4000))) {
    const lc = clause.toLowerCase().replace(/[’‘]/g, "'");
    const spans: Span[] = [];
    const hits: Hit[] = [];
    const overlaps = (a: number, b: number) => spans.some(([x, y]) => a < y && b > x);
    const claim = (re: RegExp, fn: (m: RegExpExecArray) => Omit<Hit, "span" | "source"> | null) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lc))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        const lead = m[0].length - m[0].trimStart().length;
        const a = m.index + lead, b = m.index + m[0].trimEnd().length;
        if (overlaps(a, b)) continue;
        const h = fn(m);
        spans.push([a, b]);
        if (h) hits.push({ ...h, span: [a, b], source: clause.slice(a, b) });
      }
    };
    for (const matcher of MATCHERS) matcher(lc, claim);
    hits.sort((x, y) => x.span[0] - y.span[0]);
    for (const h of hits) {
      const prev = [...chips].reverse().find((c) => c.change.field === h.change.field);
      if (prev && h.change.field !== "custom" && JSON.stringify(prev.change) === JSON.stringify(h.change) && prev.confidence === (h.confidence ?? "sure")) {
        prev.source = `${prev.source} + ${h.source}`;
        continue;
      }
      const base = `${h.change.field}:${normSource(h.source)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      chips.push({
        id: n ? `${base}#${n}` : base,
        change: h.change,
        label: changeLabel(h.change),
        source: h.source,
        confidence: h.confidence ?? "sure",
        ...(h.detail ? { detail: h.detail } : {}),
        origin: "parser",
      });
    }
    const rest = residualWords(lc, spans);
    if (rest) unparsed.push(hits.length ? rest : clause);
  }
  return { chips: markOverridden(chips), unparsed };
}

/** Custom fees add up; every other field: the last chip wins. */
export function markOverridden(chips: NoteChip[], active?: (c: NoteChip) => boolean): NoteChip[] {
  const isOn = active ?? ((c: NoteChip) => c.confidence === "sure");
  const lastIdx = new Map<NoteField, number>();
  chips.forEach((c, i) => {
    if (c.change.field !== "custom" && isOn(c)) lastIdx.set(c.change.field, i);
  });
  return chips.map((c, i) => {
    const { overridden: _drop, ...rest } = c;
    const last = lastIdx.get(c.change.field);
    return c.change.field !== "custom" && isOn(c) && last !== undefined && last !== i ? { ...rest, overridden: true } : rest;
  });
}

/** Which chips are live: sure + not removed, or suggested + accepted. */
export function activeChips(chips: NoteChip[], removed: ReadonlySet<string>, accepted: ReadonlySet<string>): NoteChip[] {
  const on = (c: NoteChip) => !removed.has(c.id) && (c.confidence === "sure" || accepted.has(c.id));
  return markOverridden(chips, on).filter((c) => on(c) && !c.overridden);
}

/** Overlay the active chips on the manual modifier state. */
export function applyNoteChips(base: QuoteModifierState, chips: NoteChip[]): QuoteModifierState {
  const s: QuoteModifierState = { ...base, addOn: { ...base.addOn } };
  let customUsd = 0;
  const customLabels: string[] = [];
  for (const { change: c } of chips) {
    switch (c.field) {
      case "size": s.sizeMode = c.mode; s.sizeValue = String(c.value); break;
      case "quantity": s.quantity = c.value; break;
      case "hollow": s.hollow = c.on; break;
      case "separatePackages": s.separate = c.on; break;
      case "rush": s.addOn.rush = c.on; if (c.usd != null) s.addOn.rushUsd = c.usd; break;
      case "baseMagnet": s.addOn.base = c.on; if (c.usdEach != null) s.addOn.baseUsd = c.usdEach; break;
      case "finishing": s.addOn.finishing = c.on; if (c.hours != null) s.addOn.finHours = c.hours; break;
      case "custom": customUsd += c.usd; customLabels.push(c.label); break;
    }
  }
  if (customLabels.length) {
    s.addOn.custom = true;
    s.addOn.customUsd = r2(customUsd);
    s.addOn.customLabel = customLabels.join(" + ").slice(0, 60);
  }
  return s;
}

/** Fields a set of active chips controls (used to show "from notes" on the manual controls). */
export function fieldsFromChips(chips: NoteChip[]): Set<NoteField> {
  return new Set(chips.map((c) => c.change.field));
}

export const DEFAULT_NOTE_ADDON_AMOUNTS = DEFAULT_ADDON_AMOUNTS;

// ---- AI fallback validation (server side) -----------------------------------
/**
 * Validate model output against the note text. A change is kept only if its
 * `source` is a verbatim piece of the notes, every number it carries appears
 * in that source, and the field/values are in range. Kept changes are always
 * "suggested" (the user must accept them).
 */
export function validateAiChanges(raw: unknown, notes: string): NoteChip[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as any).changes) ? ((raw as any).changes as unknown[]) : Array.isArray(raw) ? raw : [];
  const text = notes.toLowerCase();
  const out: NoteChip[] = [];
  for (const item of list.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const source = typeof o.source === "string" ? o.source.trim().slice(0, 200) : "";
    if (source.length < 2 || !text.includes(source.toLowerCase())) continue;
    const nums = (source.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    const has = (n: unknown) => typeof n === "number" && Number.isFinite(n) && nums.some((x) => Math.abs(x - n) < 1e-9);
    const on = o.on !== false;
    let change: NoteChange | null = null;
    switch (o.field) {
      case "size": {
        const unit = o.unit === "cm" || o.unit === "in" || o.unit === "percent" ? o.unit : "mm";
        const mode = (["height", "longest", "width", "depth"] as const).find((m) => m === o.mode);
        if (!has(o.value)) break;
        const v = o.value as number;
        if (unit === "percent") change = v > 0 && v <= 10000 ? { field: "size", mode: "percent", value: v } : null;
        else if (mode) change = v > 0 && v <= 5000 ? { field: "size", mode, value: r2(toMm(v, unit === "in" ? "in" : unit)) } : null;
        break;
      }
      case "quantity":
        if (has(o.value) && Number.isInteger(o.value) && (o.value as number) >= 1 && (o.value as number) <= 500) change = { field: "quantity", value: o.value as number };
        break;
      case "rush":
        change = { field: "rush", on, ...(o.usd != null && has(o.usd) ? { usd: o.usd as number } : {}) };
        break;
      case "baseMagnet":
        change = { field: "baseMagnet", on, ...(o.usdEach != null && has(o.usdEach) ? { usdEach: o.usdEach as number } : {}) };
        break;
      case "finishing":
        change = { field: "finishing", on, ...(o.hours != null && has(o.hours) ? { hours: o.hours as number } : {}) };
        break;
      case "hollow":
        change = { field: "hollow", on };
        break;
      case "separatePackages":
        change = { field: "separatePackages", on };
        break;
      case "custom":
        if (has(o.usd) && (o.usd as number) >= 0 && (o.usd as number) <= 10000) {
          const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : "Custom fee";
          change = { field: "custom", usd: o.usd as number, label };
        }
        break;
    }
    if (!change) continue;
    out.push({ id: `ai:${change.field}:${normSource(source)}`, change, label: changeLabel(change), source, confidence: "suggested", detail: "AI suggestion from your note. Check it, then accept.", origin: "ai" });
  }
  return out;
}

/** Summary lines for Copy quote summary. */
export function notesSummaryLines(applied: NoteChip[], unparsed: string[]): string[] {
  const lines: string[] = [];
  if (applied.length) lines.push(`Applied from notes: ${applied.map((c) => `${c.label} ("${c.source}")`).join("; ")}`);
  if (unparsed.length) lines.push(`Not applied (check by hand): ${unparsed.map((u) => `"${u}"`).join("; ")}`);
  return lines;
}
