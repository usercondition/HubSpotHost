import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRINT_FILE_MAX_MB,
  MAX_PRINT_FILE_MAX_MB,
  MIN_PRINT_FILE_MAX_MB,
  getPrintFileMaxMb,
} from "../server/lib/print-file-limits";

test("uses the high default when no CTB limit is configured", () => {
  assert.equal(getPrintFileMaxMb(undefined), DEFAULT_PRINT_FILE_MAX_MB);
});

test("accepts a whole-number CTB limit within the safe range", () => {
  assert.equal(getPrintFileMaxMb("1536"), 1536);
  assert.equal(getPrintFileMaxMb("2048"), 2048);
});

test("falls back to the default for invalid CTB limits", () => {
  assert.equal(getPrintFileMaxMb("512.5"), DEFAULT_PRINT_FILE_MAX_MB);
  assert.equal(getPrintFileMaxMb(String(MIN_PRINT_FILE_MAX_MB - 1)), DEFAULT_PRINT_FILE_MAX_MB);
  assert.equal(getPrintFileMaxMb(String(MAX_PRINT_FILE_MAX_MB + 1)), DEFAULT_PRINT_FILE_MAX_MB);
});

test("default ceiling supports Mega 8K sized plates", () => {
  assert.ok(DEFAULT_PRINT_FILE_MAX_MB >= 2048);
  assert.ok(MAX_PRINT_FILE_MAX_MB >= 4096);
});
