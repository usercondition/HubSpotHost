/**
 * Shop performance math. Every figure is a sum or count of fields that were
 * actually recorded. Blank costs stay blank — they are never treated as zero,
 * except labor (always $0) and packaging ( $0 unless a packaging amount was entered).
 */

import { buildOrderOrigins, type OrderOrigins, type ShipToFields, type ZipIndex } from "./order-origins";
import { shipByCalendarDate, SHIP_BY_TIME_ZONE } from "./ship-by";

export const SHOP_PERIODS = ["7", "30", "90", "ytd", "all"] as const;
export type ShopPeriodId = (typeof SHOP_PERIODS)[number];

export type ShopMetricUnit = "usd" | "count" | "days" | "percent" | "hours" | "ml";

export interface ShopMetric {
  id: string;
  label: string;
  formula: string;
  value: number | null;
  unit: ShopMetricUnit;
  previous: number | null;
  /** Snapshot figures are the shop right now, so they are not compared. */
  compare: boolean;
  /** Why the number is missing, or a gap beside a partial number. */
  note: string | null;
  series: number[];
}

export interface ShopDashboardOrder {
  id: string;
  name: string;
  customer: string | null;
  createdAt: string | null;
  closedAt: string | null;
  open: boolean;
  won: boolean;
  lost: boolean;
  stageLabel: string;
  amount: number | null;
  /** Entered deal material dollars, otherwise a deduplicated slicer plate estimate. */
  resinCost: number | null;
  materialEstimated?: boolean;
  postage: number | null;
  /** Entered packaging, or 0 when the field is blank (free USPS boxes). */
  packaging: number;
  shipBy: string | null;
  tentative: boolean;
  needsReply: boolean;
  shipping: "ship" | "pickup" | "unknown";
  hasTracking: boolean;
  /** Contact ship-to already on the deal. Street is never included. */
  shipTo?: ShipToFields | null;
}

export interface ShopDashboardPlate {
  attachedAt: string;
  printTimeSeconds: number | null;
  resinVolumeMl: number | null;
  resinCost: number | null;
  printerLabel: string;
}

export interface ShopDashboardBit {
  status: string;
}

export interface ShopDashboardFailure {
  occurredAt: string;
}

export interface ShopDashboardPrinter {
  name: string;
  model: string;
  fepChangedAt: string | null;
  hoursSinceFep: number | null;
  recommendedFepHours: number | null;
}

export interface ShopDashboardInput {
  now: string;
  period: ShopPeriodId;
  orders: ShopDashboardOrder[];
  plates: ShopDashboardPlate[];
  bits: ShopDashboardBit[];
  failures: ShopDashboardFailure[];
  printers: ShopDashboardPrinter[];
  supplyPurchases: Array<{ purchasedAt: string; amount: number }>;
  /** Intake links still waiting on the customer. Current queue, not a period. */
  awaitingClient: number;
  /** Bundled ZIP centroids. Omitted in tests that only check money. */
  zips?: ZipIndex;
}

export interface ShopDashboard {
  period: { id: ShopPeriodId; label: string; compareLabel: string };
  headlines: ShopMetric[];
  money: ShopMetric[];
  speed: ShopMetric[];
  production: ShopMetric[];
  printers: Array<{ label: string; hours: number }>;
  fep: Array<{ name: string; hours: number | null; percent: number | null; note: string | null }>;
  pipeline: Array<{ label: string; count: number }>;
  customers: Array<{ name: string; revenue: number; orders: number }>;
  pipelineMetrics: ShopMetric[];
  channelMetrics: ShopMetric[];
  origins: OrderOrigins;
}

const PERIOD_LABEL: Record<ShopPeriodId, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  ytd: "Year to date",
  all: "All time",
};

interface Window {
  start: number | null;
  end: number;
  previousStart: number | null;
  previousEnd: number | null;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dayKey(time: number): string {
  return shipByCalendarDate(new Date(time));
}

function pacificYear(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: SHIP_BY_TIME_ZONE, year: "numeric" }).format(now));
}

