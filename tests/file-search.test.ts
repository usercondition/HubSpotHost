import test from "node:test";
import assert from "node:assert/strict";
import { editDistance, fuzzyVariants, normalizeText, searchTokens, splitJoined } from "../shared/file-search";

test("normalizeText folds case, separators, camelCase and digits", () => {
  assert.equal(normalizeText("S.P.R.U.E.+Ground+Plunderer_v2"), "s p r u e ground plunderer v 2");
  assert.equal(normalizeText("HeavyIntercessors"), "heavy intercessors");
  assert.equal(normalizeText("grimdark_ground_plunderer-doors"), "grimdark ground plunderer doors");
  assert.equal(normalizeText("Lemartes30.stl"), "lemartes 30 stl");
  assert.equal(normalizeText("STLHammer"), "stl hammer");
});

test("searchTokens: any separators, dedupe, drop 1-letter noise", () => {
  assert.deepEqual(searchTokens("ground_plunderer"), ["ground", "plunderer"]);
  assert.deepEqual(searchTokens("Ground-Plunderer"), ["ground", "plunderer"]);
  assert.deepEqual(searchTokens("GroundPlunderer"), ["ground", "plunderer"]);
  assert.deepEqual(searchTokens("a leman  leman russ"), ["leman", "russ"]);
  assert.deepEqual(searchTokens("Mk2B hull"), ["mk2b", "hull"]);
});

test("editDistance handles typos and swaps with an early exit", () => {
  assert.equal(editDistance("plunderer", "pluderer", 2), 1);
  assert.equal(editDistance("plundrer", "plunderer", 2), 1);
  assert.equal(editDistance("lemrates", "lemartes", 2), 1);
  assert.equal(editDistance("reaver", "titans", 2), 3);
});

test("fuzzyVariants and splitJoined use the index vocabulary", () => {
  const vocab = new Map([["plunderer", 50], ["pluderer", 1], ["ground", 80], ["lemartes", 9], ["leman", 30]]);
  assert.deepEqual(fuzzyVariants("plundrer", vocab), ["plunderer", "pluderer"].filter((w) => editDistance("plundrer", w, 1) <= 1));
  assert.ok(fuzzyVariants("plunderor", vocab).includes("plunderer"));
  assert.deepEqual(fuzzyVariants("russ", vocab), []); // short words are never fuzzy
  assert.deepEqual(splitJoined("groundplunderer", vocab), ["ground", "plunderer"]);
  assert.equal(splitJoined("xyzzyplugh", vocab), null);
});
