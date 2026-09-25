/**
 * One Needs-you list for the Floor board, the Floor tab badge, and the bell.
 * Shop tasks (intake, resin, FEP, replies, address) count the same as deal alerts.
 */
import { formatMoney } from "@/lib/format";
import { attentionNextStep, floorFocusMeta, floorWorkHref } from "@/lib/workflow";
import { addressStatusPill } from "@shared/ship-address";

export type FloorLane = "plates" | "warn" | "bad" | "shop";
export type FloorNeedIcon = "file" | "alert" | "link" | "beaker" | "printer" | "pin";

export interface FloorNeed {
  key: string;
  lane: FloorLane;
  rank: number;
  shipBy: string;
  name: string;
  problem: string;
  money: string;
  href: string;
  pill: string;
  testId: string;
  dealId?: string;
  issueKey?: string;
  chaseDraft?: string;
  icon: FloorNeedIcon;
}

const LANE_RANK: Record<FloorLane, number> = { bad: 0, plates: 1, warn: 2, shop: 3 };

function issueLane(issueKey: string): FloorLane {
  if (issueKey === "no_plates") return "plates";
  if (issueKey === "stale") return "bad";
  return "warn";
}

export interface FloorNeedInput {
  today: string;
  portalId?: string | null;
  attention: Array<{
    dealId: string;
    dealName: string;
    issue: string;
    issueKey: string;
    detail: string;
  }>;
  deals: Array<{ dealId: string; amount: number }>;
  queue: Array<{
    dealId: string;
    dealName: string;
    amount: number;
    shipBy: string;
    bucket: string;
    needsReply: boolean;
    readyToPack: boolean;
    addressStatus: "ready" | "partial" | "missing" | "pickup";
    chaseDraft: string;
    fulfillment: { readyPercent: number };
  }>;
  pendingReview: number;
  awaitingClient: number;
  resinBuyNow: Array<{ name: string }>;
  fepDue: Array<{ name: string }>;
}

export function buildFloorNeeds(input: FloorNeedInput): FloorNeed[] {
  const floorNeeds: FloorNeed[] = [];
  const dealById = new Map(input.deals.map((deal) => [deal.dealId, deal]));
  const queueByDealId = new Map(input.queue.map((item) => [item.dealId, item]));

  for (const item of input.attention) {
    const step = attentionNextStep({ dealId: item.dealId, issue: item.issue, portalId: input.portalId });
    const queueItem = queueByDealId.get(item.dealId);
    const deal = dealById.get(item.dealId);
    const lane = issueLane(item.issueKey);
    floorNeeds.push({
      key: `${item.dealId}-${item.issueKey}`,
      lane,
      rank: LANE_RANK[lane],
      shipBy: queueItem?.shipBy ?? "",
      name: item.dealName,
      problem: item.detail || item.issue,
      money: deal ? formatMoney(deal.amount) : "",
      href: step.href,
      pill: step.label,
      testId: `row-glance-${item.dealId}-${item.issueKey}`,
      dealId: item.dealId,
      issueKey: item.issueKey,
      icon: item.issueKey === "no_plates" ? "file" : "alert",
    });
  }
  if (input.pendingReview > 0) {
    floorNeeds.push({
      key: "intake-review",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `${input.pendingReview} intake waiting`,
      problem: "Approve or cancel paid order forms",
      money: "",
      href: "/orders",
      pill: "Open Intake",
      testId: "row-glance-intake-review",
      icon: "link",
    });
  }
  if (input.awaitingClient > 0) {
    floorNeeds.push({
      key: "awaiting-client",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `${input.awaitingClient} buyer link${input.awaitingClient === 1 ? "" : "s"} open`,
      problem: "Still awaiting client details",
      money: "",
      href: floorFocusMeta("buyer").workspaceHref,
      pill: "Open Intake",
      testId: "row-glance-awaiting-client",
      icon: "link",
    });
  }
  if (input.resinBuyNow.length > 0) {
    const first = input.resinBuyNow[0]?.name ?? "Resin";
    floorNeeds.push({
      key: "resin",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `Buy resin · ${input.resinBuyNow.length}`,
      problem: `${first}${input.resinBuyNow.length > 1 ? ` +${input.resinBuyNow.length - 1}` : ""}`,
      money: "",
      href: "/resin",
      pill: "Resin stock",
      testId: "row-glance-resin-buy",
      icon: "beaker",
    });
  }
  if (input.fepDue.length > 0) {
    floorNeeds.push({
      key: "fep",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `FEP due · ${input.fepDue.length}`,
      problem: input.fepDue.map((printer) => printer.name).slice(0, 2).join(", "),
      money: "",
      href: "/printers",
      pill: "Printers",
      testId: "row-glance-fep-due",
      icon: "printer",
    });
  }

  const seenDeals = new Set(floorNeeds.map((need) => need.dealId).filter(Boolean));
  for (const item of input.queue) {
    if (item.needsReply && !seenDeals.has(item.dealId)) {
      floorNeeds.push({
        key: `${item.dealId}-reply`,
        lane: "warn",
        rank: LANE_RANK.warn,
        shipBy: item.shipBy,
        name: item.dealName,
        problem: "Waiting on a reply",
        money: formatMoney(item.amount),
        href: floorWorkHref(item.dealId, item.bucket),
        pill: "Needs reply",
        testId: `row-floor-reply-${item.dealId}`,
        dealId: item.dealId,
        icon: "alert",
      });
      seenDeals.add(item.dealId);
    }
    const nearShip = item.bucket === "ship_ready" || item.readyToPack || item.fulfillment.readyPercent >= 80;
    const address = addressStatusPill(item.addressStatus);
    if (
      nearShip &&
      item.addressStatus !== "ready" &&
      item.addressStatus !== "pickup" &&
      address.tone !== "good" &&
      !floorNeeds.some((need) => need.dealId === item.dealId && need.key.endsWith("-address"))
    ) {
      floorNeeds.push({
        key: `${item.dealId}-address`,
        lane: "warn",
        rank: LANE_RANK.warn,
        shipBy: item.shipBy,
        name: item.dealName,
        problem: address.label,
        money: formatMoney(item.amount),
        href: floorWorkHref(item.dealId, item.bucket),
        pill: address.label,
        testId: `row-floor-address-${item.dealId}`,
        dealId: item.dealId,
        chaseDraft: item.chaseDraft || undefined,
        icon: "pin",
      });
    }
  }

  floorNeeds.sort((a, b) => {
    const aOver = a.shipBy && a.shipBy < input.today ? 0 : 1;
    const bOver = b.shipBy && b.shipBy < input.today ? 0 : 1;
    return aOver - bOver || a.rank - b.rank || (a.shipBy || "9999").localeCompare(b.shipBy || "9999") || a.name.localeCompare(b.name);
  });
  return floorNeeds;
}

/** Printers at or over 85% FEP wear, matching the Floor shop task. */
export function fepDuePrinters(
  printers: Array<{ name: string; status: string; fepHoursUsedPercent: number | null; fepLayersUsedPercent: number | null }>,
): Array<{ name: string }> {
  return printers.filter((printer) => {
    if (printer.status !== "active") return false;
    const hours = printer.fepHoursUsedPercent ?? 0;
    const layers = printer.fepLayersUsedPercent ?? 0;
    return Math.max(hours, layers) >= 85;
  });
}
