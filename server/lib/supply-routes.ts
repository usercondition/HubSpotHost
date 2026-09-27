import type { Express, Request, Response } from "express";
import { createSupplyPurchaseSchema } from "../../shared/schema";
import { buildSupplySpendSummary, createSupplyPurchase, listSupplyPurchases } from "./supplies";
import { firstIssue } from "./validation";

/** Owner-only supply ledger; receipt parsing remains beside its upload middleware. */
export function registerSupplyRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/supplies", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({
      ok: true,
      purchases: listSupplyPurchases(),
      summary: buildSupplySpendSummary(),
    });
  });

  app.post("/api/supplies", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = createSupplyPurchaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    const purchase = createSupplyPurchase(parsed.data);
    return res.status(201).json({
      ok: true,
      purchase,
      summary: buildSupplySpendSummary(),
    });
  });
}
