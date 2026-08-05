import test from "node:test";
import assert from "node:assert/strict";
import {
  attachBitsToPlate,
  completePlateQc,
  createAcastusDryRunKit,
  createReprintCatchAllPlate,
  kitProgress,
  setPlateBitResult,
} from "../client/src/lib/kit-dry-run";

test("attach plate leaves bits printing until QC", () => {
  const kit = createAcastusDryRunKit();
  const head = kit.bits.filter((bit) => bit.group === "Head").map((bit) => bit.id);
  assert.ok(head.length >= 2);

  const afterAttach = attachBitsToPlate(kit, {
    plateName: "Plate 1",
    ctbFileName: "Acastus_P1.ctb",
    bitIds: head,
  });
  const progress = kitProgress(afterAttach);
  assert.equal(progress.printing, head.length);
  assert.equal(progress.done, 0);
  assert.equal(afterAttach.plates[0]?.status, "pending_qc");
});

test("QC good and reprint update kit queue", () => {
  let kit = createAcastusDryRunKit();
  const ids = kit.bits.filter((bit) => bit.group === "Head").map((bit) => bit.id);
  assert.equal(ids.length, 2);

  kit = attachBitsToPlate(kit, { plateName: "Plate 1", ctbFileName: "P1.ctb", bitIds: ids });
  const plateId = kit.plates[0]!.id;

  kit = setPlateBitResult(kit, plateId, ids[0]!, "good");
  const blocked = completePlateQc(kit, plateId);
  assert.equal(blocked.ok, false);

  kit = setPlateBitResult(kit, plateId, ids[1]!, "reprint");
  const finished = completePlateQc(kit, plateId);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;

  assert.equal(finished.kit.bits.find((bit) => bit.id === ids[0]!)?.status, "done");
  assert.equal(finished.kit.bits.find((bit) => bit.id === ids[1]!)?.status, "needs_reprint");
  assert.equal(finished.kit.plates[0]?.status, "inspected");
  assert.equal(kitProgress(finished.kit).reprint, 1);
  assert.equal(kitProgress(finished.kit).done, 1);
});

test("catch-all reprint plate gathers every needs_reprint bit", () => {
  let kit = createAcastusDryRunKit();
  const ids = kit.bits.filter((bit) => bit.group === "Head").map((bit) => bit.id);
  kit = attachBitsToPlate(kit, { plateName: "Plate 1", ctbFileName: "P1.ctb", bitIds: ids });
  const plateId = kit.plates[0]!.id;
  kit = setPlateBitResult(kit, plateId, ids[0]!, "reprint");
  kit = setPlateBitResult(kit, plateId, ids[1]!, "reprint");
  const finished = completePlateQc(kit, plateId);
  assert.equal(finished.ok, true);
  if (!finished.ok) return;

  const catchAll = createReprintCatchAllPlate(finished.kit);
  assert.equal(catchAll.ok, true);
  if (!catchAll.ok) return;
  assert.equal(catchAll.count, 2);
  assert.equal(kitProgress(catchAll.kit).printing, 2);
  assert.equal(kitProgress(catchAll.kit).reprint, 0);
  assert.equal(catchAll.kit.plates[0]?.status, "pending_qc");
  assert.match(catchAll.kit.plates[0]?.name ?? "", /Reprint/i);
});
