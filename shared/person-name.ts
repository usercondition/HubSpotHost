/**
 * OCR-tolerant person-name matching shared by Labels parse, deal attach, and UI defaults.
 * Handles split OCR ("ANGEL PINS EDA" ≈ "Angel Pineda") and condensed forms.
 */

export function normalizePersonName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function condenseName(value: string): string {
  return normalizePersonName(value).replace(/\s+/g, "");
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(normalizePersonName(a).split(" ").filter((t) => t.length > 1));
  const right = new Set(normalizePersonName(b).split(" ").filter((t) => t.length > 1));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

/** Small Levenshtein for OCR typos (Pineda ↔ PINS EDA). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    curr[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/**
 * Score OCR / label names against HubSpot contacts.
 * Global — not client-specific. Split last names, missing spaces, light typos.
 */
export function fuzzyPersonNameScore(needle: string, haystack: string): number {
  const n = normalizePersonName(needle);
  const h = normalizePersonName(haystack);
  if (!n || !h) return 0;
  if (n === h) return 100;
  if (h.includes(n) || n.includes(h)) return 80;

  const cn = condenseName(n);
  const ch = condenseName(h);
  if (cn === ch) return 95;

  const nTokens = n.split(" ").filter(Boolean);
  const hTokens = h.split(" ").filter(Boolean);
  const firstN = nTokens[0] ?? "";
  const firstH = hTokens[0] ?? "";
  if (firstN && firstN === firstH && firstN.length >= 3) {
    const restN = cn.slice(firstN.length);
    const restH = ch.slice(firstH.length);
    if (restN && restH) {
      const dist = editDistance(restN, restH);
      const maxLen = Math.max(restN.length, restH.length) || 1;
      if (dist <= 2 || dist / maxLen <= 0.4) return 78;
    }
    // First name alone still weak signal when last is garbage OCR.
    if (nTokens.length >= 2 || hTokens.length >= 2) return 35;
  }

  const dist = editDistance(cn, ch);
  const maxLen = Math.max(cn.length, ch.length) || 1;
  if (maxLen >= 6 && dist / maxLen <= 0.28) return 70;

  const overlap = tokenOverlap(n, h);
  if (overlap >= 0.5) return Math.round(overlap * 60);
  return 0;
}

/** True when two display names are the same person under OCR-tolerant rules. */
export function samePersonName(a: string, b: string, minScore = 70): boolean {
  return fuzzyPersonNameScore(a, b) >= minScore;
}
