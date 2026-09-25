/**
 * Local Priority Stack state. Blockers, rank, bundles, and off-book orders
 * live in SQLite. Deal target dates stay in HubSpot print_ship_by.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  laneForBucket,
  parseStackAmount,
  rankPriorityStack,
  readinessRank,
  roundMoney,
  shopWeekEnd,
  shopWeekStart,
  stackTier,
  stackTotals,
  suggestedBlocker,
  type StackLane,
  type StackTier,
} from "../../shared/priority-stack";
import { addShipByCalendarDays, shipByCalendarDate } from "../../shared/ship-by";
import {
  priorityStackBundles,
  priorityStackEntries,
  type FulfillmentChecklistView,
  type PriorityStackBundleRow,
  type PriorityStackEntryRow,
  type ProductionQueueItem,
  type ProductionQueueResponse,
} from "../../shared/schema";
import { getDb } from "./order-links";

export interface StackStep {
  label: string;
  done: boolean;
}

export interface PriorityStackRow {
  key: string;
  kind: "deal" | "offbook" | "bundle";
  rank: number;
  manual: boolean;
  isNew: boolean;
  name: string;
  contactName: string | null;
  stage: string;
  bucket: string;
  lane: StackLane;
  blocker: string;
  blockerSource: "manual" | "auto";
  nextStep: string;
  targetDate: string;
  targetSource: "override" | "derived" | "local" | "unset";
  tentative: boolean;
  amount: number | null;
  tier: StackTier;
  shippingRequired: boolean;
  dealId: string | null;
  offbookId: number | null;
  bundleId: number | null;
  fulfillment: FulfillmentChecklistView | null;
  steps: StackStep[];
  members: PriorityStackRow[];
  item: ProductionQueueItem | null;
  doneAt: string | null;
  doneAmount: number | null;
}

export interface PriorityStackView {
  ok: true;
  generatedAt: string;
  today: string;
  weekEnd: string;
  rows: PriorityStackRow[];
  outTheDoor: PriorityStackRow[];
  totals: ReturnType<typeof stackTotals>;
  hiddenCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSteps(raw: string): StackStep[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((step) => {
      if (!step || typeof step !== "object") return [];
      const row = step as { label?: unknown; done?: unknown };
      const label = typeof row.label === "string" ? row.label.trim() : "";
      if (!label) return [];
      return [{ label, done: row.done === true }];
    });
  } catch {
    return [];
  }
}

function entryByDeal(entries: PriorityStackEntryRow[]): Map<string, PriorityStackEntryRow> {
  const map = new Map<string, PriorityStackEntryRow>();
  for (const entry of entries) {
    if (entry.kind === "deal" && entry.hubspotDealId) map.set(entry.hubspotDealId, entry);
  }
  return map;
}

export function listStackState(): { entries: PriorityStackEntryRow[]; bundles: PriorityStackBundleRow[] } {
  const database = getDb();
  return {
    entries: database.select().from(priorityStackEntries).all(),
    bundles: database.select().from(priorityStackBundles).all(),
  };
}

export function upsertDealStackEntry(
  dealId: string,
  patch: {
    blocker?: string;
    nextStep?: string;
    tier?: StackTier | null;
    tentative?: boolean;
    hidden?: boolean;
    bundleId?: number | null;
    manualRank?: number | null;
  },
): PriorityStackEntryRow {
  const database = getDb();
  const existing = database
    .select()
    .from(priorityStackEntries)
    .where(eq(priorityStackEntries.hubspotDealId, dealId))
    .get();
  const stamp = nowIso();
  if (!existing) {
    database
      .insert(priorityStackEntries)
      .values({
        kind: "deal",
        hubspotDealId: dealId,
        bundleId: patch.bundleId ?? null,
        manualRank: patch.manualRank ?? null,
        blocker: patch.blocker ?? "",
        nextStep: patch.nextStep ?? "",
        tierOverride: patch.tier === undefined ? null : patch.tier,
        tentative: patch.tentative ?? false,
        hidden: patch.hidden ?? false,
        title: "",
        contactName: "",
        amount: "",
        targetDate: null,
        fulfillmentMode: "ship",
        stepsJson: "[]",
        doneAt: null,
        doneAmount: "",
        doneName: "",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
  } else {
    database
      .update(priorityStackEntries)
      .set({
        blocker: patch.blocker ?? existing.blocker,
        nextStep: patch.nextStep ?? existing.nextStep,
        tierOverride: patch.tier === undefined ? existing.tierOverride : patch.tier,
        tentative: patch.tentative ?? existing.tentative,
        hidden: patch.hidden ?? existing.hidden,
        bundleId: patch.bundleId === undefined ? existing.bundleId : patch.bundleId,
        manualRank: patch.manualRank === undefined ? existing.manualRank : patch.manualRank,
        updatedAt: stamp,
      })
      .where(eq(priorityStackEntries.id, existing.id))
      .run();
  }
  return database.select().from(priorityStackEntries).where(eq(priorityStackEntries.hubspotDealId, dealId)).get()!;
}

export function setStackOrder(keys: string[]): void {
  const database = getDb();
  const stamp = nowIso();
  database.transaction((tx) => {
    tx.update(priorityStackEntries).set({ manualRank: null, updatedAt: stamp }).run();
    tx.update(priorityStackBundles).set({ manualRank: null, updatedAt: stamp }).run();
    keys.forEach((key, index) => {
      const rank = index + 1;
      if (key.startsWith("deal:")) {
        const dealId = key.slice(5);
        const existing = tx.select().from(priorityStackEntries).where(eq(priorityStackEntries.hubspotDealId, dealId)).get();
        if (!existing) {
          tx.insert(priorityStackEntries)
            .values({
              kind: "deal",
              hubspotDealId: dealId,
              manualRank: rank,
              blocker: "",
              nextStep: "",
              title: "",
              contactName: "",
              amount: "",
              fulfillmentMode: "ship",
              stepsJson: "[]",
              doneAmount: "",
              doneName: "",
              createdAt: stamp,
              updatedAt: stamp,
            })
            .run();
        } else if (!existing.bundleId) {
          tx.update(priorityStackEntries)
            .set({ manualRank: rank, updatedAt: stamp })
            .where(eq(priorityStackEntries.id, existing.id))
            .run();
        }
      } else if (key.startsWith("offbook:")) {
        const id = Number(key.slice(8));
        tx.update(priorityStackEntries)
          .set({ manualRank: rank, updatedAt: stamp })
          .where(and(eq(priorityStackEntries.id, id), eq(priorityStackEntries.kind, "offbook")))
          .run();
      } else if (key.startsWith("bundle:")) {
        const id = Number(key.slice(7));
        tx.update(priorityStackBundles)
          .set({ manualRank: rank, updatedAt: stamp })
          .where(eq(priorityStackBundles.id, id))
          .run();
      }
    });
  });
}

export function resetStackOrder(): void {
  const stamp = nowIso();
  const database = getDb();
  database.update(priorityStackEntries).set({ manualRank: null, updatedAt: stamp }).run();
  database.update(priorityStackBundles).set({ manualRank: null, updatedAt: stamp }).run();
}

export function createBundle(input: { label: string; mode: "pickup" | "ship"; dealIds: string[] }): PriorityStackBundleRow {
  const database = getDb();
  const stamp = nowIso();
  const created = database
    .insert(priorityStackBundles)
    .values({
      label: input.label,
      fulfillmentMode: input.mode,
      blocker: "",
      nextStep: "",
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
  for (const dealId of input.dealIds) {
    upsertDealStackEntry(dealId, { bundleId: created.id, manualRank: null });
  }
  return created;
}

export function updateBundle(
  id: number,
  patch: {
    label?: string;
    mode?: "pickup" | "ship";
    blocker?: string;
    nextStep?: string;
    tier?: StackTier | null;
    addDealIds?: string[];
    removeDealIds?: string[];
  },
): PriorityStackBundleRow | null {
  const database = getDb();
  const existing = database.select().from(priorityStackBundles).where(eq(priorityStackBundles.id, id)).get();
  if (!existing) return null;
  database
    .update(priorityStackBundles)
    .set({
      label: patch.label ?? existing.label,
      fulfillmentMode: patch.mode ?? existing.fulfillmentMode,
      blocker: patch.blocker ?? existing.blocker,
      nextStep: patch.nextStep ?? existing.nextStep,
      tierOverride: patch.tier === undefined ? existing.tierOverride : patch.tier,
      updatedAt: nowIso(),
    })
    .where(eq(priorityStackBundles.id, id))
    .run();
  for (const dealId of patch.removeDealIds ?? []) {
    const entry = database.select().from(priorityStackEntries).where(eq(priorityStackEntries.hubspotDealId, dealId)).get();
    if (entry?.bundleId === id) upsertDealStackEntry(dealId, { bundleId: null });
  }
  for (const dealId of patch.addDealIds ?? []) upsertDealStackEntry(dealId, { bundleId: id, manualRank: null });
  return database.select().from(priorityStackBundles).where(eq(priorityStackBundles.id, id)).get() ?? null;
}

export function deleteBundle(id: number): boolean {
  const database = getDb();
  const existing = database.select().from(priorityStackBundles).where(eq(priorityStackBundles.id, id)).get();
  if (!existing) return false;
  database
    .update(priorityStackEntries)
    .set({ bundleId: null, updatedAt: nowIso() })
    .where(eq(priorityStackEntries.bundleId, id))
    .run();
  database.delete(priorityStackBundles).where(eq(priorityStackBundles.id, id)).run();
  return true;
}

export function createOffbook(input: {
  title: string;
  contactName?: string;
  mode?: "pickup" | "ship";
  targetDate?: string | null;
  amount?: string;
  blocker?: string;
  nextStep?: string;
  tentative?: boolean;
  steps?: StackStep[];
}): PriorityStackEntryRow {
  const database = getDb();
  const stamp = nowIso();
  return database
    .insert(priorityStackEntries)
    .values({
      kind: "offbook",
      hubspotDealId: null,
      title: input.title,
      contactName: input.contactName ?? "",
      fulfillmentMode: input.mode ?? "pickup",
      targetDate: input.targetDate ?? null,
      amount: input.amount ?? "",
      blocker: input.blocker ?? "",
      nextStep: input.nextStep ?? "",
      tentative: input.tentative ?? false,
      stepsJson: JSON.stringify(input.steps ?? []),
      doneAmount: "",
      doneName: "",
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
}

export function updateOffbook(
  id: number,
  patch: Partial<{
    title: string;
    contactName: string;
    mode: "pickup" | "ship";
    targetDate: string | null;
    amount: string;
    blocker: string;
    nextStep: string;
    tentative: boolean;
    hidden: boolean;
    steps: StackStep[];
  }>,
): PriorityStackEntryRow | null {
  const database = getDb();
  const existing = database
    .select()
    .from(priorityStackEntries)
    .where(and(eq(priorityStackEntries.id, id), eq(priorityStackEntries.kind, "offbook")))
    .get();
  if (!existing) return null;
  database
    .update(priorityStackEntries)
    .set({
      title: patch.title ?? existing.title,
      contactName: patch.contactName ?? existing.contactName,
      fulfillmentMode: patch.mode ?? existing.fulfillmentMode,
      targetDate: patch.targetDate === undefined ? existing.targetDate : patch.targetDate,
      amount: patch.amount ?? existing.amount,
      blocker: patch.blocker ?? existing.blocker,
      nextStep: patch.nextStep ?? existing.nextStep,
      tentative: patch.tentative ?? existing.tentative,
      hidden: patch.hidden ?? existing.hidden,
      stepsJson: patch.steps ? JSON.stringify(patch.steps) : existing.stepsJson,
      updatedAt: nowIso(),
    })
    .where(eq(priorityStackEntries.id, id))
    .run();
  return database.select().from(priorityStackEntries).where(eq(priorityStackEntries.id, id)).get() ?? null;
}

export function deleteOffbook(id: number): boolean {
  const database = getDb();
  const existing = database
    .select()
    .from(priorityStackEntries)
    .where(and(eq(priorityStackEntries.id, id), eq(priorityStackEntries.kind, "offbook")))
    .get();
  if (!existing) return false;
  database.delete(priorityStackEntries).where(eq(priorityStackEntries.id, id)).run();
  return true;
}

export function markStackDone(key: string, queue: ProductionQueueItem[], now = new Date()): boolean {
  const database = getDb();
  const stamp = now.toISOString();
  if (key.startsWith("deal:")) {
    const dealId = key.slice(5);
    const item = queue.find((row) => row.dealId === dealId);
    const entry = upsertDealStackEntry(dealId, {});
    database
      .update(priorityStackEntries)
      .set({
        doneAt: stamp,
        doneAmount: item ? String(item.amount) : entry.doneAmount,
        doneName: item?.dealName ?? entry.doneName,
        updatedAt: stamp,
      })
      .where(eq(priorityStackEntries.id, entry.id))
      .run();
    return true;
  }
  if (key.startsWith("offbook:")) {
    const id = Number(key.slice(8));
    const existing = database.select().from(priorityStackEntries).where(eq(priorityStackEntries.id, id)).get();
    if (!existing || existing.kind !== "offbook") return false;
    database
      .update(priorityStackEntries)
      .set({
        doneAt: stamp,
        doneAmount: existing.amount,
        doneName: existing.title,
        updatedAt: stamp,
      })
      .where(eq(priorityStackEntries.id, id))
      .run();
    return true;
  }
  if (key.startsWith("bundle:")) {
    const id = Number(key.slice(7));
    const existing = database.select().from(priorityStackBundles).where(eq(priorityStackBundles.id, id)).get();
    if (!existing) return false;
    database.update(priorityStackBundles).set({ doneAt: stamp, updatedAt: stamp }).where(eq(priorityStackBundles.id, id)).run();
    return true;
  }
  return false;
}

export function undoStackDone(key: string): boolean {
  const database = getDb();
  const stamp = nowIso();
  if (key.startsWith("deal:")) {
    const entry = database.select().from(priorityStackEntries).where(eq(priorityStackEntries.hubspotDealId, key.slice(5))).get();
    if (!entry) return false;
    database
      .update(priorityStackEntries)
      .set({ doneAt: null, doneAmount: "", doneName: "", updatedAt: stamp })
      .where(eq(priorityStackEntries.id, entry.id))
      .run();
    return true;
  }
  if (key.startsWith("offbook:")) {
    const id = Number(key.slice(8));
    const existing = database.select().from(priorityStackEntries).where(eq(priorityStackEntries.id, id)).get();
    if (!existing) return false;
    database
      .update(priorityStackEntries)
      .set({ doneAt: null, doneAmount: "", doneName: "", updatedAt: stamp })
      .where(eq(priorityStackEntries.id, id))
      .run();
    return true;
  }
  if (key.startsWith("bundle:")) {
    const id = Number(key.slice(7));
    const existing = database.select().from(priorityStackBundles).where(eq(priorityStackBundles.id, id)).get();
    if (!existing) return false;
    database.update(priorityStackBundles).set({ doneAt: null, updatedAt: stamp }).where(eq(priorityStackBundles.id, id)).run();
    return true;
  }
  return false;
}

export function pruneStackEntries(openDealIds: Set<string>, now = new Date()): number {
  const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const database = getDb();
  const stale = database
    .select()
    .from(priorityStackEntries)
    .where(and(eq(priorityStackEntries.kind, "deal"), isNull(priorityStackEntries.bundleId)))
    .all()
    .filter((entry) => {
      if (!entry.hubspotDealId || openDealIds.has(entry.hubspotDealId)) return false;
      const stamp = entry.doneAt || entry.updatedAt;
      return stamp < cutoff;
    });
  for (const entry of stale) {
    database.delete(priorityStackEntries).where(eq(priorityStackEntries.id, entry.id)).run();
  }
  return stale.length;
}

function dealBlocker(item: ProductionQueueItem, entry: PriorityStackEntryRow | undefined): { text: string; source: "manual" | "auto" } {
  const manual = entry?.blocker?.trim() ?? "";
  if (manual) return { text: manual, source: "manual" };
  return {
    text: suggestedBlocker({
      requiresPlates: item.requiresPlates,
      hasPlates: item.hasPlates,
      kitReprint: item.kitReprint,
      unassignedPlateCount: item.unassignedPlateCount,
      costsIncomplete: item.costsIncomplete,
      addressStatus: item.addressStatus,
      needsReply: item.needsReply,
      isStale: item.isStale,
      shippingRequired: item.shippingRequired,
      shipByReason: item.shipByReason,
      stage: item.stage,
    }),
    source: "auto",
  };
}

function doneThisWeek(doneAt: string | null, now: Date): boolean {
  if (!doneAt) return false;
  const day = shipByCalendarDate(new Date(doneAt));
  return day >= shopWeekStart(now) && day <= shopWeekEnd(now);
}

export function buildPriorityStack(
  queue: ProductionQueueResponse,
  state: { entries: PriorityStackEntryRow[]; bundles: PriorityStackBundleRow[] },
  options: { now?: Date } = {},
): PriorityStackView {
  const now = options.now ?? new Date();
  const today = shipByCalendarDate(now);
  const weekEnd = shopWeekEnd(now);
  const items = [...queue.nextPrint, ...queue.inProduction, ...queue.blocked, ...queue.shipReady];
  const deals = entryByDeal(state.entries);
  const openIds = new Set(items.map((item) => item.dealId));
  let hiddenCount = 0;

  const memberRows = new Map<number, PriorityStackRow[]>();
  const loose: Array<PriorityStackRow & { manualRank: number | null; readiness: number; priorityScore: number }> = [];

  for (const item of items) {
    const entry = deals.get(item.dealId);
    if (entry?.hidden) {
      hiddenCount += 1;
      continue;
    }
    if (entry?.doneAt && doneThisWeek(entry.doneAt, now)) continue;
    const blocker = dealBlocker(item, entry);
    const row: PriorityStackRow & { manualRank: number | null; readiness: number; priorityScore: number } = {
      key: `deal:${item.dealId}`,
      kind: "deal",
      rank: 0,
      manual: entry?.manualRank != null && !entry.bundleId,
      isNew: false,
      name: item.dealName,
      contactName: item.contactName,
      stage: item.stage,
      bucket: item.bucket,
      lane: laneForBucket(item.bucket),
      blocker: blocker.text,
      blockerSource: blocker.source,
      nextStep: entry?.nextStep ?? "",
      targetDate: item.shipBy,
      targetSource: item.shipBySource,
      tentative: entry?.tentative ?? false,
      amount: roundMoney(item.amount),
      tier: stackTier(item.shipBy, now, (entry?.tierOverride as StackTier | null) ?? null),
      shippingRequired: item.shippingRequired,
      dealId: item.dealId,
      offbookId: null,
      bundleId: entry?.bundleId ?? null,
      fulfillment: item.fulfillment,
      steps: [],
      members: [],
      item,
      doneAt: entry?.doneAt ?? null,
      doneAmount: parseStackAmount(entry?.doneAmount),
      manualRank: entry?.bundleId ? null : (entry?.manualRank ?? null),
      readiness: readinessRank(item),
      priorityScore: item.priorityScore,
    };
    if (entry?.bundleId) {
      const list = memberRows.get(entry.bundleId) ?? [];
      list.push(row);
      memberRows.set(entry.bundleId, list);
    } else {
      loose.push(row);
    }
  }

  for (const bundle of state.bundles) {
    const members = memberRows.get(bundle.id) ?? [];
    if (members.length === 0) continue;
    if (bundle.doneAt && doneThisWeek(bundle.doneAt, now)) continue;
    const targetDate = members.reduce((latest, member) => (member.targetDate > latest ? member.targetDate : latest), members[0].targetDate);
    const memberReadiness = (member: PriorityStackRow) =>
      readinessRank(member.item ?? { bucket: member.bucket, stage: member.stage });
    const leastReady = members.slice().sort((a, b) => memberReadiness(a) - memberReadiness(b))[0];
    const readiness = memberReadiness(leastReady);
    const amount = roundMoney(members.reduce((sum, member) => sum + (member.amount ?? 0), 0));
    const manual = bundle.blocker.trim();
    loose.push({
      key: `bundle:${bundle.id}`,
      kind: "bundle",
      rank: 0,
      manual: bundle.manualRank != null,
      isNew: false,
      name: bundle.label,
      contactName: null,
      stage: leastReady?.stage ?? "",
      bucket: leastReady?.bucket ?? "in_production",
      lane: laneForBucket(leastReady?.bucket),
      blocker: manual || members.map((member) => member.blocker).filter(Boolean).slice(0, 2).join(" · "),
      blockerSource: manual ? "manual" : "auto",
      nextStep: bundle.nextStep,
      targetDate,
      targetSource: members.every((member) => member.targetSource === "override") ? "override" : "derived",
      tentative: members.some((member) => member.tentative),
      amount,
      tier: stackTier(targetDate, now, (bundle.tierOverride as StackTier | null) ?? null),
      shippingRequired: bundle.fulfillmentMode !== "pickup",
      dealId: null,
      offbookId: null,
      bundleId: bundle.id,
      fulfillment: null,
      steps: [],
      members,
      item: null,
      doneAt: bundle.doneAt,
      doneAmount: amount,
      manualRank: bundle.manualRank,
      readiness,
      priorityScore: Math.max(...members.map((member) => member.item?.priorityScore ?? 0)),
    });
  }

  for (const entry of state.entries) {
    if (entry.kind !== "offbook") continue;
    if (entry.hidden) {
      hiddenCount += 1;
      continue;
    }
    if (entry.doneAt && doneThisWeek(entry.doneAt, now)) continue;
    const steps = parseSteps(entry.stepsJson);
    const allDone = steps.length > 0 && steps.every((step) => step.done);
    const targetDate = entry.targetDate || addShipByCalendarDays(today, 7);
    const amount = parseStackAmount(entry.amount);
    loose.push({
      key: `offbook:${entry.id}`,
      kind: "offbook",
      rank: 0,
      manual: entry.manualRank != null,
      isNew: false,
      name: entry.title,
      contactName: entry.contactName || null,
      stage: entry.fulfillmentMode === "pickup" ? "Local pickup" : "Off-book",
      bucket: "offbook",
      lane: "shop",
      blocker: entry.blocker.trim() || (steps.find((step) => !step.done)?.label ?? ""),
      blockerSource: entry.blocker.trim() ? "manual" : "auto",
      nextStep: entry.nextStep,
      targetDate,
      targetSource: entry.targetDate ? "local" : "unset",
      tentative: entry.tentative,
      amount,
      tier: stackTier(targetDate, now, (entry.tierOverride as StackTier | null) ?? null),
      shippingRequired: entry.fulfillmentMode !== "pickup",
      dealId: null,
      offbookId: entry.id,
      bundleId: null,
      fulfillment: null,
      steps,
      members: [],
      item: null,
      doneAt: entry.doneAt,
      doneAmount: parseStackAmount(entry.doneAmount),
      manualRank: entry.manualRank,
      readiness: allDone ? 4 : 2,
      priorityScore: 0,
    });
  }

  const rankedKeys = new Set(loose.filter((row) => row.manualRank != null).map((row) => row.key));
  const ordered = rankPriorityStack(loose);
  const rows = ordered.map((row, index) => ({
    ...row,
    rank: index + 1,
    isNew: row.manualRank == null && rankedKeys.size > 0,
    tier: row.tier,
  }));

  const outTheDoor: PriorityStackRow[] = [];
  for (const entry of state.entries) {
    if (!doneThisWeek(entry.doneAt, now)) continue;
    if (entry.kind === "deal" && entry.hubspotDealId && openIds.has(entry.hubspotDealId) && !entry.doneAt) continue;
    outTheDoor.push({
      key: entry.kind === "offbook" ? `offbook:${entry.id}` : `deal:${entry.hubspotDealId}`,
      kind: entry.kind === "offbook" ? "offbook" : "deal",
      rank: 0,
      manual: false,
      isNew: false,
      name: entry.doneName || entry.title || entry.hubspotDealId || "Done",
      contactName: entry.contactName || null,
      stage: "Done",
      bucket: entry.kind === "offbook" ? "offbook" : "ship_ready",
      lane: entry.kind === "offbook" ? "shop" : "good",
      blocker: "",
      blockerSource: "manual",
      nextStep: "",
      targetDate: today,
      targetSource: "local",
      tentative: false,
      amount: parseStackAmount(entry.doneAmount),
      tier: "committed",
      shippingRequired: entry.fulfillmentMode !== "pickup",
      dealId: entry.hubspotDealId,
      offbookId: entry.kind === "offbook" ? entry.id : null,
      bundleId: entry.bundleId,
      fulfillment: null,
      steps: [],
      members: [],
      item: null,
      doneAt: entry.doneAt,
      doneAmount: parseStackAmount(entry.doneAmount),
    });
  }

  const totals = stackTotals([
    ...rows.map((row) => ({
      tier: row.tier,
      amount: row.amount,
      offBookUnpriced: row.kind === "offbook" && row.amount == null,
      doneAmount: null,
      doneThisWeek: false,
    })),
    ...outTheDoor.map((row) => ({
      tier: "committed" as const,
      amount: null,
      offBookUnpriced: false,
      doneAmount: row.doneAmount,
      doneThisWeek: true,
    })),
  ]);

  return {
    ok: true,
    generatedAt: now.toISOString(),
    today,
    weekEnd,
    rows,
    outTheDoor,
    totals,
    hiddenCount,
  };
}
