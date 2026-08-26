/**
 * Default multi-select for Labels: same client → same box / same tracking.
 * Used when Pirate Ship ships multiple Print Orders together (e.g. Land Raider + panels).
 */

function normalizePersonName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer HubSpot contact; fall back to "Item - Client" deal title suffix. */
export function labelMatchContactKey(match: {
  contactName: string | null;
  dealName: string;
}): string {
  const fromContact = String(match.contactName ?? "").trim();
  if (fromContact) return normalizePersonName(fromContact);
  const separator = " - ";
  const index = match.dealName.lastIndexOf(separator);
  if (index < 0) return "";
  return normalizePersonName(match.dealName.slice(index + separator.length));
}

/**
 * Auto-select every match that shares the top candidate's client.
 * Single unmatched / different-client rows stay unselected.
 */
export function defaultLabelMatchDealIds(
  matches: Array<{
    dealId: string;
    contactName: string | null;
    dealName: string;
    score: number;
  }>,
): string[] {
  if (matches.length === 0) return [];
  const top = matches[0]!;
  const key = labelMatchContactKey(top);
  if (!key) return [top.dealId];
  return matches.filter((row) => labelMatchContactKey(row) === key).map((row) => row.dealId);
}
