import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHeartbeat } from "../server/lib/systems-routes";

test("systems heartbeat normalizes supported statuses", () => {
  assert.deepEqual(normalizeHeartbeat({ service: "Syncthing", status: "green", metrics: { peers: 1 }, timestamp: "2026-11-02T00:00:00Z" }), { service: "Syncthing", status: "green", metrics: { peers: 1 }, timestamp: "2026-11-02T00:00:00Z" });
});
