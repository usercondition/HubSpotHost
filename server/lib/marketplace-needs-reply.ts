/**
 * Reflect explicitly linked Marketplace brief threads in HubSpot's Queue flag.
 *
 * A thread is eligible only when its scanner/API payload carries a numeric
 * Print Order `dealId`; buyer names are deliberately never used to match.
 */
import type { MarketplaceInboxBrief, MarketplaceThreadStatus } from "./marketplace-inbox-brief";
import { patchDealNeedsReply } from "./hubspot";

const REPLY_OR_CHASE_STATUSES = new Set<MarketplaceThreadStatus>([
  "your_turn",
  "paid_needs_details",
  "awaiting_payment",
  "stale",
]);

export function briefStatusNeedsReply(status: MarketplaceThreadStatus): boolean {
  return REPLY_OR_CHASE_STATUSES.has(status);
}

export async function syncMarketplaceBriefNeedsReply(
  brief: MarketplaceInboxBrief,
  writeFlag: (dealId: string, needsReply: boolean) => Promise<void> = patchDealNeedsReply,
): Promise<{ updatedDealIds: string[] }> {
  // Several scanned threads can be tied to one order. Keep it surfaced while
  // any of them still needs the shop; only clear when all linked threads don't.
  const desiredByDeal = new Map<string, boolean>();
  for (const thread of brief.threads) {
    if (!thread.dealId) continue;
    desiredByDeal.set(
      thread.dealId,
      Boolean(desiredByDeal.get(thread.dealId)) || briefStatusNeedsReply(thread.status),
    );
  }

  const updatedDealIds: string[] = [];
  for (const [dealId, needsReply] of Array.from(desiredByDeal.entries())) {
    await writeFlag(dealId, needsReply);
    updatedDealIds.push(dealId);
  }
  return { updatedDealIds };
}
