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
 * Auto-select matches that share the top candidate's client.
 * When scores diverge widely (shared box unlikely / OCR mismatch), only keep
 * the top match so the UI can confirm before attaching to weaker rows.
 */
export function defaultLabelMatchDealIds(
  matches: Array<{
    dealId: string;
    contactName: string | null;
    dealName: string;
    score: number;
  }>,
  options?: { scoreSpreadThreshold?: number },
): string[] {
  if (matches.length === 0) return [];
  const top = matches[0]!;
  const key = labelMatchContactKey(top);
  if (!key) return [top.dealId];
  const sameClient = matches.filter((row) => labelMatchContactKey(row) === key);
  if (sameClient.length <= 1) return [top.dealId];

  const threshold = options?.scoreSpreadThreshold ?? 30;
  const spread = top.score - Math.min(...sameClient.map((row) => row.score));
  if (spread >= threshold) {
    // Divergent confidence — prefer primary ship-to only; UI prompts to add others.
    return [top.dealId];
  }
  return sameClient.map((row) => row.dealId);
}

/** True when same-client matches exist but scores diverge enough to need confirmation. */
export function labelMatchNeedsSharedBoxConfirm(
  matches: Array<{
    dealId: string;
    contactName: string | null;
    dealName: string;
    score: number;
  }>,
  selectedDealIds: string[],
  options?: { scoreSpreadThreshold?: number },
): { needed: boolean; primary: (typeof matches)[number] | null; others: typeof matches } {
  if (matches.length === 0 || selectedDealIds.length === 0) {
    return { needed: false, primary: null, others: [] };
  }
  const selected = matches.filter((row) => selectedDealIds.includes(row.dealId));
  if (selected.length <= 1) return { needed: false, primary: selected[0] ?? null, others: [] };
  const sorted = [...selected].sort((a, b) => b.score - a.score);
  const primary = sorted[0]!;
  const others = sorted.slice(1);
  const threshold = options?.scoreSpreadThreshold ?? 30;
  const spread = primary.score - Math.min(...selected.map((row) => row.score));
  return {
    needed: spread >= threshold,
    primary,
    others,
  };
}
