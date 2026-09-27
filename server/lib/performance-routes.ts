import type { Express, Request, Response } from "express";
import { fetchHubSpotPortalId, fetchPrintOrderDeals, fetchPrintOrderPipelineStages, HubSpotError, type HubSpotDealRecord, type HubSpotPipelineStage } from "./hubspot";
import { buildPerformanceSnapshot } from "./performance";
import { collectShopDashboard } from "./shop-dashboard";
import { loadDealShipTos } from "./ship-to-index";
import { activeAttentionOverrideKeys } from "./attention";
import { orderLinkCounts } from "./order-links";
import { buildSupplySpendSummary } from "./supplies";
import { attachedPrintFileDealIds, syncPrintFileDealStages } from "./print-files";
import { attachedShippingLabelDealIds } from "./fulfillment";
import { SHOP_PERIODS, type ShopPeriodId, resolveShopWindow } from "../../shared/shop-dashboard";
import { shipByCalendarDate } from "../../shared/ship-by";
import { listExpenses, overheadForPeriod } from "./expenses";

export function refreshPrintFileStagesFromHubSpot(deals: HubSpotDealRecord[], stages: HubSpotPipelineStage[]) {
  const byStage = new Map(stages.map((stage) => [stage.id, stage]));
  syncPrintFileDealStages(new Map(deals.map((deal) => {
    const stageId = deal.properties.dealstage ?? "";
    return [deal.id, { stage: byStage.get(stageId)?.label || stageId || "No stage", dealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}` }];
  })));
}

export function registerPerformanceRoutes(app: Express, rejectOwner: (req: Request, res: Response) => boolean) {
  app.get("/api/performance", async (req, res) => {
    if (rejectOwner(req, res)) return;
    try {
      const [deals, stages, hubspotPortalId] = await Promise.all([fetchPrintOrderDeals(), fetchPrintOrderPipelineStages(), fetchHubSpotPortalId()]);
      refreshPrintFileStagesFromHubSpot(deals, stages);
      const snapshot = buildPerformanceSnapshot({ deals, stages, intakeCounts: orderLinkCounts(), supplySpend: buildSupplySpendSummary(), attachedPrintDealIds: attachedPrintFileDealIds(), shippingLabelDealIds: attachedShippingLabelDealIds(), dismissedAttentionKeys: activeAttentionOverrideKeys(), hubspotPortalId });
      if (String(req.query.dashboard ?? "") !== "1") return res.json(snapshot);
      const period = String(req.query.period ?? "30");
      if (!SHOP_PERIODS.includes(period as ShopPeriodId)) return res.status(400).json({ ok: false, error: "Period must be 7, 30, 90, ytd, or all." });
      const shipToLoad = await loadDealShipTos(deals.map((deal) => deal.id));
      const window = resolveShopWindow(period as ShopPeriodId, new Date());
      const overhead = overheadForPeriod(listExpenses(), window.start == null ? "0000-01-01" : shipByCalendarDate(new Date(window.start)), shipByCalendarDate(new Date(window.end)));
      return res.json({ ...snapshot, dashboard: collectShopDashboard({ deals, stages, period: period as ShopPeriodId, shipTos: shipToLoad.shipTos, mapIncomplete: shipToLoad.incomplete, mapBusy: shipToLoad.busy, overheadCents: overhead }) });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 502).json({ ok: false, error: error instanceof Error ? error.message : "Could not load HubSpot performance data" });
    }
  });
}
