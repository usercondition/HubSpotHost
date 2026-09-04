/**
 * Shared label → checklist + HubSpot writeback used by PDF attach and Shippo buy.
 */
import type { DealCostFields } from "../../shared/schema";
import { enqueueMarketplaceShipmentSendRequest } from "./marketplace-send-request-store";
import { fetchDealAssociatedContact, seedPrintDealCosts, updateDealCosts } from "./deal-ops";
import {
  getFulfillmentChecklist,
  listExistingTrackingAttachments,
  upsertFulfillmentChecklist,
  type HubSpotShippingSync,
} from "./fulfillment";
import type { AttachShippingLabelInput } from "./shipping-label";

export type AttachShippingLabelResult =
  | {
      ok: true;
      duplicate: true;
      message: string;
      attachedDealIds: string[];
      skippedDealIds: string[];
      checklist: ReturnType<typeof getFulfillmentChecklist>;
      hubspot: null;
      costs: null;
      costsError: null;
      contact: { id: string | null; name: string; email: string };
      alreadyAttached: {
        dealId: string;
        trackingNumber: string;
        notes: string;
        source: "local" | "hubspot";
        updatedAt: string | null;
      };
      marketplaceSend: null;
    }
  | {
      ok: true;
      duplicate?: false;
      attachedDealIds: string[];
      skippedDealIds: string[];
    checklist: ReturnType<typeof getFulfillmentChecklist>;
    hubspot: HubSpotShippingSync | null;
    costs: DealCostFields | null;
    costsError: string | null;
    contact: { id: string | null; name: string; email: string };
      marketplaceSend: {
        queued: boolean;
        id: number;
        to: string;
        channel: "marketplace" | "offerup";
      } | null;
    }
  | { ok: false; error: string; attachedDealIds: string[]; failedDealId: string };

export async function attachShippingLabelToDeals(
  input: AttachShippingLabelInput,
): Promise<AttachShippingLabelResult> {
  const notesBase = input.notes.trim();
  const dealIds = input.dealIds;
  const sharedNote =
    dealIds.length > 1
      ? `${notesBase}${notesBase ? " · " : ""}Shared tracking across ${dealIds.length} orders`
          .trim()
          .slice(0, 2_000)
      : notesBase;

  const alreadyOn = listExistingTrackingAttachments(input.trackingNumber);
  const alreadyOnSelected = alreadyOn.filter((row) => dealIds.includes(row.dealId));
  const toAttach = dealIds.filter((id) => !alreadyOn.some((row) => row.dealId === id));

  if (toAttach.length === 0) {
    const primary = alreadyOnSelected[0] ?? alreadyOn[0]!;
    const contact = await fetchDealAssociatedContact(primary.dealId);
    return {
      ok: true,
      duplicate: true,
      message:
        dealIds.length > 1
          ? "This tracking is already on every selected Print Order — nothing else to do."
          : "This tracking is already attached to that Print Order — nothing else to do.",
      attachedDealIds: [],
      skippedDealIds: dealIds,
      checklist: getFulfillmentChecklist(primary.dealId),
      hubspot: null,
      costs: null,
      costsError: null,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
      },
      alreadyAttached: {
        dealId: primary.dealId,
        trackingNumber: primary.trackingNumber,
        notes: primary.notes,
        source: primary.source,
        updatedAt: primary.updatedAt,
      },
      marketplaceSend: null,
    };
  }

  const attachedDealIds: string[] = [];
  let primaryChecklist: ReturnType<typeof getFulfillmentChecklist> | null = null;
  let primaryHubspot: HubSpotShippingSync | null = null;
  let costs: Awaited<ReturnType<typeof updateDealCosts>> | null = null;
  const postage = input.postageUsd.replace(/[$,\s]/g, "").trim();

  for (let index = 0; index < toAttach.length; index += 1) {
    const dealId = toAttach[index]!;
    const fulfillment = await upsertFulfillmentChecklist(dealId, {
      trackingNumber: input.trackingNumber,
      trackingPasted: true,
      labelBought: input.labelBought,
      packingDone: input.packingDone,
      costsEntered: postage !== "" ? true : undefined,
      notes: sharedNote,
      liveWrite: input.liveWrite !== false,
    });
    if ("error" in fulfillment) {
      return {
        ok: false,
        error: fulfillment.error,
        attachedDealIds,
        failedDealId: dealId,
      };
    }
    attachedDealIds.push(dealId);
    if (!primaryChecklist) {
      primaryChecklist = fulfillment.checklist;
      primaryHubspot = fulfillment.hubspot;
    }

    const seeded = await seedPrintDealCosts(dealId, {
      postage,
      liveWrite: input.liveWrite !== false,
    });
    if (index === 0) {
      costs = seeded;
    }
  }

  const primaryDealId = attachedDealIds[0]!;
  const contact = await fetchDealAssociatedContact(primaryDealId);
  const postageAmount = Number(postage);
  const marketplaceSend =
    contact.name && Number.isFinite(postageAmount) && postage !== ""
      ? enqueueMarketplaceShipmentSendRequest({
          dealId: primaryDealId,
          trackingNumber: input.trackingNumber,
          to: contact.name,
          text: `Your order has shipped. Tracking: ${input.trackingNumber}.`,
          channel: input.messageChannel,
        })
      : null;

  return {
    ok: true,
    attachedDealIds,
    skippedDealIds: alreadyOnSelected.map((row) => row.dealId),
    checklist: primaryChecklist!,
    hubspot: primaryHubspot,
    costs: costs && costs.ok ? costs.costs : null,
    costsError: costs && !costs.ok ? costs.error : null,
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
    },
    marketplaceSend: marketplaceSend
      ? {
          queued: marketplaceSend.queued,
          id: marketplaceSend.request.id,
          to: marketplaceSend.request.to,
          channel: marketplaceSend.request.channel,
        }
      : null,
  };
}
