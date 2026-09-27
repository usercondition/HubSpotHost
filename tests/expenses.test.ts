import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShopDashboard } from "../shared/shop-dashboard";
import {
  createExpenseSchema,
  formatShopDate,
  monthlyEquivalentCents,
  monthlyRunRateCents,
  netProfitAfterOverhead,
  overheadCentsForDates,
  type ExpenseSlice,
} from "../shared/expenses";

const monthly: ExpenseSlice = {
  amountCents: 3100,
  cadence: "monthly",
  startDate: "2026-01-01",
  endDate: null,
  archived: false,
};

test("overhead prorates by active days and counts each expense once", () => {
  assert.equal(overheadCentsForDates([monthly], "2026-01-01", "2026-01-31"), 3100);
  assert.equal(
    overheadCentsForDates([{ ...monthly, endDate: "2026-01-10" }], "2026-01-01", "2026-01-31"),
    1000,
  );
  assert.equal(
    overheadCentsForDates([{ amountCents: 36500, cadence: "yearly", startDate: "2026-01-01", endDate: null, archived: false }], "2026-03-01", "2026-03-10"),
    1000,
  );
  assert.equal(
    overheadCentsForDates([{ amountCents: 36600, cadence: "yearly", startDate: "2024-01-01", endDate: null, archived: false }], "2024-02-29", "2024-02-29"),
    100,
  );
  const oneOff: ExpenseSlice = { amountCents: 2400, cadence: "one-off", startDate: "2026-01-15", endDate: null, archived: false };
  assert.equal(overheadCentsForDates([oneOff], "2026-01-01", "2026-01-31"), 2400);
  assert.equal(overheadCentsForDates([oneOff], "2026-02-01", "2026-02-28"), 0);
  assert.equal(overheadCentsForDates([{ ...monthly, archived: true }], "2026-01-01", "2026-01-31"), 0);
  assert.equal(overheadCentsForDates([monthly, monthly], "2026-01-01", "2026-01-31"), 6200);
  assert.equal(monthlyEquivalentCents({ amountCents: 12000, cadence: "yearly", startDate: "2026-01-01", endDate: null, archived: false }, "2026-09-27"), 1000);
  assert.equal(monthlyEquivalentCents(oneOff, "2026-09-27"), null);
  assert.equal(
    monthlyRunRateCents(
      [monthly, { amountCents: 12000, cadence: "yearly", startDate: "2026-01-01", endDate: null, archived: false }, oneOff],
      "2026-09-27",
    ),
    4100,
  );
  assert.equal(netProfitAfterOverhead(72, 3100), 41);
  assert.equal(netProfitAfterOverhead(null, 3100), null);
  assert.equal(formatShopDate("2026-10-02"), "Oct 2");
  assert.equal(createExpenseSchema.safeParse({
    clientKey: "idempotent1",
    vendor: "Card",
    name: "Nope",
    category: "other",
    amountCents: 100,
    cadence: "one-off",
    startDate: "2026-09-01",
    paymentNote: "4111 1111 1111 1111",
  }).success, false);
});

test("net profit is gross profit minus overhead, and supply receipts stay separate", () => {
  const dashboard = buildShopDashboard({
    now: "2026-09-15T12:00:00.000Z",
    period: "30",
    orders: [
      {
        id: "shop",
        name: "Shop order",
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
      },
    ],
    plates: [],
    bits: [],
    failures: [],
    printers: [],
    supplyPurchases: [{ purchasedAt: "2026-09-02T00:00:00.000Z", amount: 15 }],
    expenses: [monthly],
    awaitingClient: 0,
  });
  const byId = (id: string) => dashboard.money.find((item) => item.id === id);
  const profit = byId("gross-profit")?.value;
  const overhead = byId("overhead")?.value ?? 0;
  const net = byId("net-profit")?.value;
  assert.equal(profit, 72);
  assert.equal(byId("supply-spend")?.value, 15);
  assert.ok(overhead > 0);
  assert.equal(net, netProfitAfterOverhead(profit ?? null, Math.round(overhead * 100)));
  assert.equal(byId("overhead")?.formula.includes("Supply receipts are not included"), true);
  assert.equal(byId("net-profit")?.formula.includes("not subtracted again"), true);
  const empty = buildShopDashboard({
    now: "2026-09-15T12:00:00.000Z",
    period: "30",
    orders: [],
    plates: [],
    bits: [],
    failures: [],
    printers: [],
    supplyPurchases: [],
    awaitingClient: 0,
  });
  assert.equal(empty.money.find((item) => item.id === "overhead")?.value, 0);
  assert.equal(empty.money.find((item) => item.id === "net-profit")?.value, null);
});

