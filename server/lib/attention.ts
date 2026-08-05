import { and, eq } from "drizzle-orm";
import {
  attentionIssueKeyFromIssue,
  attentionOverrides,
  type AttentionIssueKey,
  type AttentionOverride,
  type DismissAttentionInput,
} from "../../shared/schema";
import { getDb } from "./order-links";

export { attentionIssueKeyFromIssue };

export function listAttentionOverrides(): AttentionOverride[] {
  return getDb().select().from(attentionOverrides).all();
}

export function activeAttentionOverrideKeys(now = new Date()): Set<string> {
  void now;
  const keys = new Set<string>();
  for (const row of listAttentionOverrides()) {
    keys.add(`${row.hubspotDealId}:${row.issueKey}`);
  }
  return keys;
}

export function dismissAttentionAlert(input: DismissAttentionInput): AttentionOverride {
  const existing = getDb()
    .select()
    .from(attentionOverrides)
    .where(
      and(
        eq(attentionOverrides.hubspotDealId, input.dealId),
        eq(attentionOverrides.issueKey, input.issueKey),
      ),
    )
    .get();

  if (existing) {
    return getDb()
      .update(attentionOverrides)
      .set({
        note: input.note ?? "",
        createdAt: new Date().toISOString(),
      })
      .where(eq(attentionOverrides.id, existing.id))
      .returning()
      .get();
  }

  return getDb()
    .insert(attentionOverrides)
    .values({
      hubspotDealId: input.dealId,
      issueKey: input.issueKey,
      note: input.note ?? "",
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function clearAttentionOverride(dealId: string, issueKey: AttentionIssueKey): boolean {
  const result = getDb()
    .delete(attentionOverrides)
    .where(
      and(eq(attentionOverrides.hubspotDealId, dealId), eq(attentionOverrides.issueKey, issueKey)),
    )
    .run();
  return (result.changes ?? 0) > 0;
}

export function overrideKey(dealId: string, issueKey: string): string {
  return `${dealId}:${issueKey}`;
}
