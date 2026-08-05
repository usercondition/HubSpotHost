import test from "node:test";
import assert from "node:assert/strict";

// Mirror client helpers with a tiny Node-side copy of parse/group logic for CI
// without a browser harness. Keep in sync with client/src/lib/kit-dry-run.ts.

function groupForFileName(fileName: string): string {
  const match = /^(\d+)\b/.exec(fileName.trim());
  const n = match ? Number(match[1]) : null;
  if (n != null && Number.isFinite(n)) {
    if (n <= 8) return "Carapace / launcher";
    if (n <= 17 || n === 37) return "Torso / interior";
    if (n <= 19) return "Head";
    if (n <= 25) return "Rear plates";
    if ((n >= 26 && n <= 29) || (n >= 68 && n <= 71)) return "Shoulders / secondaries";
    if (n <= 35) return "Rails / details";
    if (n >= 38 && n <= 57) return "Waist / legs";
    if (n === 58 || n === 59) return "Pennant / heat";
    if (n >= 60) return "Arm weapons";
  }
  return "Other";
}

test("Acastus-style numbered files land in expected groups", () => {
  assert.equal(groupForFileName("18 Head.stl"), "Head");
  assert.equal(groupForFileName("41 Lower Leg x2.stl"), "Waist / legs");
  assert.equal(groupForFileName("01 Carapace.stl"), "Carapace / launcher");
  assert.equal(groupForFileName("66 Manifold Pipe x12.stl"), "Arm weapons");
  assert.equal(groupForFileName("37 Torso Front.stl"), "Torso / interior");
});
