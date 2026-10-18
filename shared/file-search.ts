/**
 * Forgiving file search helpers shared by the Files page server and tests.
 *
 * - normalizeText: case, underscores, dashes, dots, "+", camelCase and letter/digit boundaries all become single
 *   spaces ("S.P.R.U.E.+Ground+Plunderer_v2" -> "s p r u e ground plunderer v 2", "HeavyIntercessors" ->
 *   "heavy intercessors").
 * - Query tokens are AND-ed in any order and matched as substrings (so prefixes match too).
 * - Typos are handled on the server with a vocabulary of index words: editDistance() <= fuzzyBudget(token).
 * - Joined words ("groundplunderer") are split against the same vocabulary.
 */

export function normalizeText(s: string, opts: { splitDigits?: boolean } = {}): string {
  let t = (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  if (opts.splitDigits !== false) t = t.replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2");
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Lowercase AND-tokens; separators and camelCase ignored ("Dark-Angels" == "dark angels" == "DarkAngels"). */
export function searchTokens(q: string): string[] {
  const out: string[] = [];
  // Query words keep letter+digit runs whole ("mk2b", "lemartes30"); the index also stores a squashed name/path, so
  // they still hit "Mk 2B" and "Lemartes30.stl".
  for (const t of normalizeText(q, { splitDigits: false }).split(" ")) {
    if (!t) continue;
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
}

/** Allowed typos for a query word: none under 5 letters, 1 up to 8, 2 from 9. Digits never fuzzy. */
export function fuzzyBudget(token: string): number {
  if (/\d/.test(token) || token.length < 5) return 0;
  return token.length <= 8 ? 1 : 2;
}

/** Optimal-string-alignment distance (insert/delete/substitute/adjacent swap), early exit above max. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Close vocabulary words for a typo'd token, most common first. Words that already contain the token are skipped. */
export function fuzzyVariants(token: string, vocab: Map<string, number>, limit = 8): string[] {
  const k = fuzzyBudget(token);
  if (!k) return [];
  const hits: Array<[string, number, number]> = [];
  for (const [w, n] of vocab) {
    if (Math.abs(w.length - token.length) > k || w.includes(token) || w.length < 4) continue;
    const d = editDistance(token, w, k);
    if (d <= k) hits.push([w, d, n]);
  }
  hits.sort((x, y) => x[1] - y[1] || y[2] - x[2]);
  return hits.slice(0, limit).map((h) => h[0]);
}

/** "groundplunderer" -> ["ground", "plunderer"] when both halves are index words (best-supported split). */
export function splitJoined(token: string, vocab: Map<string, number>): string[] | null {
  if (token.length < 6 || /\d/.test(token)) return null;
  let best: [string, string, number] | null = null;
  for (let i = 3; i <= token.length - 3; i++) {
    const a = token.slice(0, i);
    const b = token.slice(i);
    const na = vocab.get(a) ?? 0;
    const nb = vocab.get(b) ?? 0;
    if (na && nb && (!best || Math.min(na, nb) > best[2])) best = [a, b, Math.min(na, nb)];
  }
  return best ? [best[0], best[1]] : null;
}
