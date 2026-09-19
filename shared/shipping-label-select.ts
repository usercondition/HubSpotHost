/**
 * Default multi-select for Labels: same client → same box / same tracking.
 * Used when Pirate Ship ships multiple Print Orders together (e.g. Land Raider + panels).
 */
import { normalizePersonName, samePersonName } from "./person-name";

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
 * Auto-select every match that shares the top candidate's client (OCR-tolerant).
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
  return matches
    .filter((row) => {
      const rowKey = labelMatchContactKey(row);
      if (!rowKey) return row.dealId === top.dealId;
      return samePersonName(key, rowKey, 70);
    })
    .map((row) => row.dealId);
}
