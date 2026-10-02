import test from "node:test";
import assert from "node:assert/strict";
import { buildShopDashboard, resolveShopWindow, type ShopDashboardInput, type ShopDashboardOrder } from "../shared/shop-dashboard";

const NOW = "2026-09-15T12:00:00.000Z";

function order(partial: Partial<ShopDashboardOrder> & Pick<ShopDashboardOrder, "id">): ShopDashboardOrder {
  return {
    name: partial.id,
    customer: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    closedAt: null,
    open: true,
    won: false,
    lost: false,
    stageLabel: "Printing",
    amount: 100,
    resinCost: 20,
    postage: 8,
    packaging: 0,
    shipBy: null,
    tentative: false,
    needsReply: false,
    shipping: "ship",
    hasTracking: false,
    ...partial,
  };
}

function dashboard(partial: Partial<ShopDashboardInput> = {}) {
  return buildShopDashboard({
    now: NOW,
    period: "30",
    orders: [],
    plates: [],
    bits: [],
    failures: [],
    printers: [],
    supplyPurchases: [],
    awaitingClient: 0,
    ...partial,
  });
}

function byId(metrics: { id: string; value: number | null; note: string | null; previous: number | null }[], id: string) {
  const metric = metrics.find((item) => item.id === id);
  assert.ok(metric, id);
  return metric;
}

test("booked revenue skips blank amounts and compares the previous window", () => {
  const result = dashboard({
    orders: [
      order({ id: "priced", amount: 80, customer: "Ada" }),
      order({ id: "blank", amount: null, customer: "Bea" }),
      order({ id: "old", amount: 50, createdAt: "2026-07-01T12:00:00.000Z" }),
      order({ id: "prior", amount: 40, createdAt: "2026-07-20T12:00:00.000Z" }),
    ],
  });
  const revenue = byId(result.money, "revenue-booked");
  assert.equal(revenue.value, 80);
  assert.equal(revenue.previous, 40);
  assert.match(revenue.note ?? "", /1 order missing an amount/);
  assert.equal(byId(result.money, "orders").value, 2);
  assert.equal(byId(result.money, "aov").value, 80);
});

test("gross profit leaves out missing resin or postage and treats labor as zero", () => {
  const result = dashboard({
    orders: [
      order({ id: "complete", amount: 100, resinCost: 25, postage: 10, packaging: 0 }),
      order({ id: "no-resin", amount: 100, resinCost: null, postage: 10 }),
      order({ id: "no-postage", amount: 100, resinCost: 25, postage: null, shipping: "ship" }),
      order({ id: "pickup", amount: 40, resinCost: 5, postage: 0, packaging: 0, shipping: "pickup" }),
    ],
  });
  const profit = byId(result.money, "gross-profit");
  assert.equal(profit.value, 100);
  assert.match(profit.note ?? "", /2 orders missing cost/);
  assert.match(profit.note ?? "", /no-resin: resin/);
  assert.match(profit.note ?? "", /no-postage: postage/);
  assert.equal(byId(result.money, "margin").value, 71.43);
  assert.equal(byId(result.money, "cost-per-order").value, 20);
});

test("shipped revenue uses the close date, and firm ship-by drives on-time", () => {
  const result = dashboard({
    orders: [
      order({
        id: "on-time",
        open: false,
        won: true,
        amount: 60,
        createdAt: "2026-09-01T12:00:00.000Z",
        closedAt: "2026-09-08T12:00:00.000Z",
        shipBy: "2026-09-10",
      }),
      order({
        id: "late",
        open: false,
        won: true,
        amount: 30,
        createdAt: "2026-09-01T12:00:00.000Z",
        closedAt: "2026-09-12T12:00:00.000Z",
        shipBy: "2026-09-09",
      }),
      order({
        id: "tentative",
        open: false,
        won: true,
        amount: 15,
        createdAt: "2026-09-02T12:00:00.000Z",
        closedAt: "2026-09-11T12:00:00.000Z",
        shipBy: "2026-09-03",
        tentative: true,
      }),
      order({
        id: "still-open-late",
        open: true,
        amount: 200,
        shipBy: "2026-09-01",
        shipping: "ship",
        postage: null,
        hasTracking: false,
      }),
    ],
  });
  assert.equal(byId(result.money, "revenue-shipped").value, 105);
  assert.equal(byId(result.speed, "median-ship-days").value, 9);
  assert.equal(byId(result.speed, "on-time").value, 50);
  assert.equal(byId(result.speed, "late-now").value, 1);
  assert.equal(byId(result.money, "waiting-money").value, 200);
});

