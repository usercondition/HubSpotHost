import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFloorNeeds, fepDuePrinters } from "../client/src/lib/floor-needs";
import { formatPacificClock, formatPacificSnapshot, syncPillCopy } from "../client/src/lib/sync-status";

const queueItem = {
  dealId: "1",
  dealName: "Knight - Castellan",
  amount: 129.99,
  shipBy: "2026-10-05",
  bucket: "next_print",
  needsReply: false,
  readyToPack: false,
  addressStatus: "ready" as const,
  chaseDraft: "",
  fulfillment: { readyPercent: 0 },
};

describe("shared needs-you count", () => {
  it("counts a deal alert and a shop task as the same badge", () => {
    const needs = buildFloorNeeds({
      today: "2026-09-25",
      attention: [
        {
          dealId: "1",
          dealName: "Knight - Castellan",
          issue: "No CTB plates",
          issueKey: "no_plates",
          detail: "No CTB plates attached",
        },
      ],
      deals: [{ dealId: "1", amount: 129.99 }],
      queue: [queueItem],
      pendingReview: 0,
      awaitingClient: 0,
      resinBuyNow: [],
      fepDue: [{ name: "Mighty 12K NEW" }],
    });
    assert.equal(needs.length, 2);
    assert.deepEqual(
      needs.map((need) => need.key),
      ["1-no_plates", "fep"],
    );
  });

  it("ignores idle printers and keeps a clear floor at zero", () => {
    assert.deepEqual(
      fepDuePrinters([
        { name: "Idle", status: "active", fepHoursUsedPercent: 10, fepLayersUsedPercent: 20 },
        { name: "Retired", status: "retired", fepHoursUsedPercent: 200, fepLayersUsedPercent: 200 },
      ]),
      [],
    );
    const needs = buildFloorNeeds({
      today: "2026-09-25",
      attention: [],
      deals: [],
      queue: [],
      pendingReview: 0,
      awaitingClient: 0,
      resinBuyNow: [],
      fepDue: [],
    });
    assert.equal(needs.length, 0);
  });
});

describe("sync pill", () => {
  it("shows a Pacific clock when HubSpot is in sync", () => {
    assert.equal(formatPacificClock("2026-09-25T19:39:00.000Z"), "12:39 PM PT");
    assert.match(formatPacificSnapshot("2026-09-25T19:47:00.000Z"), /^Snapshot 12:47 PM PT · Fri Sep 25$/);
    assert.deepEqual(
      syncPillCopy({
        issueCount: 0,
        writes: { pending: 0, failed: 0 },
        lastCheckedAt: "2026-09-25T19:39:00.000Z",
      }),
      { tone: "good", label: "HubSpot in sync · 12:39 PM PT" },
    );
  });

  it("switches the pill when writes are still outstanding", () => {
    assert.equal(
      syncPillCopy({ issueCount: 1, writes: { pending: 0, failed: 0 }, lastCheckedAt: "2026-09-25T19:39:00.000Z" }).tone,
      "warn",
    );
  });
});