test("expense routes are owner-only, idempotent, archived in place, and never call HubSpot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "expenses-"));
  const previous = {
    db: process.env.ORDER_LINKS_DB_FILE,
    dry: process.env.DRY_RUN,
    writes: process.env.ALLOW_HUBSPOT_WRITES,
    base: process.env.HUBSPOT_API_BASE,
    token: process.env.HUBSPOT_ACCESS_TOKEN,
    hash: process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH,
  };
  const calls: string[] = [];
  const mock = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const mockPort = (mock.address() as { port: number }).port;
  process.env.ORDER_LINKS_DB_FILE = join(dir, "test.db");
  process.env.DRY_RUN = "false";
  process.env.ALLOW_HUBSPOT_WRITES = "true";
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto.createHash("sha256").update("stack-test", "utf8").digest("hex");
  const { resetOrderLinkStore, getSqlite } = await import("../server/lib/order-links");
  resetOrderLinkStore();
  const { registerRoutes } = await import("../server/routes");
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { "content-type": "application/json", "x-paid-order-access-code": "stack-test" };
  const body = {
    clientKey: "idempotent-key",
    vendor: "File club",
    name: "Monthly files",
    category: "models_patreon",
    amountCents: 1200,
    cadence: "monthly",
    startDate: "2026-01-01",
    paymentNote: "Shop card",
    notes: "",
  };
  try {
    const empty = await fetch(`${base}/api/expenses`, { headers });
    const emptyBody = await empty.json();
    assert.equal(empty.status, 200);
    assert.equal(emptyBody.stored, 0);
    assert.deepEqual(emptyBody.expenses, []);

    const locked = await fetch(`${base}/api/expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(locked.status, 401);

    const created = await fetch(`${base}/api/expenses`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.expense.amountCents, 1200);

    const retry = await fetch(`${base}/api/expenses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, amountCents: 9999, name: "Duplicate" }),
    });
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.created, false);
    assert.equal(retryBody.expense.id, createdBody.expense.id);
    assert.equal(retryBody.expense.amountCents, 1200);
    assert.equal(retryBody.expense.name, "Monthly files");

    const listed = await fetch(`${base}/api/expenses?period=all`, { headers });
    const listedBody = await listed.json();
    assert.equal(listedBody.expenses.length, 1);

    const edited = await fetch(`${base}/api/expenses/${createdBody.expense.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Monthly file club" }),
    });
    assert.equal(edited.status, 200);
    const editedBody = await edited.json();
    assert.equal(editedBody.expense.name, "Monthly file club");
    assert.equal(editedBody.audit.length, 2);
    assert.equal(editedBody.audit[0].action, "create");
    assert.equal(editedBody.audit[1].action, "update");
    assert.match(editedBody.audit[1].oldJson, /Monthly files/);
    assert.match(editedBody.audit[1].newJson, /Monthly file club/);

    const card = await fetch(`${base}/api/expenses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, clientKey: "other-key", paymentNote: "4111111111111111" }),
    });
    assert.equal(card.status, 400);

    const archived = await fetch(`${base}/api/expenses/${createdBody.expense.id}/archive`, { method: "POST", headers });
    assert.equal(archived.status, 200);
    const archivedBody = await archived.json();
    assert.equal(archivedBody.expense.archived, true);
    assert.equal(archivedBody.audit.some((entry: { action: string }) => entry.action === "archive"), true);
    const count = getSqlite().prepare(`SELECT COUNT(*) AS n FROM shop_expenses`).get() as { n: number };
    assert.equal(count.n, 1);
    const after = await fetch(`${base}/api/expenses?period=all`, { headers });
    const afterBody = await after.json();
    assert.equal(afterBody.expenses.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    server.close();
    mock.close();
    resetOrderLinkStore();
    if (previous.db === undefined) delete process.env.ORDER_LINKS_DB_FILE;
    else process.env.ORDER_LINKS_DB_FILE = previous.db;
    if (previous.dry === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previous.dry;
    if (previous.writes === undefined) delete process.env.ALLOW_HUBSPOT_WRITES;
    else process.env.ALLOW_HUBSPOT_WRITES = previous.writes;
    if (previous.base === undefined) delete process.env.HUBSPOT_API_BASE;
    else process.env.HUBSPOT_API_BASE = previous.base;
    if (previous.token === undefined) delete process.env.HUBSPOT_ACCESS_TOKEN;
    else process.env.HUBSPOT_ACCESS_TOKEN = previous.token;
    if (previous.hash === undefined) delete process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH;
    else process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = previous.hash;
    rmSync(dir, { recursive: true, force: true });
  }
});
