import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { archiveExpense, createExpense, createExpenses, listExpenses, updateExpense } from "./expenses";
import { EXPENSE_CATEGORIES } from "../../shared/expenses";

const expenseSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  vendor: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  category: z.enum(EXPENSE_CATEGORIES),
  amountCents: z.number().int().min(0),
  currency: z.enum(["USD", "EUR"]).default("USD"),
  usdAmountCents: z.number().int().min(0).nullable().optional(),
  cadence: z.enum(["one-off", "monthly", "yearly", "usage"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paymentCount: z.number().int().positive().nullable().optional(),
  paymentNote: z.string().max(500).optional(),
  notes: z.string().max(4000).optional(),
});

function rejectOwner(req: Request, res: Response) {
  const expected = process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim();
  const provided = req.get("x-paid-order-access-code")?.trim().replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !provided) { res.status(expected ? 401 : 503).json({ ok: false, error: expected ? "Owner access code required." : "Owner access code is not configured." }); return true; }
  const actual = crypto.createHash("sha256").update(provided).digest("hex");
  if (actual !== expected) { res.status(401).json({ ok: false, error: "Owner access code is invalid." }); return true; }
  return false;
}

export function registerExpenseRoutes(app: Express) {
  app.get("/api/expenses", (req, res) => {
    if (rejectOwner(req, res)) return;
    res.json({ expenses: listExpenses(String(req.query.archived ?? "") === "1") });
  });
  app.post("/api/expenses", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid expense." });
    return res.status(201).json({ expense: createExpense(parsed.data) });
  });
  app.post("/api/expenses/bulk", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = z.array(expenseSchema).min(1).max(200).safeParse(req.body?.expenses);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid expenses." });
    return res.status(201).json({ expenses: createExpenses(parsed.data) });
  });
  app.put("/api/expenses/:id", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid expense." });
    const expense = updateExpense(req.params.id, parsed.data);
    return expense ? res.json({ expense }) : res.status(404).json({ ok: false, error: "Expense not found." });
  });
  app.post("/api/expenses/:id/archive", (req, res) => {
    if (rejectOwner(req, res)) return;
    const expense = archiveExpense(req.params.id);
    return expense ? res.json({ expense }) : res.status(404).json({ ok: false, error: "Expense not found." });
  });
}
