import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatShipByCalendarDescription,
  formatShipByCalendarTitle,
  shipByAllDayEndDate,
} from "../shared/shipby-gcal-format";
import {
  queueItemsForShipByGcal,
  readShipByGcalState,
  syncShipByGoogleCalendar,
  writeShipByGcalState,
  type GoogleCalendarClient,
  type ShipByCalendarDeal,
} from "../server/lib/shipby-gcal";
import type { ProductionQueueItem, ProductionQueueResponse } from "../shared/schema";

test("ship-by calendar title matches Intern honesty format", () => {
  assert.equal(
    formatShipByCalendarTitle({
      dealId: "1",
      dealName: "Knight bust",
      contactName: "Ada",
      amount: 180,
      shipBy: "2026-09-20",
      shipBySource: "derived",
    }),
    "Ship · Knight bust — Ada ($180)",
  );
  assert.equal(
    formatShipByCalendarTitle({
      dealId: "2",
      dealName: "Terrain pack",
      shipBy: "2026-09-20",
      shipBySource: "override",
    }),
    "Ship · Terrain pack",
  );
});

test("all-day end date is exclusive next day", () => {
  assert.equal(shipByAllDayEndDate("2026-09-17"), "2026-09-18");
  assert.equal(shipByAllDayEndDate("2026-12-31"), "2027-01-01");
});

test("description includes dealId, source, and Print Ops link", () => {
  const text = formatShipByCalendarDescription(
    {
      dealId: "9911",
      dealName: "Knight bust",
      stage: "Ready to Ship",
      shipBy: "2026-09-20",
      shipBySource: "override",
    },
    { publicBaseUrl: "https://ops.example" },
  );
  assert.match(text, /dealId: 9911/);
  assert.match(text, /shipBySource: override/);
  assert.match(text, /https:\/\/ops\.example\/#\/queue\?dealId=9911/);
});

function mockClient(store: Map<string, { id: string; start: string; summary: string }>): GoogleCalendarClient {
  let seq = 1;
  return {
    async listManagedEventIds() {
      const map = new Map<string, string>();
      for (const [dealId, event] of store) map.set(dealId, event.id);
      return map;
    },
    async createEvent(input) {
      const id = `evt-${seq++}`;
      store.set(input.dealId, { id, start: input.startDate, summary: input.summary });
      return id;
    },
    async updateEvent(eventId, input) {
      for (const [dealId, event] of store) {
        if (event.id === eventId) {
          store.set(dealId, { id: eventId, start: input.startDate, summary: input.summary });
          return;
        }
      }
      throw new Error(`missing event ${eventId}`);
    },
    async deleteEvent(eventId) {
      for (const [dealId, event] of store) {
        if (event.id === eventId) {
          store.delete(dealId);
          return;
        }
      }
    },
  };
}

test("sync creates, moves, and deletes ship-by calendar events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shipby-gcal-"));
  const env = {
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@example.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "unused-in-mock",
    GOOGLE_SHIP_CALENDAR_ID: "primary",
    SHIPBY_GCAL_STATE_FILE: join(dir, "state.json"),
    PUBLIC_BASE_URL: "https://ops.example",
  } as NodeJS.ProcessEnv;
  const store = new Map<string, { id: string; start: string; summary: string }>();
  const client = mockClient(store);

  const open: ShipByCalendarDeal[] = [
    {
      dealId: "101",
      dealName: "Knight bust",
      contactName: "Ada",
      amount: 180,
      stage: "Printing",
      shipBy: "2026-09-20",
      shipBySource: "derived",
    },
  ];

  const created = await syncShipByGoogleCalendar(open, env, client);
  assert.equal(created.skipped, undefined);
  assert.equal(created.created, 1);
  assert.equal(store.get("101")?.start, "2026-09-20");
  assert.equal(store.get("101")?.summary, "Ship · Knight bust — Ada ($180)");

  const moved = await syncShipByGoogleCalendar(
    [{ ...open[0]!, shipBy: "2026-09-22", shipBySource: "override" }],
    env,
    client,
  );
  assert.equal(moved.updated, 1);
  assert.equal(moved.created, 0);
  assert.equal(store.get("101")?.start, "2026-09-22");
  assert.equal(readShipByGcalState(env).events["101"]?.shipBy, "2026-09-22");

  const closed = await syncShipByGoogleCalendar([], env, client);
  assert.equal(closed.deleted, 1);
  assert.equal(store.size, 0);
  assert.equal(Object.keys(readShipByGcalState(env).events).length, 0);

  rmSync(dir, { recursive: true, force: true });
});

test("sync skips when Google credentials are unset", async () => {
  const result = await syncShipByGoogleCalendar(
    [
      {
        dealId: "1",
        dealName: "X",
        shipBy: "2026-09-20",
        shipBySource: "derived",
      },
    ],
    {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(String(result.reason), /not configured/i);
});

test("queueItemsForShipByGcal flattens open buckets without duplicates", () => {
  const item = (dealId: string, shipBy: string): ProductionQueueItem =>
    ({
      dealId,
      dealName: `Deal ${dealId}`,
      stageId: "s",
      stage: "Printing",
      amount: 10,
      shipBy,
      shipBySource: "derived",
      closeDate: null,
      contactName: null,
      hasPlates: true,
      requiresPlates: true,
      plateCount: 1,
      totalPrintTimeSeconds: null,
      assignedPrinterIds: [],
      assignedPrinterNames: [],
      unassignedPlateCount: 0,
      kitNeeded: 0,
      kitReprint: 0,
      costsIncomplete: false,
      isStale: false,
      needsReply: false,
      readyToPack: false,
      fulfillment: {
        dealId,
        addressVerified: false,
        costsEntered: false,
        labelBought: false,
        trackingPasted: false,
        packingDone: false,
        trackingNumber: "",
        notes: "",
        completedCount: 0,
        totalCount: 5,
        readyPercent: 0,
        shipReady: false,
        updatedAt: null,
      },
      bucket: "in_production",
      priorityScore: 1,
    }) as ProductionQueueItem;

  const queue = {
    nextPrint: [item("1", "2026-09-20")],
    inProduction: [item("1", "2026-09-20"), item("2", "2026-09-21")],
    blocked: [],
    shipReady: [item("3", "2026-09-18")],
    needsReply: [],
    readyToPack: [],
    recentFailures: [],
    summary: {
      nextPrint: 1,
      inProduction: 2,
      shipReady: 1,
      blocked: 0,
      needsReply: 0,
      readyToPack: 0,
      openOrders: 3,
    },
    generatedAt: new Date().toISOString(),
    hubspotPortalId: null,
    stages: [],
    printers: [],
  } as ProductionQueueResponse;

  const deals = queueItemsForShipByGcal(queue);
  assert.equal(deals.length, 3);
  assert.deepEqual(
    deals.map((deal) => deal.dealId).sort(),
    ["1", "2", "3"],
  );
});

test("state write round-trips lastError for health warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipby-gcal-state-"));
  const env = { SHIPBY_GCAL_STATE_FILE: join(dir, "state.json") } as NodeJS.ProcessEnv;
  writeShipByGcalState(
    {
      events: {},
      lastError: "Google Calendar create failed (403)",
      lastSyncedAt: "2026-09-17T01:00:00.000Z",
    },
    env,
  );
  const read = readShipByGcalState(env);
  assert.match(String(read.lastError), /403/);
  assert.equal(read.lastSyncedAt, "2026-09-17T01:00:00.000Z");
  rmSync(dir, { recursive: true, force: true });
});
