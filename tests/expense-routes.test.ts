import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import http from "node:http";
import { registerExpenseRoutes } from "../server/lib/expense-routes";
import { archiveExpense, createExpense, createExpenses, updateExpense } from "../server/lib/expenses";
import { getSqlite } from "../server/lib/order-links";

const base = () => ({ idempotencyKey: `expense-test-${crypto.randomUUID()}`, vendor: "Test vendor", name: "Test expense", category: "Other" as const, amountCents: 1200, cadence: "monthly" as const, startDate: "2026-09-01" });

test("expense persistence is idempotent and audits lifecycle changes", () => {
  const input = base();
  const first: any = createExpense(input);
  const second: any = createExpense(input);
  assert.equal(first.id, second.id);
  const audit = getSqlite().prepare("SELECT action FROM expense_audit WHERE expense_id = ?").all(first.id) as Array<{ action: string }>;
  updateExpense(first.id, { ...input, vendor: "Updated" });
  archiveExpense(first.id);
  const actions = getSqlite().prepare("SELECT action FROM expense_audit WHERE expense_id = ? ORDER BY created_at").all(first.id) as Array<{ action: string }>;
  assert.deepEqual(actions.map((row) => row.action), ["created", "updated", "archived"]);
  const bulk = [base(), base()];
  const firstBulk: any[] = createExpenses(bulk);
  const retry: any[] = createExpenses(bulk);
  assert.deepEqual(retry.map((row) => row.id), firstBulk.map((row) => row.id));
});

test("expense routes reject missing owner code and cap bulk at 200", async () => {
  const app = express(); app.use(express.json());
  registerExpenseRoutes(app, (req, res) => {
    if (req.get("x-paid-order-access-code") === "ok") return false;
    res.status(401).json({ ok: false, error: "Owner access code required." }); return true;
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/expenses`);
    assert.equal(unauthorized.status, 401);
    const body = { expenses: Array.from({ length: 201 }, base) };
    const over = await fetch(`http://127.0.0.1:${port}/api/expenses/bulk`, { method: "POST", headers: { "content-type": "application/json", "x-paid-order-access-code": "ok" }, body: JSON.stringify(body) });
    assert.equal(over.status, 400);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("recurring routes create definitions and log an actual charge", async () => {
  const app = express(); app.use(express.json());
  registerExpenseRoutes(app, (req, res) => {
    if (req.get("x-paid-order-access-code") === "ok") return false;
    res.status(401).json({ ok: false }); return true;
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const headers = { "content-type": "application/json", "x-paid-order-access-code": "ok" };
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/expenses/recurring`, {
      method: "POST", headers, body: JSON.stringify({ ...base(), cadence: "usage-based", nextDueDate: "2026-10-01" }),
    });
    assert.equal(created.status, 201);
    const recurring = (await created.json()).recurring;
    const charge = await fetch(`http://127.0.0.1:${port}/api/expenses/recurring/${recurring.id}/charges`, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), amountCents: 1599, startDate: "2026-09-15" }),
    });
    assert.equal(charge.status, 201);
    const listed = await fetch(`http://127.0.0.1:${port}/api/expenses/recurring`, { headers });
    assert.equal((await listed.json()).recurring.some((row: { id: string }) => row.id === recurring.id), true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
