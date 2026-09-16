/**
 * Project Marketplace secretary conclusions onto the existing HubSpot chase
 * checkbox. Explicit ids are preferred. For normal inbox scans, an exact
 * normalized identity match to exactly one approved local order link may
 * supply the linked Print Order; ambiguous names are never guessed.
 */
import { PRINT_NEEDS_REPLY_PROPERTY } from "../../shared/schema";
import { ensurePrintFileDealProperties, fetchPrintOrderDeals, patchDealOutputs } from "./hubspot";
import type { MarketplaceInboxBrief } from "./marketplace-inbox-brief";
import { listOrderLinks } from "./order-links";

export type MarketplaceBriefReplySync = {
  matchedDealIds: string[];
  updatedDealIds: string[];
  skippedDealIds: string[];
};

function isReplyOrChaseStatus(status: string): boolean {
  return status === "your_turn" || status === "paid_needs_details" || status === "stale";
}

function normalizedIdentity(value: string): string {
  return value
    .replace(/\(marketplace\)|\(offerup\)/gi, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function dealIdsFromLink(link: ReturnType<typeof listOrderLinks>[number]): string[] {
  const ids = [link.hubspotDealId ?? ""];
  try {
    const refs = JSON.parse(link.hubspotDealsJson) as unknown;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (ref && typeof ref === "object" && typeof (ref as { dealId?: unknown }).dealId === "string") {
          ids.push((ref as { dealId: string }).dealId);
        }
      }
    }
  } catch {
    // A legacy malformed local row is not a safe match candidate.
  }
  return ids.filter((id, index, all) => Boolean(id.trim()) && all.indexOf(id) === index);
}

function uniquelyLinkedDealIds(title: string): string[] {
  const identity = normalizedIdentity(title);
  if (identity.length < 2) return [];
  const matchingLinks = listOrderLinks()
    .filter((link) => link.status === "created")
    .filter((link) =>
      [link.clientFullName, link.clientUsername, link.buyerNameHint, link.buyerUsernameHint]
        .map(normalizedIdentity)
        .includes(identity),
    );
  const ids = matchingLinks.reduce<string[]>((all, link) => all.concat(dealIdsFromLink(link)), []);
  return ids.filter((id, index, all) => all.indexOf(id) === index).length === 1 ? ids : [];
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
    const dealIds = thread.dealIds.length > 0 ? thread.dealIds : uniquelyLinkedDealIds(thread.title);
    for (const dealId of dealIds) {
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
