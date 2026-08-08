/**
 * Pure helpers for Blueprint logs folder auto-attach (no browser APIs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleSliceLogBundle,
  isBlueprintSliceLogName,
} from "../client/src/lib/blueprint-slice-log";

test("isBlueprintSliceLogName accepts Slice.log variants", () => {
  assert.equal(isBlueprintSliceLogName("Slice.log"), true);
  assert.equal(isBlueprintSliceLogName("slice-20260808.log"), true);
  assert.equal(isBlueprintSliceLogName("folder/Slice.log"), true);
  assert.equal(isBlueprintSliceLogName("default.log"), false);
  assert.equal(isBlueprintSliceLogName("plate.ultx"), false);
});

test("assembleSliceLogBundle prefers a log that mentions the plate UUID", () => {
  const bundle = assembleSliceLogBundle(
    [
      {
        relativePath: "old/Slice.log",
        lastModified: 1,
        text: '[Slice] Output: {"sliceFileName":"Slice-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ultx","printEstimateTime":100}',
      },
      {
        relativePath: "new/Slice.log",
        lastModified: 2,
        text: '[Slice] Output: {"sliceFileName":"Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx","printEstimateTime":12457}',
      },
    ],
    "P_20260806_232232-Plate01.rs.ultx",
  );
  // No UUID in the export name — falls back to newest bundle merge.
  assert.ok(bundle);
  assert.match(bundle!.text, /ed4909aa-1ea8-4a0d-a3f5-3215bed8c027/);

  const byUuid = assembleSliceLogBundle(
    [
      {
        relativePath: "old/Slice.log",
        lastModified: 10,
        text: '[Slice] Output: {"sliceFileName":"Slice-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.ultx"}',
      },
      {
        relativePath: "match/Slice.log",
        lastModified: 1,
        text: '[Slice] Output: {"sliceFileName":"Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx","printEstimateTime":12457}',
      },
    ],
    "Slice-ed4909aa-1ea8-4a0d-a3f5-3215bed8c027.ultx",
  );
  assert.equal(byUuid?.relativePath, "match/Slice.log");
  assert.match(byUuid!.text, /12457/);
});
