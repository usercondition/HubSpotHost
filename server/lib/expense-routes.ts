import type { Express, Request, Response } from "express";
import { z } from "zod";
import { archiveExpense, createExpense, createExpenses, endRecurringExpense, listExpenses, listRecurringExpenses, logRecurringCharge, updateExpense } from "./expenses";
import { EXPENSE_CATEGORIES } from "../../shared/expenses";

const expenseSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  vendor: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  category: z.enum(EXPENSE_CATEGORIES),
  amountCents: z.number().int().min(0),
  currency: z.enum(["USD", "EUR"]).default("USD"),
  usdAmountCents: z.number().int().min(0).nullable().optional(),
  cadence: z.enum(["one-off", "monthly", "yearly", "usage", "usage-based", "installment"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paymentCount: z.number().int().positive().nullable().optional(),
  paymentNote: z.string().max(500).optional(),
  notes: z.string().max(4000).optional(),
  isRecurring: z.boolean().optional(),
  recurringStatus: z.enum(["active", "ended", "paused"]).optional(),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const chargeSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  amountCents: z.number().int().min(0),
  currency: z.enum(["USD", "EUR"]).default("USD"),
  usdAmountCents: z.number().int().min(0).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentNumber: z.number().int().positive().nullable().optional(),
  notes: z.string().max(4000).optional(),
});

export function registerExpenseRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/expenses/recurring", (req, res) => {
    if (rejectOwner(req, res)) return;
    res.json({ recurring: listRecurringExpenses(String(req.query.archived ?? "") === "1") });
  });
  app.post("/api/expenses/recurring", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = expenseSchema.safeParse({ ...req.body, isRecurring: true });
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid recurring expense." });
    return res.status(201).json({ recurring: createExpense({ ...parsed.data, isRecurring: true }) });
  });
  app.put("/api/expenses/recurring/:id", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = expenseSchema.safeParse({ ...req.body, isRecurring: true });
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid recurring expense." });
    const recurring = updateExpense(req.params.id, { ...parsed.data, isRecurring: true });
    return recurring ? res.json({ recurring }) : res.status(404).json({ ok: false, error: "Recurring expense not found." });
  });
  app.post("/api/expenses/recurring/:id/end", (req, res) => {
    if (rejectOwner(req, res)) return;
    const recurring = endRecurringExpense(req.params.id);
    return recurring ? res.json({ recurring }) : res.status(404).json({ ok: false, error: "Recurring expense not found." });
  });
  app.post("/api/expenses/recurring/:id/charges", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = chargeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid charge." });
    const expense = logRecurringCharge(req.params.id, parsed.data);
    return expense ? res.status(201).json({ expense }) : res.status(404).json({ ok: false, error: "Recurring expense not found." });
  });
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
