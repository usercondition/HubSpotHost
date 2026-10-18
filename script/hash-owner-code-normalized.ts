/**
 * Prints sha256(normalizeOwnerCode(code)) for PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH.
 * Reads the code from stdin (never argv, never echoed). Only the hash is written to stdout.
 *
 *   npx tsx script/hash-owner-code-normalized.ts < /path/to/code-file > /path/to/normhash (chmod 600)
 *   # or interactively: npx tsx script/hash-owner-code-normalized.ts   (type code, Enter, Ctrl-D)
 */
import { hashAccessCode, normalizeOwnerCode } from "../server/lib/owner-code";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const code = raw.replace(/\r?\n$/, "");
  const norm = normalizeOwnerCode(code);
  if (!norm) {
    console.error("No code on stdin.");
    process.exit(1);
  }
  process.stdout.write(hashAccessCode(norm) + "\n");
});
