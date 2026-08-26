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
  /** When several Print Orders share one box / tracking. */
  dealNames?: string[] | null;
  trackingNumber: string;
  service?: string | null;
  carrier?: string | null;
}): string {
  const names = (input.dealNames ?? [])
    .map((name) => String(name ?? "").trim())
    .filter(Boolean);
  const primaryDeal = names[0] || input.dealName || null;
  const who =
    firstNameFrom(input.contactName) !== "there"
      ? firstNameFrom(input.contactName)
      : firstNameFrom(
          primaryDeal && primaryDeal.includes(" - ")
            ? primaryDeal.slice(primaryDeal.lastIndexOf(" - ") + 3)
            : null,
        );
  const serviceBit = input.service || input.carrier || null;
  const greeting =
    names.length > 1
      ? `Hey ${who} — your print orders shipped together (${names.length} items)!`
      : `Hey ${who} — your print order shipped!`;
  const lines = [
    greeting,
    "",
    serviceBit ? `Tracking (${serviceBit}): ${input.trackingNumber}` : `Tracking: ${input.trackingNumber}`,
  ];
  if (names.length > 1) {
    lines.push("", `Includes: ${names.join("; ")}`);
  }
  lines.push("", "Reply here if you need anything.");
  return lines.join("\n");
}

export function buyerTrackingEmailSubject(dealName?: string | null, orderCount = 1): string {
  const cleaned = String(dealName ?? "").trim();
  if (orderCount > 1) {
    if (cleaned) return `Your orders shipped — ${cleaned.slice(0, 60)} (+${orderCount - 1} more)`;
    return `Your ${orderCount} print orders shipped`;
  }
  if (cleaned) return `Your order shipped — ${cleaned.slice(0, 80)}`;
  return "Your print order shipped";
}

/** Opens the owner's mail app with HubSpot contact email + draft body. */
export function buyerTrackingMailtoHref(input: {
  email: string;
  subject: string;
  body: string;
}): string | null {
  const email = input.email.trim();
  if (!email.includes("@")) return null;
  const params = new URLSearchParams({
    subject: input.subject,
    body: input.body,
  });
  return `mailto:${encodeURIComponent(email)}?${params.toString()}`;
}
