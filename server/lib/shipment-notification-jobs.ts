/**
 * Slow shipment side effects run by the Print Ops job worker.
 * HubSpot remains the source for the contact used at execution time.
 */
import { fetchDealAssociatedContact } from "./deal-ops";
import { enqueueMarketplaceShipmentSendRequest } from "./marketplace-send-request-store";
import { sendShippedEmailViaResend } from "./resend-shipped-email";
import { recordShippedEmailSent, wasShippedEmailSent } from "./shipped-email-store";

export type BuyerEmailSend = {
  attempted: boolean;
  sent: boolean;
  skipped: boolean;
  to: string | null;
  id: string | null;
  reason: string | null;
  error: string | null;
};

export type ShipmentEmailJob = {
  dealId: string;
  trackingNumber: string;
  notes: string;
};

export type MarketplaceShipNoteJob = {
  dealId: string;
  trackingNumber: string;
  to: string;
  text: string;
  channel: "marketplace" | "offerup";
};

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

/** Send once per deal/tracking, resolving the current contact from HubSpot. */
export async function runShipmentEmailJob(input: ShipmentEmailJob): Promise<BuyerEmailSend> {
  const contact = await fetchDealAssociatedContact(input.dealId);
  const email = contact.email.trim();
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
    contactName: contact.name,
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
    throw new Error(result.error);
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

/** Arm the existing Marketplace/OfferUp extension handoff from a worker. */
export function runMarketplaceShipNoteJob(input: MarketplaceShipNoteJob) {
  return enqueueMarketplaceShipmentSendRequest(input);
}
