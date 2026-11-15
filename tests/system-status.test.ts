import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOrderLinkStore } from "../server/lib/order-links";
import {
  buildSystemTiles,
  listStoredSystemReports,
  parseStatusIngest,
  saveSystemReports,
  statusIngestAuthorized,
} from "../server/lib/system-status";

test("status ingest rejects unknown ids and stores a watchdog report", () => {
  const rejected = parseStatusIngest({ systems: [{ id: "not-a-system", status: "red", summary: "nope", checkedAt: "2026-11-14T21:00:00.000Z" }] });
  assert.equal(rejected.ok, false);

  const polled = parseStatusIngest({ systems: [{ id: "hubspot-sync", status: "red", summary: "override", checkedAt: "2026-11-14T21:00:00.000Z" }] });
  assert.equal(polled.ok, false);

  const parsed = parseStatusIngest({
    checkedAt: "2026-11-14T21:00:00.000Z",
    systems: [{ id: "syncthing", status: "yellow", summary: "1 peer", metrics: { peers: 1 } }],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.systems[0].status, "amber");

  const dir = mkdtempSync(join(tmpdir(), "system-status-"));
  const previous = process.env.ORDER_LINKS_DB_FILE;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "status.db");
  resetOrderLinkStore();
  try {
    saveSystemReports(parsed.systems);
    const stored = listStoredSystemReports();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].summary, "1 peer");
    const tiles = buildSystemTiles(stored, {
      now: new Date("2026-11-14T22:00:00.000Z"),
      webhook: { configured: true, lastDeliveryAt: "2026-11-13T16:15:26.106Z" },
      tracking: { count: 0, stuck: 0, lastEventAt: null },
    });
    const syncthing = tiles.find((tile) => tile.id === "syncthing");
    const make = tiles.find((tile) => tile.id === "make");
    const webhook = tiles.find((tile) => tile.id === "hubspot-webhook");
    const tracking = tiles.find((tile) => tile.id === "shipment-tracking");
    assert.equal(syncthing?.status, "amber");
    assert.equal(syncthing?.source, "ingest");
    assert.equal(make?.summary, "No data yet");
    assert.equal(make?.status, "unknown");
    assert.equal(webhook?.status, "amber");
    assert.equal(tracking?.summary, "No data yet");
  } finally {
    if (previous === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous;
    resetOrderLinkStore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status ingest token match ignores length mismatches", () => {
  assert.equal(statusIngestAuthorized("short", { SYSTEM_STATUS_INGEST_TOKEN: "much-longer-token" }), false);
  assert.equal(statusIngestAuthorized("same-token", { SYSTEM_STATUS_INGEST_TOKEN: "same-token" }), true);
  assert.equal(statusIngestAuthorized("", { SYSTEM_STATUS_INGEST_TOKEN: "" }), false);
});
