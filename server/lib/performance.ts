import { calculateProfit, round2 } from "./calc";
import { attentionIssueKeyFromIssue, overrideKey } from "./attention";
import { buildSupplyBooksBalance } from "./books";
import type { HubSpotDealRecord, HubSpotPipelineStage } from "./hubspot";
import {
  dealRequiresPlates,
  normalizeOrderLineKind,
  PRINT_LINE_KIND_PROPERTY,
  type SupplyBooksBalance,
} from "../../shared/schema";
import { dealCostsIncomplete } from "../../shared/deal-costs";

export const PERFORMANCE_WINDOW_DAYS = 30;
export const PERFORMANCE_STALE_DAYS = 7;
export const PERFORMANCE_MARGIN_ALERT_PERCENT = 40;
const ATTENTION_LIMIT = 8;
/** Cap for Command Center + Orders page open-deal lists. */
const ACTIVE_DEALS_LIMIT = 40;
/** Cap for Orders board “Show completed & lost” cards. */
const CLOSED_DEALS_LIMIT = 60;

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
  books: SupplyBooksBalance;
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
    issueKey: string;
    detail: string;
    severity: "neutral" | "warn" | "bad";
  }>;
  /** Compact open Print Orders for the command-center glance / Orders board. */
  activeDeals: Array<{
    dealId: string;
    dealName: string;
    stageId: string;
    stage: string;
    amount: number;
    hasPlates: boolean;
    /**
     * False for shipping / fee / name-heuristic non-print deals.
     */
    requiresPlates: boolean;
    /**
     * True when plates are still missing and the owner has not dismissed the
     * “No CTB plates” attention alert for this deal.
     */
    promptAttachPlates: boolean;
    /** HubSpot close date (ISO), when set. */
    closeDate: string | null;
    /** Best-effort contact label from “Product - Client” deal names. */
    contactName: string | null;
  }>;
  /** Closed HubSpot deals for Orders board completed/lost columns. */
  closedDeals: Array<PerformanceSnapshot["activeDeals"][number]>;
  /** HubSpot portal id for deal deep links; null when account info is unavailable. */
  hubspotPortalId: string | null;
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function truthyHubSpotFlag(value: string | null | undefined): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function stageClosed(stage: HubSpotPipelineStage | undefined): boolean {
  const value = stage?.metadata?.isClosed;
  return value === true || value === "true";
}

/** Closed pipeline stage or HubSpot closed / closed-won flags. */
function dealIsClosed(
  props: HubSpotDealRecord["properties"],
  stage: HubSpotPipelineStage | undefined,
): boolean {
  if (stageClosed(stage)) return true;
  return truthyHubSpotFlag(props.hs_is_closed) || truthyHubSpotFlag(props.hs_is_closed_won);
}

function stageName(
  stageId: string | null | undefined,
  stageMap: Map<string, HubSpotPipelineStage>,
): string {
  if (!stageId) return "Unassigned stage";
  return stageMap.get(stageId)?.label ?? "Unknown stage";
}

/** Many Print Orders are named “Product - Client”; surface the client on board cards. */
function contactNameFromDeal(dealName: string): string | null {
  const separator = " - ";
  const index = dealName.lastIndexOf(separator);
  if (index < 0) return null;
  const contact = dealName.slice(index + separator.length).trim();
  return contact.length >= 2 ? contact : null;
}