function pacificDateAtMidnight(year: number, month: number, day: number): number {
  const probe = new Date(Date.UTC(year, month, day, 12));
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: SHIP_BY_TIME_ZONE, timeZoneName: "shortOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value ?? "GMT-8";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offset);
  const minutes = match ? (Number(match[2]) * 60 + Number(match[3] ?? 0)) * (match[1] === "+" ? 1 : -1) : -480;
  return Date.UTC(year, month, day) - minutes * 60_000;
}

export function resolveShopWindow(period: ShopPeriodId, now: Date): Window {
  const end = now.getTime();
  if (period === "all") return { start: null, end, previousStart: null, previousEnd: null };
  if (period === "ytd") {
    const year = pacificYear(now);
    const start = pacificDateAtMidnight(year, 0, 1);
    const previousStart = pacificDateAtMidnight(year - 1, 0, 1);
    const previousEnd = end - (start - previousStart);
    return { start, end, previousStart, previousEnd };
  }
  const days = Number(period);
  const span = days * 86_400_000;
  return { start: end - span, end, previousStart: end - span * 2, previousEnd: end - span };
}

function inWindow(time: number | null, start: number | null, end: number | null): boolean {
  if (time == null || end == null) return false;
  if (start != null && time < start) return false;
  return time <= end;
}

function units(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.max(0, round2(sorted[mid]!));
  return Math.max(0, round2((sorted[mid - 1]! + sorted[mid]!) / 2));
}

function metric(partial: Omit<ShopMetric, "series" | "previous" | "compare"> & { previous?: number | null; compare?: boolean; series?: number[] }): ShopMetric {
  return {
    previous: partial.previous ?? null,
    compare: partial.compare ?? false,
    series: partial.series ?? [],
    ...partial,
  };
}

function moneyOnce(order: ShopDashboardOrder): { profit: number; cost: number } | null {
  if (order.amount == null || order.resinCost == null || order.postage == null) return null;
  const cost = round2(order.resinCost + order.packaging + order.postage);
  return { profit: round2(order.amount - cost), cost };
}

function booked(orders: ShopDashboardOrder[], start: number | null, end: number | null) {
  let revenue = 0;
  let priced = 0;
  let missingAmount = 0;
  let count = 0;
  for (const order of orders) {
    if (!inWindow(parseTime(order.createdAt), start, end)) continue;
    count += 1;
    if (order.amount == null) missingAmount += 1;
    else {
      revenue = round2(revenue + order.amount);
      priced += 1;
    }
  }
  return { revenue, priced, missingAmount, count };
}

function shipped(orders: ShopDashboardOrder[], start: number | null, end: number | null) {
  let revenue = 0;
  let missingAmount = 0;
  let missingClose = 0;
  const days: number[] = [];
  let onTime = 0;
  let withShipBy = 0;
  let counted = 0;
  for (const order of orders) {
    if (!order.won) continue;
    const closed = parseTime(order.closedAt);
    if (closed == null) {
      if (inWindow(parseTime(order.createdAt), start, end)) missingClose += 1;
      continue;
    }
    if (!inWindow(closed, start, end)) continue;
    counted += 1;
    if (order.amount == null) missingAmount += 1;
    else revenue = round2(revenue + order.amount);
    const created = parseTime(order.createdAt);
    if (created != null) days.push((closed - created) / 86_400_000);
    if (order.shipBy && !order.tentative) {
      withShipBy += 1;
      if (dayKey(closed) <= order.shipBy) onTime += 1;
    }
  }
  return { revenue, missingAmount, missingClose, days, onTime, withShipBy, counted };
}

