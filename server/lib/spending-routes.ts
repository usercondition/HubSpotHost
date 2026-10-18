import type { Express, Request, Response } from "express";
import { z } from "zod";
import { fetchPrintOrderDeals, fetchPrintOrderPipelineStages, HubSpotError } from "./hubspot";
import { collectShopDashboard } from "./shop-dashboard";
import { periodOverheadCents } from "./performance-routes";
import { SHOP_PERIODS, type ShopPeriodId } from "../../shared/shop-dashboard";
import { buildSpendingBottomLine, moveExpenseToSupplies, MoveExpenseError } from "./spending";

const moveSchema = z.object({
  expectAmountCents: z.number().int().min(0),
  expectStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  apply: z.boolean().default(false),
});

/** Owner-only Spending routes: combined bottom line + guarded "Move to Supplies". */
export function registerSpendingRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/spending/summary", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const period = String(req.query.period ?? "30");
    if (!SHOP_PERIODS.includes(period as ShopPeriodId)) return res.status(400).json({ ok: false, error: "Period must be 7, 30, 90, ytd, or all." });
    try {
      const now = new Date();
      const [deals, stages] = await Promise.all([fetchPrintOrderDeals(), fetchPrintOrderPipelineStages()]);
      const overheadCents = periodOverheadCents(period as ShopPeriodId, now);
      // Same collector and overhead as the Shop dashboard (no ship-to map needed here).
      const dashboard = collectShopDashboard({ deals, stages, period: period as ShopPeriodId, now, overheadCents });
      return res.json({ ok: true, period: dashboard.period, bottomLine: buildSpendingBottomLine(dashboard.books, overheadCents) });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 502).json({ ok: false, error: error instanceof Error ? error.message : "Could not load HubSpot order money" });
    }
  });

  app.post("/api/spending/expenses/:id/move-to-supplies", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = moveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "expectAmountCents and expectStartDate are required." });
    try {
      const result = moveExpenseToSupplies(String(req.params.id), { amountCents: parsed.data.expectAmountCents, startDate: parsed.data.expectStartDate }, { apply: parsed.data.apply });
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof MoveExpenseError) return res.status(error.status).json({ ok: false, error: error.message });
      return res.status(500).json({ ok: false, error: "Move failed; nothing changed." });
    }
  });
}
