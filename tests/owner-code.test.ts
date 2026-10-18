import test from "node:test";
import assert from "node:assert/strict";
import { hashAccessCode, normalizeOwnerCode, verifyOwnerCode } from "../server/lib/owner-code";

// Fake code only. Never the real one.
const FAKE = "POI-LOOK7ALIKE0IL1Q";
const exactHash = hashAccessCode(FAKE);
const normHash = hashAccessCode(normalizeOwnerCode(FAKE));

test("normalizer: case, whitespace, zero-width, quotes", () => {
  assert.equal(normalizeOwnerCode("  ab c\u200B\u00A0d\t\n"), "ABCD");
  assert.equal(normalizeOwnerCode("\u201Cxyz\u201D"), "XYZ");
  assert.equal(normalizeOwnerCode("'q'\u2019`"), "Q");
});

test("normalizer: lookalikes collapse O->0, I/L/|->1", () => {
  assert.equal(normalizeOwnerCode("OoIiLl|"), "0011111");
  assert.equal(normalizeOwnerCode("0011"), "0011");
});

test("normalizer: every dash variant -> '-'", () => {
  for (const d of ["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\uFE58", "\uFE63", "\uFF0D"]) {
    assert.equal(normalizeOwnerCode(`A${d}B`), "A-B", `dash U+${d.codePointAt(0)!.toString(16)}`);
  }
});

test("normalizer: NFKC full-width and Cyrillic/Greek homoglyphs", () => {
  assert.equal(normalizeOwnerCode("\uFF30\uFF2F\uFF29"), "P01"); // full-width POI
  assert.equal(normalizeOwnerCode("\u0420\u041E\u0406"), "P01"); // Cyrillic Р О І
  assert.equal(normalizeOwnerCode("\u039F"), "0"); // Greek Omicron
});

test("normalizer: mangled variants of the fake code all match", () => {
  const target = normalizeOwnerCode(FAKE);
  const variants = [
    FAKE.toLowerCase(),
    FAKE.replace(/O/g, "0").replace(/I/g, "1"),
    FAKE.replace(/0/g, "O").replace(/1/g, "l"),
    FAKE.replace("-", "\u2014") + " ",
    ` ${FAKE.slice(0, 4)} ${FAKE.slice(4)}\u200B`,
  ];
  for (const v of variants) assert.equal(normalizeOwnerCode(v), target);
  assert.notEqual(normalizeOwnerCode("POI-LOOK7ALIKE0IL1R"), target);
});

test("verify: exact hash only (norm env unset) behaves like before", () => {
  const env = { PAID_ORDER_INTAKE_ACCESS_CODE_HASH: exactHash } as NodeJS.ProcessEnv;
  assert.equal(verifyOwnerCode(FAKE, env), "authorized");
  assert.equal(verifyOwnerCode(`  Bearer ${FAKE} `, env), "authorized");
  assert.equal(verifyOwnerCode(`"${FAKE}"`, env), "authorized");
  assert.equal(verifyOwnerCode(FAKE.toLowerCase(), env), "mismatch");
  assert.equal(verifyOwnerCode(FAKE.replace("O", "0"), env), "mismatch");
  assert.equal(verifyOwnerCode("", env), "missing");
  assert.equal(verifyOwnerCode(FAKE, {} as NodeJS.ProcessEnv), "not-configured");
  // Norm hash alone is not enough: exact hash still gates "configured".
  assert.equal(verifyOwnerCode(FAKE, { PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH: normHash } as NodeJS.ProcessEnv), "not-configured");
});

test("verify: dual hash accepts exact and mangled, rejects wrong", () => {
  const env = {
    PAID_ORDER_INTAKE_ACCESS_CODE_HASH: exactHash,
    PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH: normHash.toUpperCase(),
  } as NodeJS.ProcessEnv;
  assert.equal(verifyOwnerCode(FAKE, env), "authorized");
  assert.equal(verifyOwnerCode("p0l\u2013l00k7al1ke01l1q ", env), "authorized");
  assert.equal(verifyOwnerCode("POI-LOOK7ALIKE0IL1R", env), "mismatch");
  assert.equal(verifyOwnerCode("nope", env), "mismatch");
  assert.equal(verifyOwnerCode("\u200B", env), "mismatch");
});

test("ownerCodeForHeader: exact ASCII code passes through; Live Text chars become header-safe", async () => {
  const { ownerCodeForHeader } = await import("../shared/owner-code");
  assert.equal(ownerCodeForHeader(`  ${FAKE} `), FAKE);
  assert.equal(ownerCodeForHeader("poi-look7alike0il1q"), "poi-look7alike0il1q");
  const mangled = ownerCodeForHeader("P0I\u2014L\u041EOK7ALIKE0IL1Q\u200B");
  assert.ok(!/[^\u0000-\u00FF]/.test(mangled));
  const env = { PAID_ORDER_INTAKE_ACCESS_CODE_HASH: exactHash, PAID_ORDER_INTAKE_ACCESS_CODE_NORM_HASH: normHash } as NodeJS.ProcessEnv;
  assert.equal(verifyOwnerCode(mangled, env), "authorized");
});