function profitOf(orders: ShopDashboardOrder[], start: number | null, end: number | null) {
  let profit = 0;
  let cost = 0;
  let revenue = 0;
  let complete = 0;
  let missing = 0;
  let estimated = false;
  for (const order of orders) {
    if (!inWindow(parseTime(order.createdAt), start, end)) continue;
    const row = moneyOnce(order);
    if (!row) {
      missing += 1;
      continue;
    }
    complete += 1;
    estimated ||= order.materialEstimated === true;
    profit = round2(profit + row.profit);
    cost = round2(cost + row.cost);
    revenue = round2(revenue + (order.amount ?? 0));
  }
  return { profit, cost, revenue, complete, missing, estimated };
}

function missingCostNote(orders: ShopDashboardOrder[], start: number | null, end: number | null): string | null {
  const gaps = orders.flatMap((order) => {
    if (!inWindow(parseTime(order.createdAt), start, end) || moneyOnce(order)) return [];
    const missing = [order.resinCost == null ? "resin" : "", order.postage == null ? "postage" : ""].filter(Boolean).join(" + ");
    return missing ? [`${order.name}: ${missing}`] : [];
  });
  return gaps.length ? gaps.join("; ") : null;
}

function seriesFor(orders: ShopDashboardOrder[], window: Window): number[] {
  if (window.start == null) return [];
  const buckets = 6;
  const span = window.end - window.start;
  const totals = Array.from({ length: buckets }, () => 0);
  for (const order of orders) {
    const created = parseTime(order.createdAt);
    if (!inWindow(created, window.start, window.end) || order.amount == null || created == null) continue;
    const index = Math.min(buckets - 1, Math.floor(((created - window.start) / span) * buckets));
    totals[index] = round2(totals[index]! + order.amount);
  }
  return totals;
}

function printerBucket(label: string): string {
  const text = label.toLowerCase();
  if (text.includes("heygear")) return "HeyGears";
  if (text.includes("mega")) return "MEGA 8K";
  if (text.includes("12k")) return "Mighty 12K";
  if (text.includes("8k")) return "Mighty 8K";
  return label.trim() || "Printer not set";
}

