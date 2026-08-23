/**
 * Buyer-facing tracking draft text (Marketplace / DM).
 * Print Ops does not auto-send — owner copies and pastes.
 */

function firstNameFrom(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "there";
  const first = cleaned.split(/\s+/)[0] ?? "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function draftBuyerTrackingMessage(input: {
  contactName?: string | null;
  dealName?: string | null;
  trackingNumber: string;
  service?: string | null;
  carrier?: string | null;
}): string {
  const who =
    firstNameFrom(input.contactName) !== "there"
      ? firstNameFrom(input.contactName)
      : firstNameFrom(
          input.dealName && input.dealName.includes(" - ")
            ? input.dealName.slice(input.dealName.lastIndexOf(" - ") + 3)
            : null,
        );
  const serviceBit = input.service || input.carrier || null;
  return [
    `Hey ${who} — your print order shipped!`,
    "",
    serviceBit ? `Tracking (${serviceBit}): ${input.trackingNumber}` : `Tracking: ${input.trackingNumber}`,
    "",
    "Reply here if you need anything.",
  ].join("\n");
}
