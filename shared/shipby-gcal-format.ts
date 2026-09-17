/**
 * Pure formatting for Print Ops → Google Calendar ship-by events.
 * Keep titles stable so Intern digests and Calendar stay readable.
 */

export type ShipByCalendarDeal = {
  dealId: string;
  dealName: string;
  contactName?: string | null;
  amount?: number | null;
  stage?: string | null;
  shipBy: string;
  shipBySource: "override" | "derived";
};

function money(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "";
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** Title: Ship · {dealName} — {contactName} (${amount}) */
export function formatShipByCalendarTitle(deal: ShipByCalendarDeal): string {
  const name = String(deal.dealName ?? "").trim() || `Deal ${deal.dealId}`;
  const contact = String(deal.contactName ?? "").trim();
  const cash = money(deal.amount);
  let title = `Ship · ${name}`;
  if (contact) title += ` — ${contact}`;
  if (cash) title += ` (${cash})`;
  return title.slice(0, 250);
}

export function formatShipByCalendarDescription(
  deal: ShipByCalendarDeal,
  options?: { publicBaseUrl?: string | null; hubspotDealUrl?: string | null },
): string {
  const base = (options?.publicBaseUrl || "").trim().replace(/\/+$/, "");
  const opsLink = base ? `${base}/#/queue?dealId=${encodeURIComponent(deal.dealId)}` : "";
  const lines = [
    `Print Ops ship-by honesty hold`,
    `dealId: ${deal.dealId}`,
    deal.stage ? `stage: ${deal.stage}` : "",
    `shipBy: ${deal.shipBy}`,
    `shipBySource: ${deal.shipBySource}`,
    opsLink ? `Print Ops: ${opsLink}` : "",
    options?.hubspotDealUrl ? `HubSpot: ${options.hubspotDealUrl}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Google all-day events use an exclusive end date (next calendar day). */
export function shipByAllDayEndDate(shipBy: string): string {
  const value = new Date(`${shipBy}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
