/**
 * Shared STL naming + part status labels used by order parts and plate bits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  labelFromStlFileName,
  normalizeStlFileName,
  pathBaseName,
} from "../shared/stl-names";
import { partStatusLabel } from "../shared/schema";

test("pathBaseName strips folders and zip-style separators", () => {
  assert.equal(pathBaseName("Acastus/Head/Helmet.stl"), "Helmet.stl");
  assert.equal(pathBaseName("C:\\\\kits\\\\part.stl"), "part.stl");
  assert.equal(pathBaseName("solo.stl"), "solo.stl");
});

test("normalizeStlFileName keeps only .stl basenames", () => {
  assert.equal(normalizeStlFileName("kit/Body.STL"), "Body.STL");
  assert.equal(normalizeStlFileName("notes.txt"), null);
  assert.equal(normalizeStlFileName(""), null);
});

test("labelFromStlFileName drops extension", () => {
  assert.equal(labelFromStlFileName("Helmet.stl"), "Helmet");
  assert.equal(labelFromStlFileName("Helmet"), "Helmet");
});

test("partStatusLabel covers order-part and plate-bit statuses", () => {
  assert.equal(partStatusLabel("needed"), "Needed");
  assert.equal(partStatusLabel("on_plate"), "On plate");
  assert.equal(partStatusLabel("good"), "Good");
  assert.equal(partStatusLabel("reprint"), "Reprint");
  assert.equal(partStatusLabel("mystery"), "mystery");
});
