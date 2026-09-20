/**
 * Shared label → checklist + HubSpot writeback used by PDF attach and ShipEngine buy.
 */
import type { DealCostFields } from "../../shared/schema";
import { enqueueMarketplaceShipmentSendRequest } from "./marketplace-send-request-store";
import {
  advanceDealStage,
  fetchDealAssociatedContact,
  resolveCompletedPrintOrderStage,
  seedPrintDealCosts,
  updateDealCosts,
} from "./deal-ops";
import {
  getFulfillmentChecklist,
  listExistingTrackingAttachments,
  upsertFulfillmentChecklist,
  type HubSpotShippingSync,
} from "./fulfillment";
import type { AttachShippingLabelInput } from "./shipping-label";
import { sendShippedEmailViaResend } from "./resend-shipped-email";
import { recordShippedEmailSent, wasShippedEmailSent } from "./shipped-email-store";

export type LabelStageMove = {
  dealId: string;
  ok: boolean;
  dryRun?: boolean;
  stageId?: string;
  stageLabel?: string;
  error?: string;
  skipped?: boolean;
};

export type BuyerEmailSend = {
  attempted: boolean;
  sent: boolean;
  skipped: boolean;
  to: string | null;
  id: string | null;
  reason: string | null;
  error: string | null;
};

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
      stageMoves: LabelStageMove[];
      contact: { id: string | null; name: string; email: string };
      alreadyAttached: {
        dealId: string;
        trackingNumber: string;
        notes: string;
        source: "local" | "hubspot";
        updatedAt: string | null;
      };
      marketplaceSend: null;
      buyerEmail: BuyerEmailSend | null;
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
      stageMoves: LabelStageMove[];
      contact: { id: string | null; name: string; email: string };
      marketplaceSend: {
        queued: boolean;
        id: number;
        to: string;
        channel: "marketplace" | "offerup";
      } | null;
      buyerEmail: BuyerEmailSend | null;
    }
  | { ok: false; error: string; attachedDealIds: string[]; failedDealId: string };

function carrierFromNotes(notes: string): { service: string | null; carrier: string | null } {
  const text = notes.trim();
  if (!text) return { service: null, carrier: null };
  const ups = /\bUPS\b/i.test(text) ? "UPS" : null;
  const usps = /\bUSPS\b/i.test(text) ? "USPS" : null;
  const fedex = /\bFedEx\b/i.test(text) ? "FedEx" : null;
  const carrier = ups || usps || fedex;
  const serviceMatch = text.match(
    /\b(UPS\s+Ground|USPS\s+Ground\s+Advantage|USPS\s+Priority(?:\s+Mail)?|FedEx\s+Ground|FedEx\s+Home(?:\s+Delivery)?)\b/i,
  );
  return { service: serviceMatch?.[1] ?? null, carrier };
}

async function maybeSendBuyerShippedEmail(input: {
  dealId: string;
  dealName?: string | null;
  trackingNumber: string;
  notes: string;
  contactName: string;
  contactEmail: string;
}): Promise<BuyerEmailSend> {
  const email = input.contactEmail.trim();
  if (!email.includes("@")) {
    return {
      attempted: false,
      sent: false,
      skipped: true,
      to: null,
      id: null,
      reason: "No buyer email on HubSpot contact",
      error: null,
    };
  }
  if (wasShippedEmailSent(input.dealId, input.trackingNumber)) {
    return {
      attempted: false,
      sent: false,
      skipped: true,
      to: email,
      id: null,
      reason: "Shipped email already sent for this tracking",
      error: null,
    };
  }
  const { service, carrier } = carrierFromNotes(input.notes);
  const result = await sendShippedEmailViaResend({
    to: email,
    contactName: input.contactName,
    dealName: input.dealName,
    trackingNumber: input.trackingNumber,
    service,
    carrier,
  });
  if (result.ok && result.skipped) {
    return {
      attempted: false,
      sent: false,
      skipped: true,
      to: email,
      id: null,
      reason: result.reason,
      error: null,
    };
  }
  if (!result.ok) {
    return {
      attempted: true,
      sent: false,
      skipped: false,
      to: email,
      id: null,
      reason: null,
      error: result.error,
    };
  }
  recordShippedEmailSent({
    dealId: input.dealId,
    trackingNumber: input.trackingNumber,
    email,
    resendId: result.id,
  });
  return {
    attempted: true,
    sent: true,
    skipped: false,
    to: email,
    id: result.id,
    reason: null,
    error: null,
  };
}

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
      stageMoves: [],
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
      buyerEmail: null,
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

  const stageMoves: LabelStageMove[] = [];
  if (input.markComplete !== false && attachedDealIds.length > 0) {
    const completed = await resolveCompletedPrintOrderStage();
    if (!completed) {
      for (const dealId of attachedDealIds) {
        stageMoves.push({
          dealId,
          ok: false,
          error: "No Completed / Closed Won stage found on the Print Orders pipeline.",
        });
      }
    } else {
      for (const dealId of attachedDealIds) {
        const moved = await advanceDealStage(dealId, {
          stageId: completed.id,
          liveWrite: input.liveWrite !== false,
        });
        if (moved.ok) {
          stageMoves.push({
            dealId,
            ok: true,
            dryRun: moved.dryRun,
            stageId: moved.stageId,
            stageLabel: moved.stageLabel,
          });
        } else {
          stageMoves.push({
            dealId,
            ok: false,
            error: moved.error,
          });
        }
      }
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

  const buyerEmail = await maybeSendBuyerShippedEmail({
    dealId: primaryDealId,
    dealName: null,
    trackingNumber: input.trackingNumber,
    notes: sharedNote,
    contactName: contact.name,
    contactEmail: contact.email,
  });

  return {
    ok: true,
    attachedDealIds,
    skippedDealIds: alreadyOnSelected.map((row) => row.dealId),
    checklist: primaryChecklist!,
    hubspot: primaryHubspot,
    costs: costs && costs.ok ? costs.costs : null,
    costsError: costs && !costs.ok ? costs.error : null,
    stageMoves,
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
    buyerEmail,
  };
}
