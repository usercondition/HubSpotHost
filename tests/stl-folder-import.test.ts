import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  collectKitFilesFromFileList,
  collectStlFilesFromFileList,
  formatKitImportNote,
  inferKitNameFromImports,
  isUnsupportedArchiveName,
  isZipFileName,
} from "../client/src/lib/stl-folder-import";

function zipFile(name: string, entries: Record<string, Uint8Array>): File {
  const bytes = zipSync(entries);
  return new File([bytes], name, { type: "application/zip" });
}

test("collectStlFilesFromFileList keeps unique basenames from nested paths", () => {
  const files = [
    new File([""], "18 Head.stl", { type: "model/stl" }),
    new File([""], "19 Face Plate.stl", { type: "model/stl" }),
    new File([""], "notes.txt", { type: "text/plain" }),
  ];
  Object.defineProperty(files[0], "webkitRelativePath", { value: "Acastus Kit/Head/18 Head.stl" });
  Object.defineProperty(files[1], "webkitRelativePath", { value: "Acastus Kit/Head/19 Face Plate.stl" });
  const imports = collectStlFilesFromFileList(files);
  assert.equal(imports.length, 2);
  assert.equal(inferKitNameFromImports(imports), "Acastus Kit");
});

test("zip and nested zip STLs are extracted for kit import", async () => {
  const nested = zipSync({
    "parts/22 Right Upper Rear Plate.stl": new Uint8Array([9, 9, 9]),
  });
  const outer = zipFile("Acastus Delivery.zip", {
    "loose/18 Head.stl": new Uint8Array([1, 2, 3]),
    "archives/parts.zip": nested,
    "readme.txt": new TextEncoder().encode("ignore me"),
  });

  const summary = await collectKitFilesFromFileList([outer]);
  assert.equal(summary.imports.length, 2);
  assert.equal(summary.zipStlCount, 2);
  assert.equal(summary.archivesOpened.length, 2);
  assert.ok(summary.imports.some((item) => item.fileName === "18 Head.stl"));
  assert.ok(summary.imports.some((item) => item.fileName === "22 Right Upper Rear Plate.stl"));
  assert.match(inferKitNameFromImports(summary.imports), /Acastus Delivery/i);
});

test("folder STLs win over zip duplicates and unsupported archives are reported", async () => {
  const archive = zipFile("extras.zip", {
    "18 Head.stl": new Uint8Array([4, 4, 4]),
  });
  const loose = new File([new Uint8Array([1, 1, 1])], "18 Head.stl", { type: "model/stl" });
  Object.defineProperty(loose, "webkitRelativePath", { value: "Kit/18 Head.stl" });
  const rar = new File([new Uint8Array([0])], "old.rar", { type: "application/x-rar-compressed" });
  Object.defineProperty(rar, "webkitRelativePath", { value: "Kit/old.rar" });

  const summary = await collectKitFilesFromFileList([loose, archive, rar]);
  assert.equal(summary.imports.length, 1);
  assert.equal(summary.imports[0]!.source, "folder");
  assert.equal(summary.duplicatesSkipped, 1);
  assert.deepEqual(summary.unsupportedArchives, ["Kit/old.rar"]);
  assert.match(formatKitImportNote(summary, "Kit"), /Unsupported/);
});

test("archive helpers recognize zip vs unsupported types", () => {
  assert.equal(isZipFileName("Parts.zip"), true);
  assert.equal(isUnsupportedArchiveName("Parts.rar"), true);
  assert.equal(isUnsupportedArchiveName("Parts.7z"), true);
  assert.equal(isUnsupportedArchiveName("Parts.zip"), false);
});
