/**
 * Owner-code normalization shared by server (hash check) and client (header-safe send).
 * See server/lib/owner-code.ts for how it is used.
 */
// Whitespace plus invisible characters phones / Live Text can slip in.
const INVISIBLE = /[\s\u00AD\u180E\u200B-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u3000\uFEFF]/g;
// Every dash / minus / hyphen variant -> "-".
const DASHES = /[\u2010-\u2015\u2043\u2212\u2796\u2E3A\u2E3B\uFE58\uFE63\uFF0D\u02D7\u1806\u00AF]/g;
// Quotes and backticks get stripped (copy/paste and smart punctuation).
const QUOTES = /["'`\u00B4\u2018-\u201F\u2032-\u2037\u00AB\u00BB\u2039\u203A\u300C-\u300F\uFF02\uFF07]/g;
// Cyrillic / Greek capitals that look like Latin ones (after uppercasing).
const HOMOGLYPHS: Record<string, string> = {
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M", "\u041D": "H",
  "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0423": "Y",
  "\u0406": "I", "\u0408": "J", "\u0405": "S",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I",
  "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T",
  "\u03A5": "Y", "\u03A7": "X",
};
// Lookalikes collapse to one canonical form.
const LOOKALIKES: Record<string, string> = { O: "0", I: "1", L: "1", "|": "1" };

/** Canonical form of an owner code. Apply to both sides before hashing. */
export function normalizeOwnerCode(input: string): string {
  let s = String(input ?? "").normalize("NFKC");
  s = s.replace(INVISIBLE, "").replace(QUOTES, "").replace(DASHES, "-");
  s = s.toUpperCase();
  let out = "";
  for (const ch of s) {
    const latin = HOMOGLYPHS[ch] ?? ch;
    out += LOOKALIKES[latin] ?? latin;
  }
  return out;
}

/**
 * What the browser actually sends. The code as typed (trimmed) when it is header-safe, so the
 * exact-hash path is untouched for normal codes. fetch() throws on header values outside
 * Latin-1 (an em dash or Cyrillic letter from iPhone Live Text), so only then fall back to the
 * normalized form, which the server's NORM_HASH path accepts.
 */
export function ownerCodeForHeader(input: string): string {
  const trimmed = String(input ?? "").trim();
  if (!/[^\u0000-\u00FF]|[\u0000-\u001F\u007F]/.test(trimmed)) return trimmed;
  return normalizeOwnerCode(trimmed).replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, "");
}
