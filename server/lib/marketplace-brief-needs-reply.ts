/**
 * Project Marketplace secretary conclusions onto the existing HubSpot chase
 * checkbox. A thread must carry an explicit Print Order id; title-based
 * matching is intentionally not used because buyer names are not unique.
 */
import { PRINT_NEEDS_REPLY_PROPERTY } from "../../shared/schema";
import { ensurePrintFileDealProperties, fetchPrintOrderDeals, patchDealOutputs } from "./hubspot";
import type { MarketplaceInboxBrief } from "./marketplace-inbox-brief";

export type MarketplaceBriefReplySync = {
  matchedDealIds: string[];
  updatedDealIds: string[];
  skippedDealIds: string[];
};

function isReplyOrChaseStatus(status: string): boolean {
  return status === "your_turn" || status === "paid_needs_details" || status === "stale";
}

/**
 * Sync only linked Print Orders. If several scanned threads point to one deal,
 * any thread requiring a reply wins; otherwise that linked deal is cleared.
 */
export async function syncMarketplaceBriefNeedsReply(
  brief: MarketplaceInboxBrief,
): Promise<MarketplaceBriefReplySync> {
  const desiredByDeal = new Map<string, boolean>();
  for (const thread of brief.threads) {
    const needsReply = isReplyOrChaseStatus(thread.status);
    for (const dealId of thread.dealIds) {
      desiredByDeal.set(dealId, desiredByDeal.get(dealId) === true || needsReply);
    }
  }

  if (desiredByDeal.size === 0) {
    return { matchedDealIds: [], updatedDealIds: [], skippedDealIds: [] };
  }

  const printDeals = await fetchPrintOrderDeals();
  const knownPrintIds = new Set(printDeals.map((deal) => deal.id));
  const linkedDealIds = Array.from(desiredByDeal.keys());
  const matchedDealIds = linkedDealIds.filter((dealId) => knownPrintIds.has(dealId));
  const skippedDealIds = linkedDealIds.filter((dealId) => !knownPrintIds.has(dealId));
  if (matchedDealIds.length === 0) return { matchedDealIds, updatedDealIds: [], skippedDealIds };

  await ensurePrintFileDealProperties();
  const updatedDealIds: string[] = [];
  for (const dealId of matchedDealIds) {
    const deal = printDeals.find((row) => row.id === dealId);
    const current = deal?.properties[PRINT_NEEDS_REPLY_PROPERTY];
    const desired = desiredByDeal.get(dealId) === true;
    const currentlySet = current === "true" || current === "1" || current === "yes";
    if (currentlySet === desired) continue;
    await patchDealOutputs(dealId, { [PRINT_NEEDS_REPLY_PROPERTY]: desired ? "true" : "false" });
    updatedDealIds.push(dealId);
  }
  return { matchedDealIds, updatedDealIds, skippedDealIds };
}

/** Clear the chase flag after the Print Ops Messenger helper confirms a send. */
export async function clearPrintOrderNeedsReply(dealId: string): Promise<boolean> {
  const printDeals = await fetchPrintOrderDeals();
  const deal = printDeals.find((row) => row.id === dealId);
  if (!deal) return false;
  const current = deal.properties[PRINT_NEEDS_REPLY_PROPERTY];
  const currentlySet = current === "true" || current === "1" || current === "yes";
  if (!currentlySet) return true;
  await ensurePrintFileDealProperties();
  await patchDealOutputs(dealId, { [PRINT_NEEDS_REPLY_PROPERTY]: "false" });
  return true;
}
