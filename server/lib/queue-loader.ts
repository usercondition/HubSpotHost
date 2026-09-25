/**
 * One queue assembly for Floor, Queue, Stack, Ask Ops, and ship-by calendar sync.
 * Address enrichment stays optional so calendar sync does not fan out contact reads.
 */
import type { PerformanceResponse, ProductionQueueResponse } from "../../shared/schema";
import {
  fetchHubSpotPortalId,
  fetchPrintOrderDeals,
  fetchPrintOrderPipelineStages,
} from "./hubspot";
import { activeAttentionOverrideKeys } from "./attention";
import { orderLinkCounts } from "./order-links";
import { buildPerformanceSnapshot } from "./performance";
import { attachedShippingLabelDealIds } from "./fulfillment";
import { attachedPrintFileDealIds, syncPrintFileDealStages } from "./print-files";
import { attachShipAddressReadiness, buildProductionQueue } from "./production-queue";
import { buildSupplySpendSummary } from "./supplies";

export async function loadShopBoards(options?: {
  enrichAddresses?: boolean;
  refreshStages?: boolean;
}): Promise<{ snapshot: PerformanceResponse; queue: ProductionQueueResponse }> {
  const [deals, stages, hubspotPortalId] = await Promise.all([
    fetchPrintOrderDeals(),
    fetchPrintOrderPipelineStages(),
    fetchHubSpotPortalId(),
  ]);
  if (options?.refreshStages) {
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const map = new Map<string, { stage: string; dealName: string }>();
    for (const deal of deals) {
      const stageId = deal.properties.dealstage ?? "";
      const stage = stageById.get(stageId);
      map.set(deal.id, {
        stage: stage?.label || stageId || "No stage",
        dealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}`,
      });
    }
    syncPrintFileDealStages(map);
  }
  const snapshot = buildPerformanceSnapshot({
    deals,
    stages,
    intakeCounts: orderLinkCounts(),
    supplySpend: buildSupplySpendSummary(),
    attachedPrintDealIds: attachedPrintFileDealIds(),
    shippingLabelDealIds: attachedShippingLabelDealIds(),
    hubspotPortalId,
    dismissedAttentionKeys: activeAttentionOverrideKeys(),
  });
  const built = buildProductionQueue(snapshot);
  const queue = options?.enrichAddresses === false ? built : await attachShipAddressReadiness(built);
  return { snapshot: snapshot as PerformanceResponse, queue };
}

export async function loadProductionQueue(options?: {
  enrichAddresses?: boolean;
  refreshStages?: boolean;
}): Promise<ProductionQueueResponse> {
  return (await loadShopBoards(options)).queue;
}