export function buildShopDashboard(input: ShopDashboardInput): ShopDashboard {
  const now = new Date(input.now);
  const window = resolveShopWindow(input.period, now);
  const compare = window.previousEnd != null;
  const today = shipByCalendarDate(now);

  const currentBooked = booked(input.orders, window.start, window.end);
  const priorBooked = booked(input.orders, window.previousStart, window.previousEnd);
  const currentShipped = shipped(input.orders, window.start, window.end);
  const priorShipped = shipped(input.orders, window.previousStart, window.previousEnd);
  const currentProfit = profitOf(input.orders, window.start, window.end);
  const priorProfit = profitOf(input.orders, window.previousStart, window.previousEnd);
  const bars = seriesFor(input.orders, window);

  const amountNote = currentBooked.missingAmount > 0 ? units(currentBooked.missingAmount, "order missing an amount", "orders missing an amount") : null;
  const costNote = currentProfit.missing > 0
    ? `${units(currentProfit.missing, "order missing cost", "orders missing cost")}: ${missingCostNote(input.orders, window.start, window.end) ?? ""}`.trim()
    : null;

  const revenue = metric({
    id: "revenue-booked",
    label: "Revenue booked",
    formula: "Sum of order amounts created in the period. Blank amounts are left out.",
    value: currentBooked.priced > 0 ? currentBooked.revenue : currentBooked.count === 0 ? 0 : null,
    unit: "usd",
    previous: compare && priorBooked.priced > 0 ? priorBooked.revenue : compare && priorBooked.count === 0 ? 0 : null,
    compare,
    note: currentBooked.priced === 0 && currentBooked.count > 0 ? "No orders in this period have an amount." : amountNote,
    series: bars,
  });

  const shippedRevenue = metric({
    id: "revenue-shipped",
    label: "Revenue shipped",
    formula: "Sum of amounts on won orders whose close date falls in the period. Orders closed without a close date are left out.",
    value: currentShipped.counted === 0 ? 0 : currentShipped.counted > currentShipped.missingAmount ? currentShipped.revenue : null,
    unit: "usd",
    previous: compare ? priorShipped.revenue : null,
    compare,
    note: currentShipped.missingClose > 0 ? units(currentShipped.missingClose, "won order missing a close date", "won orders missing a close date") : currentShipped.missingAmount > 0 ? units(currentShipped.missingAmount, "shipped order missing an amount", "shipped orders missing an amount") : null,
  });

  const ordersMetric = metric({
    id: "orders",
    label: "Orders",
    formula: "HubSpot deals and off-book orders created in the period. An off-book row tied to a deal is not counted twice.",
    value: currentBooked.count,
    unit: "count",
    previous: compare ? priorBooked.count : null,
    compare,
    note: null,
  });

  const aov = metric({
    id: "aov",
    label: "Average order value",
    formula: "Revenue booked divided by orders that have an amount.",
    value: currentBooked.priced > 0 ? round2(currentBooked.revenue / currentBooked.priced) : null,
    unit: "usd",
    previous: compare && priorBooked.priced > 0 ? round2(priorBooked.revenue / priorBooked.priced) : null,
    compare,
    note: currentBooked.priced === 0 ? "No orders with an amount in this period." : amountNote,
  });

  const profit = metric({
    id: "gross-profit",
    label: "Gross profit",
    formula: "Amount minus entered material cost (or plate resin estimate when material is blank), packaging, and postage. Labor is $0. Packaging is $0 unless an amount was entered. Postage comes from the label amount on the deal, or $0 for pickup. Orders missing an amount, resin, or postage are left out.",
    value: currentProfit.complete > 0 ? currentProfit.profit : null,
    unit: "usd",
    previous: compare && priorProfit.complete > 0 ? priorProfit.profit : null,
    compare,
    note: currentProfit.complete === 0 ? costNote || "No orders with a complete cost in this period." : currentProfit.estimated ? "est. Includes slicer resin estimates where material cost is blank." : costNote,
  });

  const margin = metric({
    id: "margin",
    label: "Margin",
    formula: "Gross profit divided by the amount of the same orders included in gross profit.",
    value: currentProfit.revenue > 0 ? round2((currentProfit.profit / currentProfit.revenue) * 100) : null,
    unit: "percent",
    previous: compare && priorProfit.revenue > 0 ? round2((priorProfit.profit / priorProfit.revenue) * 100) : null,
    compare,
    note: currentProfit.complete === 0 ? "Margin waits until at least one order has amount, resin, and postage." : currentProfit.estimated ? "est. Includes slicer resin estimates where material cost is blank." : costNote,
  });

  const costPer = metric({
    id: "cost-per-order",
    label: "Cost per order",
    formula: "Resin, packaging, and postage on the orders included in gross profit, divided by how many of those orders there are.",
    value: currentProfit.complete > 0 ? round2(currentProfit.cost / currentProfit.complete) : null,
    unit: "usd",
    previous: compare && priorProfit.complete > 0 ? round2(priorProfit.cost / priorProfit.complete) : null,
    compare,
    note: currentProfit.complete === 0 ? "No orders with a complete cost in this period." : currentProfit.estimated ? "est. Includes slicer resin estimates where material cost is blank." : null,
  });

  let cash = 0;
  let cashCount = 0;
  let cashMissing = 0;
  let waiting = 0;
  let waitingCount = 0;
  let waitingMissing = 0;
  let unknownShip = 0;
  let late = 0;
  let oldest: number | null = null;
  const openStages = new Map<string, number>();
  let needsReply = 0;
  for (const order of input.orders) {
    if (!order.open) continue;
    const stage = order.stageLabel || "No stage";
    openStages.set(stage, (openStages.get(stage) ?? 0) + 1);
    if (order.needsReply) needsReply += 1;
    if (order.amount == null) cashMissing += 1;
    else {
      cash = round2(cash + order.amount);
      cashCount += 1;
    }
    const created = parseTime(order.createdAt);
    if (created != null) {
      const age = Math.floor((window.end - created) / 86_400_000);
      oldest = oldest == null ? age : Math.max(oldest, age);
    }
    if (order.shipBy && !order.tentative && order.shipBy < today) late += 1;
    const printComplete = order.resinCost != null;
    const waitingOnLabel = printComplete && order.shipping === "ship" && order.postage == null && !order.hasTracking;
    const waitingOnPickup = printComplete && order.shipping === "pickup";
    if (order.shipping === "unknown") unknownShip += 1;
    if (waitingOnLabel || waitingOnPickup) {
      waitingCount += 1;
      if (order.amount == null) waitingMissing += 1;
      else waiting = round2(waiting + order.amount);
    }
  }

  const cashMetric = metric({
    id: "cash-in-production",
    label: "Cash in production",
    formula: "Sum of amounts on orders that are still open. This is the shop right now, not the selected period.",
    value: cashCount > 0 ? cash : null,
    unit: "usd",
    compare: false,
    note: cashCount === 0 ? "No open orders with an amount." : cashMissing > 0 ? units(cashMissing, "open order missing an amount", "open orders missing an amount") : null,
  });

  const waitingMetric = metric({
    id: "waiting-money",
    label: "Waiting on a label or pickup",
    formula: "Amount of print-complete open ship orders with no postage and no tracking, plus print-complete open pickup orders. Orders with no ship or pickup flag are left out.",
    value: waitingCount > 0 ? waiting : unknownShip > 0 && waitingCount === 0 ? null : 0,
    unit: "usd",
    compare: false,
    note: unknownShip > 0 ? units(unknownShip, "open order with no ship or pickup flag", "open orders with no ship or pickup flag") : waitingMissing > 0 ? units(waitingMissing, "waiting order missing an amount", "waiting orders missing an amount") : null,
  });

  const medianDays = median(currentShipped.days);
  const priorMedian = median(priorShipped.days);
  const speedMedian = metric({
    id: "median-ship-days",
    label: "Median order-to-ship",
    formula: "Median days from created date to close date for won orders closed in the period.",
    value: medianDays,
    unit: "days",
    previous: compare ? priorMedian : null,
    compare,
    note: currentShipped.counted === 0 ? "No won orders closed in the period." : currentShipped.days.length < currentShipped.counted ? units(currentShipped.counted - currentShipped.days.length, "shipped order missing a created date", "shipped orders missing a created date") : null,
  });

  const stageTime = metric({
    id: "stage-time",
    label: "Time in each stage",
    formula: "Would be the time from entering a stage to leaving it.",
    value: null,
    unit: "days",
    compare: false,
    note: "Stage time needs HubSpot stage entry dates, which this sync does not store.",
  });

  const onTime = metric({
    id: "on-time",
    label: "On-time ship rate",
    formula: "Won orders closed in the period whose close date is on or before a firm ship-by date, divided by won orders that have a firm ship-by date. Tentative dates are not included.",
    value: currentShipped.withShipBy > 0 ? round2((currentShipped.onTime / currentShipped.withShipBy) * 100) : null,
    unit: "percent",
    previous: compare && priorShipped.withShipBy > 0 ? round2((priorShipped.onTime / priorShipped.withShipBy) * 100) : null,
    compare,
    note: currentShipped.withShipBy === 0 ? "No shipped orders have a firm ship-by date." : null,
  });

  const lateMetric = metric({
    id: "late-now",
    label: "Late right now",
    formula: "Open orders whose firm ship-by date is before today. Tentative dates are not counted as late.",
    value: late,
    unit: "count",
    compare: false,
    note: null,
  });

  const oldestMetric = metric({
    id: "oldest-open",
    label: "Oldest open order",
    formula: "Days since the oldest open order was created.",
    value: oldest,
    unit: "days",
    compare: false,
    note: oldest == null ? "No open order has a created date." : null,
  });

  const platesIn = (start: number | null, end: number | null) => input.plates.filter((plate) => inWindow(parseTime(plate.attachedAt), start, end));
  const currentPlates = platesIn(window.start, window.end);
  const priorPlates = platesIn(window.previousStart, window.previousEnd);
  const hoursOf = (plates: ShopDashboardPlate[]) => {
    let hours = 0;
    let known = 0;
    let missing = 0;
    for (const plate of plates) {
      if (plate.printTimeSeconds == null) missing += 1;
      else {
        known += 1;
        hours += plate.printTimeSeconds / 3600;
      }
    }
    return { hours: round2(hours), known, missing };
  };
  const resinOf = (plates: ShopDashboardPlate[]) => {
    let ml = 0;
    let usd = 0;
    let mlKnown = 0;
    let usdKnown = 0;
    let mlMissing = 0;
    let usdMissing = 0;
    for (const plate of plates) {
      if (plate.resinVolumeMl == null) mlMissing += 1;
      else {
        mlKnown += 1;
        ml += plate.resinVolumeMl;
      }
      if (plate.resinCost == null) usdMissing += 1;
      else {
        usdKnown += 1;
        usd += plate.resinCost;
      }
    }
    return { ml: round2(ml), usd: round2(usd), mlKnown, usdKnown, mlMissing, usdMissing };
  };
  const currentHours = hoursOf(currentPlates);
  const priorHours = hoursOf(priorPlates);
  const currentResin = resinOf(currentPlates);
  const priorResin = resinOf(priorPlates);

  const platesMetric = metric({
    id: "plates",
    label: "Plates printed",
    formula: "Print records attached in the period.",
    value: currentPlates.length,
    unit: "count",
    previous: compare ? priorPlates.length : null,
    compare,
    note: null,
  });
  const hoursMetric = metric({
    id: "print-hours",
    label: "Print hours from slicer estimates",
    formula: "Sum of slicer-estimated print time on plates attached in the period. Plates with no print time are left out.",
    value: currentHours.known > 0 ? currentHours.hours : currentPlates.length === 0 ? 0 : null,
    unit: "hours",
    previous: compare && priorHours.known > 0 ? priorHours.hours : null,
    compare,
    note: currentHours.missing > 0 ? units(currentHours.missing, "plate missing print time", "plates missing print time") : null,
  });
  const resinMl = metric({
    id: "resin-ml",
    label: "Resin used from slicer estimates",
    formula: "Sum of slicer-estimated resin milliliters on plates attached in the period.",
    value: currentResin.mlKnown > 0 ? currentResin.ml : currentPlates.length === 0 ? 0 : null,
    unit: "ml",
    previous: compare && priorResin.mlKnown > 0 ? priorResin.ml : null,
    compare,
    note: currentResin.mlMissing > 0 ? units(currentResin.mlMissing, "plate missing resin volume", "plates missing resin volume") : null,
  });
  const resinUsd = metric({
    id: "resin-usd",
    label: "Resin cost from slicer estimates",
    formula: "Sum of slicer-estimated resin dollars on plates attached in the period.",
    value: currentResin.usdKnown > 0 ? currentResin.usd : currentPlates.length === 0 ? 0 : null,
    unit: "usd",
    previous: compare && priorResin.usdKnown > 0 ? priorResin.usd : null,
    compare,
    note: currentResin.usdMissing > 0 ? units(currentResin.usdMissing, "plate missing resin cost", "plates missing resin cost") : null,
  });

  const reprint = input.bits.filter((bit) => bit.status === "reprint").length;
  const reprintRate = metric({
    id: "reprint-rate",
    label: "Reprint rate",
    formula: "Bits and order parts marked reprint, divided by all logged bits and parts. This is the current log, not the selected period.",
    value: input.bits.length > 0 ? round2((reprint / input.bits.length) * 100) : null,
    unit: "percent",
    compare: false,
    note: input.bits.length === 0 ? "No bit or part statuses logged." : null,
  });

  const failuresIn = (start: number | null, end: number | null) => input.failures.filter((row) => inWindow(parseTime(row.occurredAt), start, end)).length;
  const failureMetric = metric({
    id: "failures",
    label: "Failures logged",
    formula: "Shop failure log rows whose date falls in the period.",
    value: failuresIn(window.start, window.end),
    unit: "count",
    previous: compare ? failuresIn(window.previousStart, window.previousEnd) : null,
    compare,
    note: null,
  });

  const printerHours = new Map<string, number>();
  for (const plate of currentPlates) {
    if (plate.printTimeSeconds == null) continue;
    const label = printerBucket(plate.printerLabel);
    printerHours.set(label, round2((printerHours.get(label) ?? 0) + plate.printTimeSeconds / 3600));
  }
  const printerRows = Array.from(printerHours.entries())
    .map(([label, hours]) => ({ label, hours }))
    .sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));

  const fep = input.printers.map((printer) => {
    if (!printer.fepChangedAt || printer.hoursSinceFep == null) {
      return { name: printer.name, hours: null, percent: null, note: "No FEP change is logged." };
    }
    const percent = printer.recommendedFepHours && printer.recommendedFepHours > 0 ? round2((printer.hoursSinceFep / printer.recommendedFepHours) * 100) : null;
    return { name: printer.name, hours: round2(printer.hoursSinceFep), percent, note: percent == null ? "Recommended FEP hours are not set." : null };
  });

  const utilization = metric({
    id: "utilization",
    label: "Printer utilization",
    formula: "Print hours divided by hours the printer was available.",
    value: null,
    unit: "percent",
    compare: false,
    note: "Utilization needs scheduled hours, which are not tracked.",
  });

  let supply = 0;
  let supplyCount = 0;
  let priorSupply = 0;
  for (const purchase of input.supplyPurchases) {
    const when = parseTime(purchase.purchasedAt);
    if (inWindow(when, window.start, window.end)) {
      supply = round2(supply + purchase.amount);
      supplyCount += 1;
    } else if (inWindow(when, window.previousStart, window.previousEnd)) priorSupply = round2(priorSupply + purchase.amount);
  }
  const supplyMetric = metric({
    id: "supply-spend",
    label: "Supply receipts",
    formula: "Sum of supply purchases dated in the period. This is shop spending, not subtracted from order profit.",
    value: supply,
    unit: "usd",
    previous: compare ? priorSupply : null,
    compare,
    note: supplyCount === 0 ? "No supply receipts in this period." : null,
  });

  let won = 0;
  let lost = 0;
  let priorWon = 0;
  let priorLost = 0;
  for (const order of input.orders) {
    const closed = parseTime(order.closedAt);
    if (!order.won && !order.lost) continue;
    if (inWindow(closed, window.start, window.end)) {
      if (order.won) won += 1;
      if (order.lost) lost += 1;
    } else if (inWindow(closed, window.previousStart, window.previousEnd)) {
      if (order.won) priorWon += 1;
      if (order.lost) priorLost += 1;
    }
  }
  const winRate = metric({
    id: "win-rate",
    label: "Win rate",
    formula: "Won deals closed in the period divided by won plus lost deals closed in the period.",
    value: won + lost > 0 ? round2((won / (won + lost)) * 100) : null,
    unit: "percent",
    previous: compare && priorWon + priorLost > 0 ? round2((priorWon / (priorWon + priorLost)) * 100) : null,
    compare,
    note: won + lost === 0 ? "No deals closed in this period." : null,
  });

  const newOrders = ordersMetric;
  const needsReplyMetric = metric({
    id: "needs-reply",
    label: "Needs a reply",
    formula: "Open orders with the needs-reply flag set. This is the shop right now.",
    value: needsReply,
    unit: "count",
    compare: false,
    note: null,
  });
  const waitingCustomer = metric({
    id: "awaiting-client",
    label: "Waiting on the customer",
    formula: "Intake links still marked awaiting the client. This is the current queue.",
    value: input.awaitingClient,
    unit: "count",
    compare: false,
    note: null,
  });

  const named = new Map<string, { revenue: number; orders: number; first: number | null }>();
  let unnamed = 0;
  for (const order of input.orders) {
    const created = parseTime(order.createdAt);
    const who = order.customer?.trim() || "";
    if (!who) {
      if (inWindow(created, window.start, window.end)) unnamed += 1;
      continue;
    }
    const row = named.get(who) ?? { revenue: 0, orders: 0, first: null };
    if (created != null) row.first = row.first == null ? created : Math.min(row.first, created);
    if (inWindow(created, window.start, window.end)) {
      row.orders += 1;
      if (order.amount != null) row.revenue = round2(row.revenue + order.amount);
    }
    named.set(who, row);
  }
  let repeatCustomers = 0;
  let periodCustomers = 0;
  for (const row of Array.from(named.values())) {
    if (row.orders < 1) continue;
    periodCustomers += 1;
    const earlier = row.first != null && window.start != null && row.first < window.start;
    if (earlier || row.orders >= 2) repeatCustomers += 1;
  }
  const repeat = metric({
    id: "repeat-rate",
    label: "Repeat customer rate",
    formula: "Customers with an order in the period who also have an earlier order, or more than one order in the period, divided by customers in the period. The customer is the name on the order. Orders with no customer name are left out.",
    value: periodCustomers > 0 ? round2((repeatCustomers / periodCustomers) * 100) : null,
    unit: "percent",
    compare: false,
    note: periodCustomers === 0 ? "No named customers in this period." : unnamed > 0 ? units(unnamed, "order with no customer name", "orders with no customer name") : null,
  });
  const source = metric({
    id: "revenue-by-source",
    label: "Revenue by source",
    formula: "Order amount grouped by Marketplace, MMF, Reddit, direct, or another channel.",
    value: null,
    unit: "usd",
    compare: false,
    note: "Revenue by source needs a channel on each order. Deals do not store Marketplace, MMF, Reddit, or direct.",
  });

  const customers = Array.from(named.entries())
    .filter(([, row]) => row.orders > 0)
    .map(([name, row]) => ({ name, revenue: row.revenue, orders: row.orders }))
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders || a.name.localeCompare(b.name))
    .slice(0, 5);

  const headlines = [revenue, shippedRevenue, profit, margin, ordersMetric, lateMetric];

  return {
    period: {
      id: input.period,
      label: PERIOD_LABEL[input.period],
      compareLabel: input.period === "all" ? "All time is not compared" : input.period === "ytd" ? "vs last year to this date" : `vs the prior ${PERIOD_LABEL[input.period]}`,
    },
    headlines,
    money: [revenue, shippedRevenue, ordersMetric, aov, profit, margin, costPer, cashMetric, waitingMetric, supplyMetric],
    speed: [speedMedian, stageTime, onTime, lateMetric, oldestMetric],
    production: [platesMetric, hoursMetric, resinMl, resinUsd, reprintRate, failureMetric, utilization],
    printers: printerRows,
    fep,
    pipeline: Array.from(openStages.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    customers,
    pipelineMetrics: [newOrders, needsReplyMetric, waitingCustomer, winRate],
    channelMetrics: [source, repeat],
    origins: buildOrderOrigins({
      start: window.start,
      end: window.end,
      zips: input.zips ?? { byZip: new Map(), byCity: new Map() },
      orders: input.orders.map((order) => ({
        id: order.id,
        amount: order.amount,
        createdAt: order.createdAt,
        pickup: order.shipping === "pickup",
        shipTo: order.shipTo ?? null,
      })),
    }),
  };
}
