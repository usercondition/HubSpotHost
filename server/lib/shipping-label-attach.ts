/**
 * Shared label → checklist + HubSpot writeback used by PDF attach and ShipEngine buy.
 */
import type { DealCostFields } from "../../shared/schema";
import {
  advanceDealStage,
  fetchDealAssociatedContact,
  resolveCompletedPrintOrderStage,
  seedPrintDealCosts,
  updateDealCosts,
  type DealAssociatedContact,
} from "./deal-ops";
import { wasShippedEmailSent } from "./shipped-email-store";
import {
  getFulfillmentChecklist,
  listExistingTrackingAttachments,
  upsertFulfillmentChecklist,
  type HubSpotShippingSync,
} from "./fulfillment";
import type { AttachShippingLabelInput } from "./shipping-label";
import {
  enqueueMarketplaceShipNoteJob,
  enqueueShipmentEmailJob,
} from "./print-ops-jobs";
import { markStackDone } from "./priority-stack";
import { loadProductionQueue } from "./queue-loader";
import type { BuyerEmailSend, ShipmentEmailJob } from "./shipment-notification-jobs";
import type { ProductionQueueItem } from "../../shared/schema";

export type LabelStageMove = {
  dealId: string;
  ok: boolean;
  dryRun?: boolean;
  stageId?: string;
  stageLabel?: string;
  error?: string;
  skipped?: boolean;
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
      marketplaceSend: {
        queued: boolean;
        id: number;
        to: string;
        channel: "marketplace" | "offerup";
      } | null;
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

function normalizeTracking(value: string | null | undefined): string {
  return (value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

const EMPTY_LABEL_CONTACT: DealAssociatedContact = {
  id: null,
  name: "",
  email: "",
  phone: "",
  addressLines: [],
  street1: "",
  street2: "",
  city: "",
  state: "",
  zip: "",
  country: "",
};

/** After a label is stored, a contact read must not fail the attach. */
async function readContactForLabel(dealId: string): Promise<DealAssociatedContact> {
  try {
    return await fetchDealAssociatedContact(dealId, { fresh: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "contact read failed";
    console.warn(`[shipment] contact read failed for deal ${dealId} after label attach: ${message}`);
    return { ...EMPTY_LABEL_CONTACT };
  }
}

const ALREADY_SENT: BuyerEmailSend = {
  attempted: false,
  sent: false,
  skipped: true,
  to: null,
  id: null,
  reason: "Shipped email already sent for this tracking",
  error: null,
};

const REPRINT_KEPT: BuyerEmailSend = {
  attempted: false,
  sent: false,
  skipped: true,
  to: null,
  id: null,
  reason: "Reprint keeps the first completion",
  error: null,
};

async function enqueueShippedEmail(input: ShipmentEmailJob): Promise<BuyerEmailSend> {
  if (wasShippedEmailSent(input.dealId, input.trackingNumber)) return ALREADY_SENT;
  try {
    const dispatched = await enqueueShipmentEmailJob(input);
    return (
      dispatched.result ?? {
        attempted: false,
        sent: false,
        skipped: false,
        to: null,
        id: null,
        reason: "Shipped email queued",
        error: null,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send the shipped email";
    console.warn(`[shipment] shipped email for deal ${input.dealId} will retry: ${message}`);
    return {
      attempted: false,
      sent: false,
      skipped: false,
      to: null,
      id: null,
      reason: message,
      error: message,
    };
  }
}

async function enqueueMarketplaceNote(input: {
  dealId: string;
  trackingNumber: string;
  channel: "marketplace" | "offerup";
  contactName: string;
}): Promise<{
  queued: boolean;
  id: number;
  to: string;
  channel: "marketplace" | "offerup";
} | null> {
  try {
    const dispatched = await enqueueMarketplaceShipNoteJob({
      dealId: input.dealId,
      trackingNumber: input.trackingNumber,
      to: input.contactName,
      text: `Your order has shipped. Tracking: ${input.trackingNumber}.`,
      channel: input.channel,
    });
    const result = dispatched.result;
    if (dispatched.queued && !result) {
      return { queued: true, id: 0, to: input.contactName, channel: input.channel };
    }
    if (!result || !("request" in result)) return null;
    const request = result.request;
    if (!request.to) return null;
    return {
      queued: result.queued,
      id: request.id,
      to: request.to,
      channel: input.channel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not queue the marketplace note";
    console.warn(`[shipment] marketplace note for deal ${input.dealId} will retry: ${message}`);
    return null;
  }
}

export async function attachShippingLabelToDeals(
  input: AttachShippingLabelInput & {
    shipengine?: { labelId?: string; carrier?: string; service?: string };
  },
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
    const contact = await readContactForLabel(primary.dealId);
    const buyerEmail = await enqueueShippedEmail({
      dealId: primary.dealId,
      trackingNumber: input.trackingNumber,
      notes: primary.notes || sharedNote,
    });
    const marketplaceSend = await enqueueMarketplaceNote({
      dealId: primary.dealId,
      trackingNumber: input.trackingNumber,
      channel: input.messageChannel,
      contactName: contact.name,
    });
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
      marketplaceSend,
      buyerEmail,
    };
  }

  const attachedDealIds: string[] = [];
  const reprintDealIds = new Set<string>();
  let primaryChecklist: ReturnType<typeof getFulfillmentChecklist> | null = null;
  let primaryHubspot: HubSpotShippingSync | null = null;
  let costs: Awaited<ReturnType<typeof updateDealCosts>> | null = null;
  const postage = input.postageUsd.replace(/[$,\s]/g, "").trim();
  let queueItems: ProductionQueueItem[] = [];
  try {
    const queue = await loadProductionQueue({ enrichAddresses: false, refreshStages: false });
    queueItems = [...queue.nextPrint, ...queue.inProduction, ...queue.blocked, ...queue.shipReady];
  } catch {
    queueItems = [];
  }

  for (let index = 0; index < toAttach.length; index += 1) {
    const dealId = toAttach[index]!;
    const previous = getFulfillmentChecklist(dealId);
    const previousTracking = normalizeTracking(previous.trackingNumber);
    const nextTracking = normalizeTracking(input.trackingNumber);
    if (previousTracking && previousTracking !== nextTracking) reprintDealIds.add(dealId);
    const fulfillment = await upsertFulfillmentChecklist(dealId, {
      trackingNumber: input.trackingNumber,
      trackingPasted: true,
      labelBought: input.labelBought,
      packingDone: input.packingDone,
      costsEntered: postage !== "" ? true : undefined,
      notes: sharedNote,
      liveWrite: input.liveWrite !== false,
      shipengineLabelId: input.shipengine?.labelId,
      shipengineCarrier: input.shipengine?.carrier,
      shipengineService: input.shipengine?.service,
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
    markStackDone(`deal:${dealId}`, queueItems);
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

  const notifyDealId = attachedDealIds.find((dealId) => !reprintDealIds.has(dealId)) ?? null;
  const primaryDealId = notifyDealId ?? attachedDealIds[0]!;
  const contact = await readContactForLabel(primaryDealId);
  const buyerEmail = notifyDealId
    ? await enqueueShippedEmail({
        dealId: notifyDealId,
        trackingNumber: input.trackingNumber,
        notes: sharedNote,
      })
    : REPRINT_KEPT;
  const marketplaceSend = notifyDealId
    ? await enqueueMarketplaceNote({
        dealId: notifyDealId,
        trackingNumber: input.trackingNumber,
        channel: input.messageChannel,
        contactName: contact.name,
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
    stageMoves,
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
    },
    marketplaceSend,
    buyerEmail,
  };
}
