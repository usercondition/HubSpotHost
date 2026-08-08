/**
 * Pure helpers for Blueprint logs folder auto-attach (no browser APIs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleSliceLogBundle,
  describeSliceLogImportFailure,
  isBlueprintSliceLogName,
  looksLikeBlueprintSliceLogText,
  scanSliceLogsFromFileList,
} from "../client/src/lib/blueprint-slice-log";

test("isBlueprintSliceLogName accepts Slice.log variants", () => {
  assert.equal(isBlueprintSliceLogName("Slice.log"), true);
  assert.equal(isBlueprintSliceLogName("slice-20260808.log"), true);
  assert.equal(isBlueprintSliceLogName("folder/Slice.log"), true);
  assert.equal(isBlueprintSliceLogName("default.log"), false);
  assert.equal(isBlueprintSliceLogName("plate.ultx"), false);
});

test("looksLikeBlueprintSliceLogText detects Output / material markers", () => {
  assert.equal(looksLikeBlueprintSliceLogText('[Slice] Output: {"printEstimateTime":1}'), true);
  assert.equal(looksLikeBlueprintSliceLogText("material cost: 12 g"), true);
  assert.equal(looksLikeBlueprintSliceLogText("hello world"), false);
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

test("scanSliceLogsFromFileList keeps Slice.log under depth budget", async () => {
  const makeFile = (relativePath: string, body: string, lastModified: number) => {
    const name = relativePath.replace(/^.*\//, "");
    const file = new File([body], name, { type: "text/plain", lastModified });
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    return file;
  };

  const scan = await scanSliceLogsFromFileList([
    makeFile("logs/proj-a/Slice.log", '[Slice] Output: {"printEstimateTime":10}', 2),
    makeFile("logs/proj-b/notes.txt", "not a slice log", 3),
    makeFile("logs/deep/a/b/c/d/e/f/g/Slice.log", '[Slice] Output: {"printEstimateTime":99}', 4),
    makeFile("logs/proj-c/Slice.log", "missing marker but named", 5),
    makeFile("logs/proj-d/other.log", '[Slice] material cost: 1 g', 6),
  ]);

  assert.equal(scan.totalFiles, 5);
  assert.ok(scan.candidates.some((c) => c.relativePath === "logs/proj-a/Slice.log"));
  assert.ok(scan.candidates.some((c) => c.relativePath === "logs/proj-c/Slice.log"));
  assert.ok(scan.candidates.some((c) => c.relativePath === "logs/proj-d/other.log"));
  assert.ok(!scan.candidates.some((c) => c.relativePath.includes("deep/")));
});

test("describeSliceLogImportFailure explains empty AppData picks", () => {
  assert.match(
    describeSliceLogImportFailure({
      candidates: [],
      totalFiles: 0,
      logNamedFiles: 0,
      sampleNames: [],
    }),
    /Chrome returned no files/,
  );
  assert.match(
    describeSliceLogImportFailure({
      candidates: [],
      totalFiles: 3,
      logNamedFiles: 0,
      sampleNames: ["a.txt", "b.bin"],
    }),
    /No \.log files/,
  );
});
