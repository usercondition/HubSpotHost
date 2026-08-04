import { calculateProfit, round2 } from "./calc";
import type { HubSpotDealRecord, HubSpotPipelineStage } from "./hubspot";

export const PERFORMANCE_WINDOW_DAYS = 30;
export const PERFORMANCE_STALE_DAYS = 7;
export const PERFORMANCE_MARGIN_ALERT_PERCENT = 40;
const ATTENTION_LIMIT = 8;

type QueueCounts = {
  awaiting_client: number;
  pending_review: number;
  created: number;
  expired: number;
};

export type SupplySpend = {
  periodDays: number;
  total: number;
  purchases: number;
  byCategory: Array<{
    category: "materials" | "consumables" | "packaging_shipping" | "equipment_maintenance" | "other";
    label: string;
    total: number;
    count: number;
  }>;
};

const EMPTY_SUPPLY_SPEND: SupplySpend = {
  periodDays: PERFORMANCE_WINDOW_DAYS,
  total: 0,
  purchases: 0,
  byCategory: [],
};

export interface PerformanceSnapshot {
  generatedAt: string;
  period: {
    days: number;
    startsAt: string;
  };
  thresholds: {
    marginPercent: number;
    staleDays: number;
  };
  summary: {
    revenue: number;
    grossProfit: number;
    weightedMarginPercent: number;
    orders: number;
    averageOrderValue: number;
    activeOrders: number;
    attentionCount: number;
  };
  intake: {
    awaitingClient: number;
    pendingReview: number;
    approved: number;
  };
  supplySpend: SupplySpend;
  pipeline: Array<{
    id: string;
    label: string;
    count: number;
    closed: boolean;
  }>;
  attention: Array<{
    dealId: string;
    dealName: string;
    stage: string;
    issue: string;
    detail: string;
    severity: "neutral" | "warn" | "bad";
  }>;
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

function stageClosed(stage: HubSpotPipelineStage | undefined): boolean {
  const value = stage?.metadata?.isClosed;
  return value === true || value === "true";
}

function stageName(
  stageId: string | null | undefined,
  stageMap: Map<string, HubSpotPipelineStage>,
): string {
  if (!stageId) return "Unassigned stage";
  return stageMap.get(stageId)?.label ?? "Unknown stage";
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

export function buildPerformanceSnapshot(input: {
  deals: HubSpotDealRecord[];
  stages: HubSpotPipelineStage[];
  intakeCounts: QueueCounts;
  supplySpend?: SupplySpend;
  /** Local Print-files deal IDs that already have at least one attached CTB plate. */
  attachedPrintDealIds?: Iterable<string>;
  now?: Date;
}): PerformanceSnapshot {
  const now = input.now ?? new Date();
  const periodStart = new Date(now);
  periodStart.setUTCDate(periodStart.getUTCDate() - PERFORMANCE_WINDOW_DAYS);
  const staleBefore = new Date(now);
  staleBefore.setUTCDate(staleBefore.getUTCDate() - PERFORMANCE_STALE_DAYS);
  const stageMap = new Map(input.stages.map((stage) => [stage.id, stage]));
  const stageCounts = new Map(input.stages.map((stage) => [stage.id, 0]));
  const attachedPrintDealIds = new Set(input.attachedPrintDealIds ?? []);

  let revenue = 0;
  let grossProfit = 0;
  let orders = 0;
  let activeOrders = 0;
  const attention: Array<PerformanceSnapshot["attention"][number] & { priority: number }> = [];

  for (const deal of input.deals) {
    const props = deal.properties;
    const stageId = props.dealstage;
    const stage = stageMap.get(stageId ?? "");
    const closed = stageClosed(stage);
    if (stageId && stageCounts.has(stageId)) {
      stageCounts.set(stageId, (stageCounts.get(stageId) ?? 0) + 1);
    }

    const calculation = calculateProfit(props);
    const createdAt = asDate(props.createdate);
    const modifiedAt = asDate(props.hs_lastmodifieddate);
    const dealName = props.dealname?.trim() || `Deal ${deal.id}`;
    const displayStage = stageName(stageId, stageMap);
    const missingCosts = [
      props.print_material_cost,
      props.print_labor_cost,
      props.print_packaging_cost,
      props.print_actual_shipping_cost,
    ].some(isBlank);

    if (createdAt && createdAt >= periodStart) {
      orders += 1;
      revenue += calculation.amount;
      grossProfit += calculation.grossProfit;
    }

    if (closed) continue;
    activeOrders += 1;

    const hasPlates = attachedPrintDealIds.has(deal.id);

    // Collect every open issue for the deal so one alert does not hide another.
    if (!missingCosts && calculation.amount > 0 && calculation.marginPercentage < PERFORMANCE_MARGIN_ALERT_PERCENT) {
      attention.push({
        priority: calculation.marginPercentage < 20 ? 1 : 2,
        dealId: deal.id,
        dealName,
        stage: displayStage,
        issue: `Margin below ${PERFORMANCE_MARGIN_ALERT_PERCENT}%`,
        detail: `${calculation.marginPercentage.toFixed(1)}% margin · ${formatMoney(calculation.grossProfit)} gross profit`,
        severity: calculation.marginPercentage < 20 ? "bad" : "warn",
      });
    }

    if (modifiedAt && modifiedAt < staleBefore) {
      attention.push({
        priority: 3,
        dealId: deal.id,
        dealName,
        stage: displayStage,
        issue: "No recent activity",
        detail: `No HubSpot update in ${daysSince(modifiedAt, now)} days`,
        severity: "warn",
      });
    }

    if (missingCosts) {
      attention.push({
        priority: 4,
        dealId: deal.id,
        dealName,
        stage: displayStage,
        issue: "Cost details incomplete",
        detail: "Add material, labor, packaging, and shipping costs as they become known",
        severity: "neutral",
      });
    }

    if (!hasPlates && calculation.amount > 0) {
      attention.push({
        priority: 5,
        dealId: deal.id,
        dealName,
        stage: displayStage,
        issue: "No CTB plates attached",
        detail: "Attach sliced plates in Print files so production time and resin estimates are on this order",
        severity: "warn",
      });
    }
  }

  const weightedMarginPercent = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
  const sortedAttention = attention
    .sort((a, b) => a.priority - b.priority || a.dealName.localeCompare(b.dealName))
    .map(({ priority: _priority, ...item }) => item);

  return {
    generatedAt: now.toISOString(),
    period: {
      days: PERFORMANCE_WINDOW_DAYS,
      startsAt: periodStart.toISOString(),
    },
    thresholds: {
      marginPercent: PERFORMANCE_MARGIN_ALERT_PERCENT,
      staleDays: PERFORMANCE_STALE_DAYS,
    },
    summary: {
      revenue: round2(revenue),
      grossProfit: round2(grossProfit),
      weightedMarginPercent,
      orders,
      averageOrderValue: orders > 0 ? round2(revenue / orders) : 0,
      activeOrders,
      attentionCount: sortedAttention.length,
    },
    intake: {
      awaitingClient: input.intakeCounts.awaiting_client,
      pendingReview: input.intakeCounts.pending_review,
      approved: input.intakeCounts.created,
    },
    supplySpend: input.supplySpend ?? EMPTY_SUPPLY_SPEND,
    pipeline: input.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      count: stageCounts.get(stage.id) ?? 0,
      closed: stageClosed(stage),
    })),
    attention: sortedAttention.slice(0, ATTENTION_LIMIT),
  };
}
