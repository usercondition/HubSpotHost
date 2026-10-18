/**
 * Voice start for the Printers page: "<printer> print started".
 *
 * Shop transcripts are garbled ("9012 12K old print started" = Mighty 12K Old, "9012K new" =
 * Mighty 12K New, "90X2 print started" = Mighty 8K New X2). We normalize common mishearings
 * into a few features (family, resolution, old/new, X number), read the same features from each
 * printer's real name + nicknames, and keep only printers that do not contradict anything heard.
 * Exactly one survivor = a match. Zero or several = ask Miguel (never start on a guess).
 */

export type VoiceFeatures = {
  family: "mighty" | "mega" | "heygears" | null;
  res: "8k" | "12k" | null;
  variant: "old" | "new" | null;
  xnum: "x1" | "x2" | "x3" | null;
};

export type VoicePrinter = { key: string; name: string; aliases?: readonly string[] };

export type VoiceCandidate = { key: string; name: string; score: number };

export type VoiceMatch = {
  status: "match" | "ambiguous" | "none";
  /** Cleaned text we matched on (shown as "Heard: ..."). */
  heard: string;
  features: VoiceFeatures;
  printerKey: string | null;
  /** Best first. For "none" this is every printer so Miguel can pick. */
  candidates: VoiceCandidate[];
};

const WORD_FIXES: Array<[RegExp, string]> = [
  // Trigger words carry no printer information.
  [/\b(print(ing)?|started|starting|start|printer|go|going|now|please|the|on|is|it|just|okay so)\b/g, " "],
  [/\b(phrozen|frozen|sonic|elegoo)\b/g, " "],
  // "Mighty" is heard as 90 / ninety / nighty / mity ...
  [/\b90(?=[0-9xk]|\b)/g, " mighty "],
  [/\b9(?=x[0-9])/g, " mighty "],
  [/\b(ninety|nighty|nightie|nitey|mity|mitey|mighdy|mightee|mightie|might|mite|my tea|mighties)\b/g, " mighty "],
  [/\b(omega|mega|meg a|megan)\b/g, " mega "],
  [/\b(hey ?gears?|heygear|hagears|reflex|ultra ?craft)\b/g, " heygears "],
  // Numbers and letters.
  [/\btwelve\b/g, " 12 "],
  [/\b(eight|ate)\b/g, " 8 "],
  [/\b(one|won)\b/g, " 1 "],
  [/\b(two|too|to)\b/g, " 2 "],
  [/\b(three|tree|free)\b/g, " 3 "],
  [/\b(ex|eks|acts)\b/g, " x "],
  [/\b(kay|okay|ok|cay)\b/g, " k "],
  [/\b(hold|ole|olde|older|olds|gold)\b/g, " old "],
  [/\b(knew|nu|newer|news|gnu)\b/g, " new "],
];

/** Lowercase, fix mishearings, split glued tokens ("9012k" -> "mighty 12k", "newx2" -> "new x2"). */
export function normalizeVoiceText(text: string): string {
  let s = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  // Split glued words first so the word fixes can see them.
  s = s.replace(/(new|old)(?=x\d)/g, "$1 ");
  s = s.replace(/(\d)k(?=[a-z])/g, "$1k ");
  s = s.replace(/(\d)([a-jl-z])/g, "$1 $2");
  s = s.replace(/([a-wyz])(\d)/g, "$1 $2");
  for (const [rx, to] of WORD_FIXES) s = s.replace(rx, to);
  s = s.replace(/\b(\d{1,2})\s+k\b/g, "$1k");
  s = s.replace(/\bx\s+([123])\b/g, "x$1");
  return s.replace(/\s+/g, " ").trim();
}

/** Features in already-normalized text. Contradictory values are dropped (unknown). */
export function voiceFeatures(normalized: string): VoiceFeatures {
  const tokens = normalized.split(" ").filter(Boolean);
  const pick = <T extends string>(values: T[]): T | null => {
    const set = new Set(values);
    return set.size === 1 ? values[0]! : null;
  };
  const family = pick(tokens.filter((t): t is "mighty" | "mega" | "heygears" => t === "mighty" || t === "mega" || t === "heygears"));
  const res = pick(
    tokens
      .map((t) => (t === "12k" || t === "12" ? "12k" : t === "8k" || t === "8" ? "8k" : null))
      .filter((t): t is "8k" | "12k" => t != null),
  );
  const variant = pick(tokens.filter((t): t is "old" | "new" => t === "old" || t === "new"));
  const xnum = pick(tokens.filter((t): t is "x1" | "x2" | "x3" => t === "x1" || t === "x2" || t === "x3"));
  return { family, res, variant, xnum };
}

/** Features of a printer from its real name and nicknames. */
export function printerVoiceFeatures(printer: VoicePrinter): VoiceFeatures {
  const own = voiceFeatures(normalizeVoiceText(printer.name));
  const merged: VoiceFeatures = { ...own };
  for (const alias of printer.aliases ?? []) {
    const f = voiceFeatures(normalizeVoiceText(alias));
    for (const k of Object.keys(merged) as Array<keyof VoiceFeatures>) {
      if (merged[k] == null && f[k] != null) (merged as Record<string, string | null>)[k] = f[k];
    }
  }
  return merged;
}

const WEIGHTS: Record<keyof VoiceFeatures, number> = { family: 1, res: 2, variant: 2, xnum: 3 };

function scorePrinter(heard: VoiceFeatures, printer: VoiceFeatures): number | null {
  let score = 0;
  for (const k of Object.keys(WEIGHTS) as Array<keyof VoiceFeatures>) {
    const h = heard[k];
    if (h == null) continue;
    const p = printer[k];
    if (p == null || p !== h) return null; // contradiction (or printer has no such trait)
    score += WEIGHTS[k];
  }
  return score;
}

export function matchVoiceToPrinter(text: string, roster: readonly VoicePrinter[]): VoiceMatch {
  const heard = normalizeVoiceText(text);
  const features = voiceFeatures(heard);
  const scored = roster
    .map((p) => ({ key: p.key, name: p.name, score: scorePrinter(features, printerVoiceFeatures(p)) }))
    .filter((c): c is VoiceCandidate => c.score != null && c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { status: "match", heard, features, printerKey: scored[0]!.key, candidates: scored };
  if (scored.length === 0) {
    return { status: "none", heard, features, printerKey: null, candidates: roster.map((p) => ({ key: p.key, name: p.name, score: 0 })) };
  }
  return { status: "ambiguous", heard, features, printerKey: null, candidates: scored };
}
