import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrintFileOrderSummary } from "../shared/schema";

const previousDbFile = process.env.ORDER_LINKS_DB_FILE;
const dbFile = path.join(os.tmpdir(), `hubspot-print-file-metrics-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;
const { patchDealPrintFileMetrics } = await import("../server/lib/hubspot");

test.after(() => {
  if (previousDbFile === undefined) delete process.env.ORDER_LINKS_DB_FILE;
  else process.env.ORDER_LINKS_DB_FILE = previousDbFile;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* test cleanup */
    }
  }
});

const summary = {
  plateCount: 2,
  totalPrintTimeSeconds: 7_200,
  totalResinVolumeMl: 25,
  totalResinMassG: 27,
  totalResinCost: 4.5,
  totalLayerCount: 400,
  latest: {
    fileName: "knight.ctb",
    formatRevision: "CTB v4",
    bottomLayerCount: 6,
    exposureSeconds: 2.5,
    bottomExposureSeconds: 30,
    modelHeightMm: 80,
    layerHeightMm: 0.05,
    printerProfile: "Mighty 12K",
  },
} as PrintFileOrderSummary;

async function patchMetrics(
  t: test.TestContext,
  currentProperties: Record<string, string | null>,
  overwrite = false,
): Promise<Record<string, string> | null> {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const originalBase = process.env.HUBSPOT_API_BASE;
  let patched: Record<string, string> | null = null;

  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.HUBSPOT_API_BASE = "https://hubspot.test";
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/crm/v3/properties/deals" && method === "GET") {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.pathname === "/crm/v3/objects/deals/123" && method === "GET") {
      return new Response(JSON.stringify({ properties: currentProperties }), { status: 200 });
    }
    if (url.pathname === "/crm/v3/objects/deals/123" && method === "PATCH") {
      patched = JSON.parse(String(init?.body)).properties;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = originalToken;
    if (originalBase === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = originalBase;
  });

  await patchDealPrintFileMetrics("123", summary, "2026-10-02T16:00:00.000Z", overwrite);
  return patched;
}

test("slice metrics fill blank HubSpot fields", async (t) => {
  const patched = await patchMetrics(t, { print_slice_file_name: "" });

  assert.equal(patched?.print_slice_file_name, "knight.ctb");
  assert.equal(patched?.print_plate_count, "2");
});

test("slice metrics preserve populated HubSpot fields", async (t) => {
  const patched = await patchMetrics(t, {
    print_slice_file_name: "owner-entered.ctb",
    print_exposure_seconds: "9",
  });

  assert.equal(patched?.print_slice_file_name, undefined);
  assert.equal(patched?.print_exposure_seconds, undefined);
  assert.equal(patched?.print_plate_count, "2");
});

test("slice metrics overwrite populated HubSpot fields only when explicitly requested", async (t) => {
  const patched = await patchMetrics(
    t,
    { print_slice_file_name: "owner-entered.ctb", print_exposure_seconds: "9" },
    true,
  );

  assert.equal(patched?.print_slice_file_name, "knight.ctb");
  assert.equal(patched?.print_exposure_seconds, "2.5");
});