function closeDateIso(value: string | null | undefined): string | null {
  const date = asDate(value);
  return date ? date.toISOString() : null;
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
  /** Dismissed attention keys as `dealId:issueKey`. */
  dismissedAttentionKeys?: Iterable<string>;
  hubspotPortalId?: string | null;
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
  const dismissedAttentionKeys = new Set(input.dismissedAttentionKeys ?? []);

  let revenue = 0;
  let grossProfit = 0;
  let orders = 0;
  let activeOrders = 0;
  const attention: Array<PerformanceSnapshot["attention"][number] & { priority: number }> = [];
  const openDeals: Array<PerformanceSnapshot["activeDeals"][number] & { sortAt: number }> = [];
  const finishedDeals: Array<PerformanceSnapshot["activeDeals"][number] & { sortAt: number }> = [];

  for (const deal of input.deals) {
    const props = deal.properties;
    const stageId = props.dealstage;
    const stage = stageMap.get(stageId ?? "");
    const closed = dealIsClosed(props, stage);
    if (stageId && stageCounts.has(stageId)) {
      stageCounts.set(stageId, (stageCounts.get(stageId) ?? 0) + 1);
    }

    const calculation = calculateProfit(props);
    const createdAt = asDate(props.createdate);
    const modifiedAt = asDate(props.hs_lastmodifieddate);
    const dealName = props.dealname?.trim() || `Deal ${deal.id}`;
    const displayStage = stageName(stageId, stageMap);
    const requiresPlates = dealRequiresPlates(props);
    const missingCosts = dealCostsIncomplete(props, { requiresPlates });

    if (createdAt && createdAt >= periodStart) {
      orders += 1;
      revenue += calculation.amount;
      grossProfit += calculation.grossProfit;
    }

    const hasPlates = attachedPrintDealIds.has(deal.id);
    const boardDeal = {
      dealId: deal.id,
      dealName,
      stageId: stageId ?? "",
      stage: displayStage,
      amount: round2(calculation.amount),
      hasPlates,
      requiresPlates,
      promptAttachPlates: false as boolean,
      closeDate: closeDateIso(props.closedate),
      contactName: contactNameFromDeal(dealName),
      sortAt: (modifiedAt ?? createdAt ?? now).getTime(),
    };

    if (closed) {
      // Still list on Orders when “Show completed & lost” is on — never attention / Floor.
      finishedDeals.push(boardDeal);
      continue;
    }
    activeOrders += 1;

    const promptAttachPlates =
      requiresPlates &&
      !hasPlates &&
      !dismissedAttentionKeys.has(overrideKey(deal.id, "no_plates"));
    openDeals.push({
      ...boardDeal,
      promptAttachPlates,
    });

    const pushAttention = (
      priority: number,
      issue: string,
      detail: string,
      severity: "neutral" | "warn" | "bad",
    ) => {
      const issueKey = attentionIssueKeyFromIssue(issue);
      if (dismissedAttentionKeys.has(overrideKey(deal.id, issueKey))) return;
      attention.push({
        priority,
        dealId: deal.id,
        dealName,
        stage: displayStage,
        issue,
        issueKey,
        detail,
        severity,
      });
    };

    // Collect every open issue for the deal so one alert does not hide another.
    if (
      requiresPlates &&
      !missingCosts &&
      calculation.amount > 0 &&
      calculation.marginPercentage < PERFORMANCE_MARGIN_ALERT_PERCENT
    ) {
      pushAttention(
        calculation.marginPercentage < 20 ? 1 : 2,
        `Margin below ${PERFORMANCE_MARGIN_ALERT_PERCENT}%`,
        `${calculation.marginPercentage.toFixed(1)}% margin · ${formatMoney(calculation.grossProfit)} gross profit`,
        calculation.marginPercentage < 20 ? "bad" : "warn",
      );
    }

    const estimatedResin = Number(props.print_estimated_resin_cost);
    const materialCost = Number(props.print_material_cost);
    const hasEstimatedResin =
      props.print_estimated_resin_cost?.trim() !== "" &&
      Number.isFinite(estimatedResin) &&
      estimatedResin > 0;
    const hasMaterialCost =
      props.print_material_cost?.trim() !== "" &&
      Number.isFinite(materialCost) &&
      materialCost > 0;
    if (hasEstimatedResin && hasMaterialCost) {
      const variancePct = (Math.abs(materialCost - estimatedResin) / estimatedResin) * 100;
      if (variancePct >= PERFORMANCE_COST_VARIANCE_PERCENT) {
        pushAttention(
          2.5,
          "Material cost vs CTB estimate",
          `${formatMoney(materialCost)} actual vs ${formatMoney(estimatedResin)} estimate (${variancePct.toFixed(0)}% apart)`,
          variancePct >= 50 ? "bad" : "warn",
        );
      }
    }

    if (modifiedAt && modifiedAt < staleBefore) {
      pushAttention(
        3,
        "No recent activity",
        `No HubSpot update in ${daysSince(modifiedAt, now)} days`,
        "warn",
      );
    }

    if (missingCosts) {
      if (!requiresPlates) {
        // Fee / surcharge charge lines never need cost entry here.
        // Shipping charge lines can still remind for actual shipping cost.
        const kind = normalizeOrderLineKind(props?.[PRINT_LINE_KIND_PROPERTY]);
        const isShippingCharge =
          kind === "shipping" ||
          (() => {
            const lower = dealName.toLowerCase();
            const product = lower.includes(" - ")
              ? lower.slice(0, lower.lastIndexOf(" - ")).trim()
              : lower;
            return /^shipping\b/.test(product) || /^postage\b/.test(product) || /^freight\b/.test(product);
          })();
        if (isShippingCharge) {
          pushAttention(
            4,
            "Cost details incomplete",
            "Add actual shipping cost when known",
            "neutral",
          );
        }
      } else {
        pushAttention(
          4,
          "Cost details incomplete",
          "Add material and shipping costs (labor absorbed · free USPS flat-rate = $0)",
          "neutral",
        );
      }
    }

    if (requiresPlates && !hasPlates && calculation.amount > 0) {
      pushAttention(
        5,
        "No CTB plates attached",
        "Attach sliced plates in Print files so production time and resin estimates are on this order",
        "warn",
      );
    }
  }

  const weightedMarginPercent = revenue > 0 ? round2((grossProfit / revenue) * 100) : 0;
  const sortedAttention = attention
    .sort((a, b) => a.priority - b.priority || a.dealName.localeCompare(b.dealName))
    .map(({ priority: _priority, ...item }) => item);
  const activeDeals = openDeals
    .sort((a, b) => b.sortAt - a.sortAt || a.dealName.localeCompare(b.dealName))
    .slice(0, ACTIVE_DEALS_LIMIT)
    .map(({ sortAt: _sortAt, ...item }) => item);
  const closedDeals = finishedDeals
    .sort((a, b) => b.sortAt - a.sortAt || a.dealName.localeCompare(b.dealName))
    .slice(0, CLOSED_DEALS_LIMIT)
    .map(({ sortAt: _sortAt, ...item }) => item);
  const supplySpend = input.supplySpend ?? EMPTY_SUPPLY_SPEND;
  const books = buildSupplyBooksBalance({
    periodDays: PERFORMANCE_WINDOW_DAYS,
    revenue: round2(revenue),
    grossProfit: round2(grossProfit),
    orders,
    supplySpend,
  });

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
    supplySpend,
    books,
    pipeline: input.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      count: stageCounts.get(stage.id) ?? 0,
      closed: stageClosed(stage),
    })),
    attention: sortedAttention.slice(0, ATTENTION_LIMIT),
    activeDeals,
    closedDeals,
    hubspotPortalId: input.hubspotPortalId ?? null,
  };
}
