/**
 * Load the records the shop dashboard is allowed to count.
 * HubSpot is read-only here. Off-book rows stay in Print Ops.
 */
import { desc } from "drizzle-orm";
import { dealRequiresPlates, printFileRecords } from "../../shared/schema";
import type { ShipToFields } from "../../shared/order-origins";
import {
  buildShopDashboard,
  type ShopDashboard,
  type ShopDashboardInput,
  type ShopDashboardOrder,
  type ShopPeriodId,
} from "../../shared/shop-dashboard";
import type { HubSpotDealRecord, HubSpotPipelineStage } from "./hubspot";
import { getDb, getSqlite, orderLinkCounts } from "./order-links";
import { ensureDefaultPrinters, listPrinterLifecycleEvents, listPrinterProfileMaps, resolvePrinterIdForRecord } from "./printers";
import { loadUsZipCentroids } from "./zip-centroids";

function numberOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function truthy(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

function stageClosed(stage: HubSpotPipelineStage | undefined): boolean {
  const value = stage?.metadata?.isClosed;
  return value === true || value === "true";
}

function customerFromName(name: string): string | null {
  const index = name.lastIndexOf(" - ");
  if (index < 0) return null;
  const customer = name.slice(index + 3).trim();
  return customer.length >= 2 ? customer : null;
}

function day(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match?.[1] ?? null;
}

/** Material field is actual; same-file reprints never duplicate slicer fallback. */
export function selectDashboardResinCost(material: string | null | undefined, plates: Array<{ sha256: string; resinCost: string | null }>) {
  const entered = numberOrNull(material);
  if (entered != null) return { cost: entered, estimated: false };
  const hashes = new Set<string>(); let total = 0; let any = false;
  for (const plate of plates) {
    if (hashes.has(plate.sha256)) continue;
    hashes.add(plate.sha256);
    const cost = numberOrNull(plate.resinCost);
    if (cost != null) { total += cost; any = true; }
  }
  return { cost: any ? Math.round((total + Number.EPSILON) * 100) / 100 : null, estimated: any };
}

export function collectShopDashboard(input: {
  deals: HubSpotDealRecord[];
  stages: HubSpotPipelineStage[];
  period: ShopPeriodId;
  now?: Date;
  shipTos?: Map<string, ShipToFields>;
  mapIncomplete?: boolean;
  overheadCents?: number;
  mapBusy?: boolean;
}): ShopDashboard {
  const now = input.now ?? new Date();
  const stageById = new Map(input.stages.map((stage) => [stage.id, stage]));
  const sqlite = getSqlite();
  const plates = getDb().select().from(printFileRecords).orderBy(desc(printFileRecords.attachedAt)).all();
  const resinByDeal = new Map<string, { cost: number; any: boolean }>();
  const seenPlateFingerprints = new Set<string>();
  for (const plate of plates) {
    const cost = numberOrNull(plate.resinCost);
    const fingerprint = `${plate.hubspotDealId}:${plate.sha256}`;
    if (seenPlateFingerprints.has(fingerprint)) continue;
    seenPlateFingerprints.add(fingerprint);
    const row = resinByDeal.get(plate.hubspotDealId) ?? { cost: 0, any: false };
    if (cost != null) {
      row.cost += cost;
      row.any = true;
    }
    resinByDeal.set(plate.hubspotDealId, row);
  }

  const stackRows = sqlite
    .prepare(
      `SELECT id, kind, hubspot_deal_id, title, contact_name, amount, target_date, fulfillment_mode, tentative, done_at, created_at
       FROM priority_stack_entries`,
    )
    .all() as Array<{
    id: number;
    kind: string;
    hubspot_deal_id: string | null;
    title: string;
    contact_name: string;
    amount: string;
    target_date: string | null;
    fulfillment_mode: string;
    tentative: number;
    done_at: string | null;
    created_at: string;
  }>;
  const stackByDeal = new Map(stackRows.filter((row) => row.kind === "deal" && row.hubspot_deal_id).map((row) => [row.hubspot_deal_id as string, row]));

  const intakeRows = sqlite
    .prepare(`SELECT hubspot_deal_id, shipping_required FROM order_intake_links WHERE hubspot_deal_id IS NOT NULL AND hubspot_deal_id != ''`)
    .all() as Array<{ hubspot_deal_id: string; shipping_required: number }>;
  const intakeShip = new Map(intakeRows.map((row) => [row.hubspot_deal_id, row.shipping_required !== 0]));

  const orders: ShopDashboardOrder[] = [];
  for (const deal of input.deals) {
    const props = deal.properties;
    if (!dealRequiresPlates(props)) continue;
    const stage = stageById.get(props.dealstage ?? "");
    const label = stage?.label ?? "";
    const won = truthy(props.hs_is_closed_won) || /completed|closed\s*won|shipped|out the door/i.test(label);
    const lost = /lost/i.test(label) && !won;
    const closed = stageClosed(stage) || truthy(props.hs_is_closed) || won || lost;
    const stack = stackByDeal.get(deal.id);
    const postage = numberOrNull(props.print_actual_shipping_cost);
    const packagingEntered = numberOrNull(props.print_packaging_cost);
    const plateResin = resinByDeal.get(deal.id);
    const material = numberOrNull(props.print_material_cost);
    const shipping = stack
      ? stack.fulfillment_mode === "pickup"
        ? "pickup"
        : "ship"
      : intakeShip.has(deal.id)
        ? intakeShip.get(deal.id)
          ? "ship"
          : "pickup"
        : "unknown";
    const name = props.dealname?.trim() || `Deal ${deal.id}`;
    orders.push({
      id: deal.id,
      name,
      customer: customerFromName(name),
      createdAt: props.createdate,
      closedAt: props.closedate,
      open: !closed,
      won: closed && won,
      lost,
      stageLabel: stage?.label || "No stage",
      amount: numberOrNull(props.amount),
      // Entered material cost is actual; slicer totals are a fallback only.
      resinCost: material ?? (plateResin?.any ? Math.round((plateResin.cost + Number.EPSILON) * 100) / 100 : null),
      materialEstimated: material == null && plateResin?.any === true,
      postage: shipping === "pickup" ? (postage ?? 0) : postage,
      packaging: packagingEntered ?? 0,
      shipBy: day(stack?.target_date) || day(props.print_ship_by) || day(props.ship_by_date),
      tentative: stack?.tentative === 1,
      needsReply: truthy(props.print_needs_reply),
      shipping,
      hasTracking: Boolean(String(props.print_tracking_number ?? "").trim()),
      shipTo: input.shipTos?.get(deal.id) ?? null,
    });
  }

  for (const row of stackRows) {
    if (row.kind !== "offbook" || row.hubspot_deal_id) continue;
    const done = Boolean(row.done_at);
    orders.push({
      id: `offbook:${row.id}`,
      name: row.title || "Off-book",
      customer: row.contact_name.trim() || null,
      createdAt: row.created_at,
      closedAt: row.done_at,
      open: !done,
      won: done,
      lost: false,
      stageLabel: "Off-book",
      amount: numberOrNull(row.amount),
      resinCost: null,
      postage: row.fulfillment_mode === "pickup" ? 0 : null,
      packaging: 0,
      shipBy: day(row.target_date),
      tentative: row.tentative === 1,
      needsReply: false,
      shipping: row.fulfillment_mode === "pickup" ? "pickup" : "ship",
      hasTracking: false,
    });
  }

  const fleet = ensureDefaultPrinters();
  const profileMaps = listPrinterProfileMaps();
  const dashboardPlates = plates.map((plate) => {
    const printerId = resolvePrinterIdForRecord(plate, fleet, profileMaps);
    const printer = fleet.find((item) => item.id === printerId);
    return {
      attachedAt: plate.attachedAt,
      printTimeSeconds: plate.printTimeSeconds,
      resinVolumeMl: numberOrNull(plate.resinVolumeMl),
      resinCost: numberOrNull(plate.resinCost),
      printerLabel: printer ? `${printer.model} ${printer.name}` : plate.printerProfile || "",
    };
  });

  const bits = sqlite.prepare(`SELECT status FROM print_plate_bits UNION ALL SELECT status FROM order_parts`).all() as Array<{ status: string }>;
  const failures = sqlite.prepare(`SELECT occurred_at FROM production_failures`).all() as Array<{ occurred_at: string }>;
  const purchases = sqlite.prepare(`SELECT purchased_at, total_amount FROM supply_purchases`).all() as Array<{ purchased_at: string; total_amount: string }>;

  const printers = fleet.map((printer) => {
    const events = listPrinterLifecycleEvents(printer.id);
    const changed = events.find((event) => event.eventType === "fep_replaced");
    let hoursSinceFep: number | null = null;
    if (changed) {
      const since = new Date(changed.occurredAt).getTime();
      let seconds = 0;
      for (const plate of plates) {
        const printerId = resolvePrinterIdForRecord(plate, fleet, profileMaps);
        if (printerId !== printer.id || plate.printTimeSeconds == null) continue;
        if (new Date(plate.attachedAt).getTime() < since) continue;
        seconds += plate.printTimeSeconds;
      }
      hoursSinceFep = Math.round((seconds / 3600) * 100) / 100;
    }
    return {
      name: printer.name,
      model: printer.model,
      fepChangedAt: changed?.occurredAt ?? null,
      hoursSinceFep,
      recommendedFepHours: numberOrNull(printer.recommendedFepHours),
    };
  });

  const facts: ShopDashboardInput = {
    now: now.toISOString(),
    period: input.period,
    orders,
    plates: dashboardPlates,
    bits,
    failures: failures.map((row) => ({ occurredAt: row.occurred_at })),
    printers,
    supplyPurchases: purchases
      .map((row) => ({ purchasedAt: row.purchased_at, amount: numberOrNull(row.total_amount) }))
      .filter((row): row is { purchasedAt: string; amount: number } => row.amount != null),
    awaitingClient: orderLinkCounts().awaiting_client,
    zips: loadUsZipCentroids(),
  };
  const dashboard = buildShopDashboard(facts);
  const gross = dashboard.money.find((item) => item.id === "gross-profit")?.value;
  const overhead = input.overheadCents == null ? null : input.overheadCents / 100;
  dashboard.money.push(
    { id: "overhead", label: "Overhead", formula: "Recurring shop overhead prorated by days in this period, plus one-off and usage charges dated in the period.", value: overhead, unit: "usd", previous: null, compare: false, note: null, series: [] },
    { id: "net-profit", label: "Net profit after overhead", formula: "Gross profit minus the same selected-period overhead. An order cost and overhead charge are each counted once.", value: gross == null || overhead == null ? null : Math.round((gross - overhead) * 100) / 100, unit: "usd", previous: null, compare: false, note: gross == null ? "Gross profit is not available for this period." : null, series: [] },
  );
  dashboard.origins.incomplete = input.mapIncomplete === true;
  dashboard.origins.busy = input.mapBusy === true;
  return dashboard;
}

export type { ShopDashboard };
