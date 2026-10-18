import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubSpotError, hubspotRequest, invalidateHubSpotPortalIdCache, invalidatePrintOrderDealsCache, invalidatePrintOrderStagesCache } from "../server/lib/hubspot";
import {
  ageDealContactCache,
  expireDealContactCache,
  fetchDealAssociatedContact,
  invalidateDealContactCache,
  buildDealOpsDetail,
} from "../server/lib/deal-ops";
import { attachShipAddressReadiness, queueItemsForShipAddressEnrichment } from "../server/lib/production-queue";
import { loadProductionQueue } from "../server/lib/queue-loader";
import { resetOrderLinkStore } from "../server/lib/order-links";
import { buildTrackerAssistantQueue } from "../server/lib/tracker-assistant";
import { runShipmentEmailJob } from "../server/lib/shipment-notification-jobs";
import { resetShippedEmailStore } from "../server/lib/shipped-email-store";
import { addressStatusWithLiveShipTo } from "../shared/ship-address";
import type { ProductionQueueItem, ProductionQueueResponse } from "../shared/schema";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Let fire-and-forget background refreshes settle before the next assertion. */
async function settleBackground(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * HubSpot batch mock: v4 deal->contact association batch read + v3 contact batch read.
 * associations maps dealId -> contactId (absent = no association); contacts maps contactId -> contact JSON.
 */
function batchFetch(
  data: { associations: Record<string, string>; contacts: Record<string, unknown> },
  calls?: string[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as { inputs?: Array<{ id: string }> };
    calls?.push(url);
    if (url.includes("/associations/deals/contacts/batch/read")) {
      const results = (body.inputs ?? [])
        .filter(({ id }) => data.associations[id])
        .map(({ id }) => ({ from: { id }, to: [{ toObjectId: Number(data.associations[id]), associationTypes: [] }] }));
      return jsonResponse({ status: "COMPLETE", results });
    }
    if (url.includes("/objects/contacts/batch/read")) {
      const results = (body.inputs ?? []).map(({ id }) => data.contacts[id]).filter(Boolean);
      return jsonResponse({ status: "COMPLETE", results });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

function shipReadyItem(dealId: string): ProductionQueueItem {
  return {
    dealId,
    dealName: `Print - ${dealId}`,
    stageId: "ship",
    stage: "Ready to Ship",
    amount: 80,
    shipBy: "2026-10-02",
    shipBySource: "derived",
    tentative: false,
    shipByReason: "plan",
    addressStatus: "unknown",
    addressSummary: null,
    chaseDraft: "",
    shippingRequired: true,
    closeDate: null,
    contactName: "Buyer",
    hasPlates: true,
    requiresPlates: true,
    plateCount: 1,
    totalPrintTimeSeconds: 3600,
    assignedPrinterIds: [],
    assignedPrinterNames: [],
    unassignedPlateCount: 0,
    kitNeeded: 0,
    kitReprint: 0,
    shipPlanNote: null,
    isStale: false,
    costsIncomplete: false,
    needsReply: false,
    readyToPack: true,
    bucket: "ship_ready",
    priorityScore: 1,
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
      readyPercent: 80,
      shipReady: true,
      updatedAt: null,
    },
  };
}

function queueOf(dealIds: string[]): ProductionQueueResponse {
  const shipReady = dealIds.map(shipReadyItem);
  return {
    generatedAt: "2026-09-27T00:00:00.000Z",
    hubspotPortalId: "1",
    stages: [],
    printers: [],
    nextPrint: [],
    inProduction: [],
    shipReady,
    blocked: [],
    needsReply: [],
    readyToPack: shipReady,
    recentFailures: [],
    summary: {
      nextPrint: 0,
      inProduction: 0,
      shipReady: shipReady.length,
      blocked: 0,
      needsReply: 0,
      readyToPack: shipReady.length,
      needsAddress: 9,
      openOrders: shipReady.length,
    },
  };
}

function fullContact(id: string) {
  return {
    id,
    properties: {
      firstname: "Daniel",
      lastname: "Ortega",
      email: "daniel@example.com",
      phone: "555",
      address: "123 Main St",
      city: "Phoenix",
      state: "AZ",
      zip: "85001",
      country: "US",
    },
  };
}

test("address enrichment includes next-print orders shown in the Stack", () => {
  const next = { ...shipReadyItem("next-print"), stage: "Waiting on printer", bucket: "next_print" as const };
  const queue = queueOf([]);
  queue.nextPrint = [next];
  assert.deepEqual(queueItemsForShipAddressEnrichment(queue).map((item) => item.dealId), ["next-print"]);
});

describe("address rate limit", { concurrency: 1 }, () => {
  const previousToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const originalFetch = globalThis.fetch;

  test("GET and search retry a 429; writes do not", async (t) => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    t.after(() => {
      globalThis.fetch = originalFetch;
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });

    let gets = 0;
    globalThis.fetch = (async () => {
      gets += 1;
      if (gets === 1) {
        return jsonResponse({ message: "limit" }, 429, { "retry-after": "0" });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const got = await hubspotRequest("/crm/v3/objects/deals/1", { method: "GET" });
    assert.equal(got.ok, true);
    assert.equal(gets, 2);

    let writes = 0;
    globalThis.fetch = (async () => {
      writes += 1;
      return jsonResponse({ message: "limit" }, 429, { "retry-after": "0" });
    }) as typeof fetch;
    await assert.rejects(
      () => hubspotRequest("/crm/v3/objects/deals/1", { method: "PATCH", body: "{}" }),
      (error: unknown) => error instanceof HubSpotError && error.status === 429,
    );
    assert.equal(writes, 1);

    let searches = 0;
    globalThis.fetch = (async () => {
      searches += 1;
      if (searches < 3) return jsonResponse({ message: "limit" }, 429, { "retry-after": "0" });
      return jsonResponse({ results: [] });
    }) as typeof fetch;
    const searched = await hubspotRequest("/crm/v3/objects/deals/search", {
      method: "POST",
      body: "{}",
    });
    assert.deepEqual(searched.results, []);
    assert.equal(searches, 3);

    let failures = 0;
    globalThis.fetch = (async () => {
      failures += 1;
      return jsonResponse({ message: "down" }, 500);
    }) as typeof fetch;
    await assert.rejects(
      () => hubspotRequest("/crm/v3/objects/deals/1", { method: "GET" }),
      (error: unknown) => error instanceof HubSpotError && error.status === 500,
    );
    assert.equal(failures, 1);
  });

  test("contact fetch rethrows 429 and returns empty only with no association", async (t) => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });

    globalThis.fetch = (async () => jsonResponse({ message: "limit" }, 429, { "retry-after": "0" })) as typeof fetch;
    await assert.rejects(
      () => fetchDealAssociatedContact("346140673754"),
      (error: unknown) => error instanceof HubSpotError && error.status === 429,
    );

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return jsonResponse({});
    }) as typeof fetch;
    await assert.rejects(
      () => fetchDealAssociatedContact("349919419125"),
      (error: unknown) => error instanceof HubSpotError && error.status === 504,
    );

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/associations/contacts")) return jsonResponse({ results: [] });
      return jsonResponse({ message: "unused" }, 500);
    }) as typeof fetch;
    const empty = await fetchDealAssociatedContact("349912151800");
    assert.equal(empty.id, null);
    assert.equal(empty.street1, "");
  });

  test("a 429 lookup never produces missing and falls back to the last cached contact", async (t) => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });

    const limited = "348746780377";
    const emptyDeal = "342134173423";
    // The whole association batch is rate limited: every deal stays unknown, none is "missing".
    globalThis.fetch = (async () => jsonResponse({ message: "limit" }, 429, { "retry-after": "0" })) as typeof fetch;
    const first = await attachShipAddressReadiness(queueOf([limited, emptyDeal]));
    assert.ok(first.shipReady.every((item) => item.addressStatus === "unknown"));
    assert.equal(first.summary.needsAddress, 0);

    // A deal with no associated contact (absent from the batch results) is "missing".
    globalThis.fetch = batchFetch({ contacts: {}, associations: {} });
    const none = await attachShipAddressReadiness(queueOf([emptyDeal]));
    assert.equal(none.shipReady[0]?.addressStatus, "missing");
    assert.equal(none.summary.needsAddress, 1);

    // A per-deal batch error that is not "no associations" is unknown, never missing.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/associations/deals/contacts/batch/read")) {
        return jsonResponse({ status: "COMPLETE", results: [], errors: [{ status: "error", category: "RATE_LIMITS", message: "busy", context: { fromObjectId: [limited] } }] }, 207);
      }
      return jsonResponse({});
    }) as typeof fetch;
    invalidateDealContactCache();
    const busy = await attachShipAddressReadiness(queueOf([limited]));
    assert.equal(busy.shipReady[0]?.addressStatus, "unknown");

    const cachedDeal = "346140673754";
    globalThis.fetch = batchFetch({ associations: { [cachedDeal]: "9001" }, contacts: { "9001": fullContact("9001") } });
    const warmed = await attachShipAddressReadiness(queueOf([cachedDeal]));
    assert.equal(warmed.shipReady[0]?.addressStatus, "ready");
    assert.equal(warmed.shipReady[0]?.addressSummary, "Phoenix, AZ");

    expireDealContactCache(cachedDeal);
    globalThis.fetch = (async () => jsonResponse({ message: "limit" }, 429, { "retry-after": "0" })) as typeof fetch;
    const stale = await attachShipAddressReadiness(queueOf([cachedDeal]));
    assert.equal(stale.shipReady[0]?.addressStatus, "ready");
    assert.equal(stale.shipReady[0]?.addressSummary, "Phoenix, AZ");
    assert.equal(stale.summary.needsAddress, 0);
    await settleBackground();

    ageDealContactCache(cachedDeal, 16 * 60 * 1000);
    const expired = await attachShipAddressReadiness(queueOf([cachedDeal]));
    assert.equal(expired.shipReady[0]?.addressStatus, "unknown");
    assert.notEqual(expired.shipReady[0]?.addressStatus, "missing");

    const partialDeal = "349912151800";
    globalThis.fetch = batchFetch({
      associations: { [partialDeal]: "9002" },
      contacts: { "9002": { id: "9002", properties: { firstname: "Glenn", lastname: "Chandler", address: "", city: "", state: "", zip: "" } } },
    });
    const incomplete = await attachShipAddressReadiness(queueOf([partialDeal]));
    assert.equal(incomplete.shipReady[0]?.addressStatus, "missing");
    expireDealContactCache(partialDeal);
    globalThis.fetch = (async () => jsonResponse({ message: "limit" }, 429, { "retry-after": "0" })) as typeof fetch;
    const failedIncomplete = await attachShipAddressReadiness(queueOf([partialDeal]));
    assert.equal(failedIncomplete.shipReady[0]?.addressStatus, "unknown");
    assert.notEqual(failedIncomplete.shipReady[0]?.addressStatus, "missing");
  });

  test("a stale ready address is served at once and refreshed by one background batch", async (t) => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });
    const dealId = "346140673754";
    const calls: string[] = [];
    globalThis.fetch = batchFetch({ associations: { [dealId]: "9001" }, contacts: { "9001": fullContact("9001") } }, calls);
    await attachShipAddressReadiness(queueOf([dealId]));
    assert.equal(calls.length, 2, "one association batch + one contact batch");
    const warm = await attachShipAddressReadiness(queueOf([dealId]));
    assert.equal(warm.shipReady[0]?.addressStatus, "ready");
    assert.equal(calls.length, 2, "fresh cache makes no HubSpot call");

    expireDealContactCache(dealId);
    const stale = await attachShipAddressReadiness(queueOf([dealId]));
    assert.equal(stale.shipReady[0]?.addressStatus, "ready");
    await settleBackground();
    assert.equal(calls.length, 4, "stale entry refreshed in the background");
  });

  test("unknown addresses stay out of the Ask Ops chase list", () => {
    const unknown = shipReadyItem("1");
    unknown.addressStatus = "unknown";
    const missing = shipReadyItem("2");
    missing.addressStatus = "missing";
    missing.chaseDraft = "Hey there";
    const queue = queueOf([]);
    queue.shipReady = [unknown, missing];
    queue.readyToPack = [];
    const assistant = buildTrackerAssistantQueue(queue);
    assert.deepEqual(
      assistant.needsAddress.map((deal) => deal.dealId),
      ["2"],
    );
  });

  test("a busy contact read throws so the shipment job can retry", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ship-email-"));
    const previousEmailDb = process.env.SHIPPED_EMAIL_DB_FILE;
    process.env.SHIPPED_EMAIL_DB_FILE = join(dir, "email.db");
    resetShippedEmailStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      resetShippedEmailStore();
      if (previousEmailDb === undefined) delete process.env.SHIPPED_EMAIL_DB_FILE;
      else process.env.SHIPPED_EMAIL_DB_FILE = previousEmailDb;
      rmSync(dir, { recursive: true, force: true });
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });
    globalThis.fetch = (async () => jsonResponse({ message: "limit" }, 429, { "retry-after": "0" })) as typeof fetch;
    await assert.rejects(
      () =>
        runShipmentEmailJob({
          dealId: "346140673754",
          trackingNumber: "1Z999",
          notes: "UPS Ground",
        }),
      (error: unknown) => error instanceof HubSpotError && error.status === 429,
    );
  });

  test("a missing contact skips the shipped email and is not retried", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ship-email-missing-"));
    const previousEmailDb = process.env.SHIPPED_EMAIL_DB_FILE;
    process.env.SHIPPED_EMAIL_DB_FILE = join(dir, "email.db");
    resetShippedEmailStore();
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    t.after(() => {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      resetShippedEmailStore();
      if (previousEmailDb === undefined) delete process.env.SHIPPED_EMAIL_DB_FILE;
      else process.env.SHIPPED_EMAIL_DB_FILE = previousEmailDb;
      rmSync(dir, { recursive: true, force: true });
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });
    globalThis.fetch = (async () => jsonResponse({ message: "missing" }, 404)) as typeof fetch;
    const result = await runShipmentEmailJob({
      dealId: "346140673754",
      trackingNumber: "1Z999",
      notes: "UPS Ground",
    });
    assert.equal(result.sent, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "No HubSpot contact linked");
    assert.ok(warnings.some((line) => line.includes("not found")));
  });

  test("a live ship-to that is not ready does not keep a ready pill", () => {
    assert.equal(addressStatusWithLiveShipTo("ready", false), "partial");
    assert.equal(addressStatusWithLiveShipTo("missing", false), "missing");
    assert.equal(addressStatusWithLiveShipTo("ready", true), "ready");
    assert.equal(addressStatusWithLiveShipTo("unknown", null), "unknown");
    assert.equal(addressStatusWithLiveShipTo("pickup", false), "pickup");
  });

  test("the drawer opens when the contact read is busy", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "drawer-contact-"));
    const previousDb = process.env.ORDER_LINKS_DB_FILE;
    process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    resetOrderLinkStore();
    invalidateDealContactCache();
    invalidatePrintOrderStagesCache();
    invalidateHubSpotPortalIdCache();
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      invalidatePrintOrderStagesCache();
      invalidateHubSpotPortalIdCache();
      resetOrderLinkStore();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
      if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
      else process.env.ORDER_LINKS_DB_FILE = previousDb;
      rmSync(dir, { recursive: true, force: true });
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/associations/contacts")) return jsonResponse({ message: "limit" }, 429, { "retry-after": "0" });
      if (url.includes("/objects/deals/")) {
        return jsonResponse({ id: "346140673754", properties: { dealname: "Print - Daniel", dealstage: "ship", amount: "80" } });
      }
      if (url.includes("/pipelines/deals/")) {
        return jsonResponse({ stages: [{ id: "ship", label: "Ready to Ship", displayOrder: 1, metadata: { isClosed: "false" } }] });
      }
      if (url.includes("/account-info/")) return jsonResponse({ portalId: 1 });
      return jsonResponse({});
    }) as typeof fetch;
    const detail = await buildDealOpsDetail("346140673754");
    assert.equal("error" in detail, false);
    if ("error" in detail) return;
    assert.equal(detail.addressStatus, "unknown");
    assert.equal(detail.packingSlip.contact.id, null);
    assert.deepEqual(detail.packingSlip.contact.addressLines, []);
  });

  test("four simultaneous queue loads make at most one contact lookup per deal", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "address-rate-"));
    const previousDb = process.env.ORDER_LINKS_DB_FILE;
    process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    resetOrderLinkStore();
    invalidateDealContactCache();
    invalidatePrintOrderDealsCache();
    invalidatePrintOrderStagesCache();
    invalidateHubSpotPortalIdCache();

    const deals = ["346140673754", "349919419125"];
    const lookups = new Map<string, number>();
    let associationBatches = 0;

    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      invalidatePrintOrderDealsCache();
      invalidatePrintOrderStagesCache();
      invalidateHubSpotPortalIdCache();
      resetOrderLinkStore();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
      if (previousDb === undefined) delete process.env.ORDER_LINKS_DB_FILE;
      else process.env.ORDER_LINKS_DB_FILE = previousDb;
      rmSync(dir, { recursive: true, force: true });
    });

    const contactsMock = batchFetch({ associations: Object.fromEntries(deals.map((id) => [id, "9001"])), contacts: { "9001": fullContact("9001") } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/associations/deals/contacts/batch/read")) {
        associationBatches += 1;
        for (const { id } of JSON.parse(String(init?.body ?? "{}")).inputs ?? []) lookups.set(id, (lookups.get(id) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return contactsMock(input, init);
      }
      if (url.includes("/objects/contacts/batch/read")) return contactsMock(input, init);
      if (url.includes("/deals/search")) {
        return jsonResponse({
          results: deals.map((id) => ({
            id,
            properties: {
              dealname: `Print - ${id}`,
              pipeline: "default",
              dealstage: "ship",
              amount: "80",
              createdate: "2026-09-01T00:00:00.000Z",
              hs_is_closed: "false",
            },
          })),
        });
      }
      if (url.includes("/pipelines/deals/")) {
        return jsonResponse({
          stages: [
            {
              id: "ship",
              label: "Ready to Ship",
              displayOrder: 1,
              metadata: { isClosed: "false" },
            },
          ],
        });
      }
      if (url.includes("/account-info/")) return jsonResponse({ portalId: 1 });
      return jsonResponse({});
    }) as typeof fetch;

    const loads = await Promise.all([
      loadProductionQueue({ enrichAddresses: true }),
      loadProductionQueue({ enrichAddresses: true }),
      loadProductionQueue({ enrichAddresses: true }),
      loadProductionQueue({ enrichAddresses: true }),
    ]);
    for (const dealId of deals) {
      assert.equal(lookups.get(dealId) ?? 0, 1, `contact lookups for ${dealId}`);
      assert.equal(loads[0]?.shipReady.find((item) => item.dealId === dealId)?.addressStatus, "ready");
    }
    assert.equal(associationBatches, 1, "all deals resolved in one association batch");
  });

  test("address enrichment uses one batch request for many deals", async (t) => {
    process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
    invalidateDealContactCache();
    const ids = ["11", "12", "13", "14", "15", "16"];
    let requests = 0;
    t.after(() => {
      globalThis.fetch = originalFetch;
      invalidateDealContactCache();
      if (previousToken === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
      else process.env.HUBSPOT_ACCESS_TOKEN = previousToken;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests += 1;
      const url = String(input);
      if (url.includes("/associations/deals/contacts/batch/read")) {
        return jsonResponse({ message: "limit" }, 429, { "retry-after": "0" });
      }
      return jsonResponse({});
    }) as typeof fetch;
    const queue = await attachShipAddressReadiness(queueOf(ids));
    assert.equal(requests, 1, `made ${requests} HubSpot requests`);
    assert.ok(queue.shipReady.every((item) => item.addressStatus === "unknown"));
    assert.equal(queue.summary.needsAddress, 0);
  });
});
