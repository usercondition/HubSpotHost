/**
 * A Stack deep link may open the drawer only when that deal is on the Stack
 * (open rows, bundle members, or Out the door). Anything else, including a
 * closed deal left in a bookmark, opens nothing.
 */
export type StackDealLinkRow = {
  dealId: string | null;
  members?: readonly StackDealLinkRow[];
};

function collectDealIds(rows: readonly StackDealLinkRow[], into: Set<string>) {
  for (const row of rows) {
    if (row.dealId) into.add(row.dealId);
    if (row.members?.length) collectDealIds(row.members, into);
  }
}

export function stackDrawerDealId(
  dealId: string | null,
  stack: { rows: readonly StackDealLinkRow[]; outTheDoor?: readonly StackDealLinkRow[] },
): string | null {
  if (!dealId) return null;
  const ids = new Set<string>();
  collectDealIds(stack.rows, ids);
  if (stack.outTheDoor?.length) collectDealIds(stack.outTheDoor, ids);
  return ids.has(dealId) ? dealId : null;
}
