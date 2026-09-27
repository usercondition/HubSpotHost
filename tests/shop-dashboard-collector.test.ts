import test from "node:test";
import assert from "node:assert/strict";
import { selectDashboardResinCost } from "../server/lib/shop-dashboard";
import { buildShopDashboard, type ShopDashboardOrder } from "../shared/shop-dashboard";

test("collector resin choice prefers material and dedupes same file hash fallback", () => {
  const plates = [{ sha256: "same", resinCost: "4" }, { sha256: "same", resinCost: "4" }, { sha256: "other", resinCost: "6" }];
  assert.deepEqual(selectDashboardResinCost("17", plates), { cost: 17, estimated: false });
  assert.deepEqual(selectDashboardResinCost("", plates), { cost: 10, estimated: true });
});

test("Shipped and Out the door orders contribute to shipped revenue while charge-only orders are absent", () => {
  const base = { customer: null, createdAt: "2026-09-10T00:00:00Z", closedAt: "2026-09-11T00:00:00Z", open: false, won: true, lost: false, stageLabel: "Shipped", amount: 30, resinCost: 2, postage: 1, packaging: 0, shipBy: null, tentative: false, needsReply: false, shipping: "ship" as const, hasTracking: true };
  const dashboard = buildShopDashboard({ now: "2026-09-15T00:00:00Z", period: "30", orders: [{ id: "shipped", name: "order", ...base }, { id: "out", name: "order", ...base, stageLabel: "Out the door" }] as ShopDashboardOrder[], plates: [], bits: [], failures: [], printers: [], supplyPurchases: [], awaitingClient: 0 });
  assert.equal(dashboard.money.find((item) => item.id === "revenue-shipped")?.value, 60);
});
