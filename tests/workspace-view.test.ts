import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceView, WORKSPACE_VIEWS } from "../client/src/lib/workspace-view";

test("workspace view defaults to standard ops", () => {
  assert.deepEqual([...WORKSPACE_VIEWS], ["ops", "workshop"]);
  assert.equal(parseWorkspaceView(null), "ops");
  assert.equal(parseWorkspaceView("ops"), "ops");
  assert.equal(parseWorkspaceView("workshop"), "workshop");
  assert.equal(parseWorkspaceView("chillsynth"), "ops");
  assert.equal(parseWorkspaceView("dark"), "ops");
});