test("cash in production is open orders only, and lost deals are not shipped revenue", () => {
  const result = dashboard({
    orders: [
      order({ id: "open", amount: 70, stageLabel: "Printing" }),
      order({ id: "lost", open: false, lost: true, won: false, amount: 500, closedAt: "2026-09-12T12:00:00.000Z" }),
      order({ id: "unknown-ship", amount: 15, shipping: "unknown", postage: null }),
    ],
  });
  assert.equal(byId(result.money, "cash-in-production").value, 85);
  assert.equal(byId(result.money, "revenue-shipped").value, 0);
  assert.match(byId(result.money, "waiting-money").note ?? "", /1 open order with no ship or pickup flag/);
  assert.equal(result.pipeline[0]?.label, "Printing");
  assert.equal(result.pipeline[0]?.count, 2);
});

test("production sums real plate fields and leaves utilization empty", () => {
  const result = dashboard({
    plates: [
      { attachedAt: "2026-09-05T12:00:00.000Z", printTimeSeconds: 7200, resinVolumeMl: 40, resinCost: 6, printerLabel: "Mighty 8K New" },
      { attachedAt: "2026-09-06T12:00:00.000Z", printTimeSeconds: null, resinVolumeMl: null, resinCost: 4, printerLabel: "HeyGears Ultra" },
      { attachedAt: "2026-08-01T12:00:00.000Z", printTimeSeconds: 3600, resinVolumeMl: 10, resinCost: 2, printerLabel: "Mighty 8K Old" },
    ],
    bits: [{ status: "good" }, { status: "reprint" }],
    failures: [{ occurredAt: "2026-09-07T12:00:00.000Z" }],
    printers: [{ name: "Mighty 8K New", model: "Mighty 8K", fepChangedAt: null, hoursSinceFep: null, recommendedFepHours: 80 }],
  });
  assert.equal(byId(result.production, "plates").value, 2);
  assert.equal(byId(result.production, "print-hours").value, 2);
  assert.match(byId(result.production, "print-hours").note ?? "", /1 plate missing print time/);
  assert.equal(byId(result.production, "resin-ml").value, 40);
  assert.equal(byId(result.production, "resin-usd").value, 10);
  assert.equal(byId(result.production, "reprint-rate").value, 50);
  assert.equal(byId(result.production, "failures").value, 1);
  assert.equal(byId(result.production, "utilization").value, null);
  assert.match(byId(result.production, "utilization").note ?? "", /scheduled hours/);
  assert.deepEqual(result.printers, [{ label: "Mighty 8K", hours: 2 }]);
  assert.equal(result.fep[0]?.note, "No FEP change is logged.");
  assert.equal(byId(result.speed, "stage-time").value, null);
  assert.match(byId(result.channelMetrics, "revenue-by-source").note ?? "", /do not store/);
});

test("repeat customers use the recorded name, and empty periods stay empty", () => {
  const result = dashboard({
    period: "7",
    orders: [
      order({ id: "ada-now", customer: "Ada", amount: 20, createdAt: "2026-09-12T12:00:00.000Z" }),
      order({ id: "ada-old", customer: "Ada", amount: 20, createdAt: "2026-08-01T12:00:00.000Z" }),
      order({ id: "new", customer: "Cal", amount: 10, createdAt: "2026-09-14T12:00:00.000Z" }),
      order({ id: "unnamed", customer: null, amount: 5, createdAt: "2026-09-13T12:00:00.000Z" }),
    ],
    awaitingClient: 3,
  });
  assert.equal(byId(result.channelMetrics, "repeat-rate").value, 50);
  assert.match(byId(result.channelMetrics, "repeat-rate").note ?? "", /1 order with no customer name/);
  assert.equal(result.customers[0]?.name, "Ada");
  assert.equal(byId(result.pipelineMetrics, "awaiting-client").value, 3);
  assert.equal(byId(result.pipelineMetrics, "win-rate").value, null);
});

test("Pacific ship-by date stays current through 6 PM and YTD starts in Pacific time", () => {
  const result = dashboard({
    now: "2026-09-16T01:00:00.000Z", // Sep 15, 6 PM PT
    orders: [order({ id: "today", shipBy: "2026-09-15", amount: 10 })],
  });
  assert.equal(byId(result.speed, "late-now").value, 0);
  const ytd = resolveShopWindow("ytd", new Date("2026-01-01T07:30:00.000Z"));
  assert.equal(new Date(ytd.start!).toISOString(), "2025-01-01T08:00:00.000Z");
});

test("headline metric IDs identify the panel rows the view must exclude", () => {
  const result = dashboard({ orders: [order({ id: "one" })] });
  const headlineIds = new Set(result.headlines.map((item) => item.id));
  assert.deepEqual(result.money.filter((item) => headlineIds.has(item.id)).map((item) => item.id), ["revenue-booked", "revenue-shipped", "orders", "gross-profit", "margin"]);
  assert.deepEqual(result.speed.filter((item) => headlineIds.has(item.id)).map((item) => item.id), ["late-now"]);
});
