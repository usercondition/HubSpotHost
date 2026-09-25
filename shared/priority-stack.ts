/**
 * Priority Stack ranking. Pure functions — no database, no HubSpot.
 * priorityScore is only a last tiebreak. Do not change the Queue score.
 */
import { addShipByCalendarDays, shipByCalendarDate } from "./ship-by";

export const STACK_STRETCH_DAYS = 1;

export type StackTier = "committed" | "stretch" | "later";
export type StackLane = "plates" | "fly" | "bad" | "good" | "shop";

export interface StackBlockerSignals {
  requiresPlates: boolean;
  hasPlates: boolean;
  kitReprint: number;
  unassignedPlateCount: number;
  costsIncomplete: boolean;
  addressStatus: string;
  needsReply: boolean;
  isStale: boolean;
  shippingRequired: boolean;
  shipByReason?: string | null;
  stage?: string | null;
}

export interface RankableStackRow {
  key: string;
  name: string;
  targetDate: string;
  readiness: number;
  amount: number;
  priorityScore: number;
  manualRank: number | null;
}

export function isPostProcessStageLabel(stage: string | null | undefined): boolean {
  return /\b(post[\s-]?process(?:ing)?|wash(?:ing)?|cur(?:e|ing)|qc|quality control|inspection)\b/i.test(stage ?? "");
}

/** Coming Sunday in Los Angeles. Sunday itself is the end of the shop week. */
export function shopWeekEnd(now: Date = new Date()): string {
  const today = shipByCalendarDate(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(now);
  const index: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = index[weekday] ?? 0;
  return addShipByCalendarDays(today, dow === 0 ? 0 : 7 - dow);
}

export function shopWeekStart(now: Date = new Date()): string {
  return addShipByCalendarDays(shopWeekEnd(now), -6);
}

export function stackTier(targetDate: string, now: Date = new Date(), override?: StackTier | null): StackTier {
  if (override === "committed" || override === "stretch" || override === "later") return override;
  const weekEnd = shopWeekEnd(now);
  if (targetDate <= weekEnd) return "committed";
  if (targetDate <= addShipByCalendarDays(weekEnd, STACK_STRETCH_DAYS)) return "stretch";
  return "later";
}

/** Higher means closer to out the door. A bundle uses its least-ready member. */
export function readinessRank(input: {
  bucket?: string | null;
  readyToPack?: boolean;
  stage?: string | null;
}): number {
  if (input.readyToPack || input.bucket === "ship_ready") return 4;
  if (isPostProcessStageLabel(input.stage)) return 3;
  if (input.bucket === "blocked") return 1;
  if (input.bucket === "next_print") return 0;
  return 2;
}

export function suggestedBlocker(signals: StackBlockerSignals): string {
  if (signals.requiresPlates && !signals.hasPlates) return "Needs plates";
  if (signals.kitReprint === 1) return "1 part reprint";
  if (signals.kitReprint > 1) return `${signals.kitReprint} parts reprint`;
  if (signals.unassignedPlateCount === 1) return "1 plate unassigned";
  if (signals.unassignedPlateCount > 1) return `${signals.unassignedPlateCount} plates unassigned`;
  if (signals.costsIncomplete) return "Needs costs";
  if (signals.shippingRequired && signals.addressStatus !== "ready" && signals.addressStatus !== "pickup") {
    return "Address missing";
  }
  if (signals.needsReply) return "Waiting on reply";
  if (signals.isStale) return "Stale in HubSpot";
  if (signals.shipByReason && /24h qc/i.test(signals.shipByReason)) return "24h QC";
  if (isPostProcessStageLabel(signals.stage)) return "24h QC";
  return "";
}

export function autoCompare(a: RankableStackRow, b: RankableStackRow): number {
  if (a.targetDate !== b.targetDate) return a.targetDate < b.targetDate ? -1 : 1;
  if (a.readiness !== b.readiness) return b.readiness - a.readiness;
  if (a.amount !== b.amount) return b.amount - a.amount;
  if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
  return a.name.localeCompare(b.name);
}

/**
 * Manual ranks keep their relative order. An unranked row is inserted before
 * the first row whose target date is strictly later, so a new urgent order
 * is not buried under an older manual order.
 */
export function rankPriorityStack<T extends RankableStackRow>(rows: T[]): T[] {
  const ranked = rows
    .filter((row) => row.manualRank != null)
    .sort((a, b) => (a.manualRank! - b.manualRank!) || autoCompare(a, b));
  const fresh = rows.filter((row) => row.manualRank == null).sort(autoCompare);
  const result = [...ranked];
  for (const row of fresh) {
    const index = result.findIndex((existing) => existing.targetDate > row.targetDate);
    if (index === -1) result.push(row);
    else result.splice(index, 0, row);
  }
  return result;
}

export interface StackTotalRow {
  tier: StackTier;
  amount: number | null;
  offBookUnpriced: boolean;
  doneAmount: number | null;
  doneThisWeek: boolean;
}

export interface StackTotals {
  committed: number;
  stretch: number;
  later: number;
  outTheDoor: number;
  offBookUnpriced: number;
}

export function stackTotals(rows: StackTotalRow[]): StackTotals {
  const totals: StackTotals = { committed: 0, stretch: 0, later: 0, outTheDoor: 0, offBookUnpriced: 0 };
  for (const row of rows) {
    if (row.doneThisWeek && row.doneAmount != null) totals.outTheDoor = roundMoney(totals.outTheDoor + row.doneAmount);
    if (row.doneThisWeek) continue;
    if (row.offBookUnpriced) {
      if (row.tier === "committed") totals.offBookUnpriced += 1;
      continue;
    }
    if (row.amount == null) continue;
    totals[row.tier] = roundMoney(totals[row.tier] + row.amount);
  }
  return totals;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseStackAmount(value: string | null | undefined): number | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const amount = Number(trimmed.replace(/[$,]/g, ""));
  return Number.isFinite(amount) ? roundMoney(amount) : null;
}

export function laneForBucket(bucket: string | null | undefined): StackLane {
  if (bucket === "next_print") return "plates";
  if (bucket === "blocked") return "bad";
  if (bucket === "ship_ready") return "good";
  if (bucket === "offbook") return "shop";
  return "fly";
}
