/**
 * Owner routes for shop expenses. They never write to HubSpot.
 */
import type { Express, Request, Response } from "express";
import { createExpenseSchema, updateExpenseSchema } from "../../shared/expenses";
import { archiveExpense, createExpense, listExpenseAudit, listExpenseRecords, listExpensesForView, updateExpense } from "./expenses";

function firstIssue(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Some details are missing or invalid";
}

function expenseId(value: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function registerExpenseRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean): void {
  app.get("/api/expenses", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const period = typeof req.query.period === "string" ? req.query.period : "30";
    const archived = req.query.archived === "1";
    return res.json({ ok: true, ...listExpensesForView({ category, period, archived }) });
  });

  app.get("/api/expenses/:id", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const id = expenseId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ ok: false, error: "That expense was not found." });
    const expense = listExpenseRecords().find((row) => row.id === id) ?? null;
    if (!expense) return res.status(404).json({ ok: false, error: "That expense was not found." });
    return res.json({ ok: true, expense, audit: listExpenseAudit(id) });
  });

  app.post("/api/expenses", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const parsed = createExpenseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const end = parsed.data.endDate?.trim() || null;
    const result = createExpense({ ...parsed.data, endDate: end });
    return res.status(result.created ? 201 : 200).json({ ok: true, created: result.created, expense: result.expense });
  });

  app.patch("/api/expenses/:id", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const id = expenseId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ ok: false, error: "That expense was not found." });
    const parsed = updateExpenseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    try {
      const endDate = parsed.data.endDate === undefined ? undefined : parsed.data.endDate?.trim() || null;
      const expense = updateExpense(id, { ...parsed.data, endDate });
      if (!expense) return res.status(404).json({ ok: false, error: "That expense was not found." });
      return res.json({ ok: true, expense, audit: listExpenseAudit(id) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not update that expense." });
    }
  });

  app.post("/api/expenses/:id/archive", (req: Request, res: Response) => {
    if (rejectOwner(req, res)) return;
    const id = expenseId(String(req.params.id ?? ""));
    if (!id) return res.status(400).json({ ok: false, error: "That expense was not found." });
    const expense = archiveExpense(id);
    if (!expense) return res.status(404).json({ ok: false, error: "That expense was not found." });
    return res.json({ ok: true, expense, audit: listExpenseAudit(id) });
  });
}
