/**
 * One tracking row per order: production queue, printed, labeled, in transit, delivered.
 * A later stage replaces an earlier one. Stuck means no carrier movement, or an exception.
 */
import type { ProductionQueueItem, ShipmentStatus } from "./schema";

export const TRACKING_STAGES = ["queue", "printed", "labeled", "transit", "delivered"] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];

const STAGE_RANK: Record<TrackingStage, number> = {
  queue: 0,
  printed: 1,
  labeled: 2,
  transit: 3,
  delivered: 4,
};

export const TRACKING_STAGE_LABEL: Record<TrackingStage, string> = {
  queue: "Production queue",
  printed: "Printed",
  labeled: "Labeled",
  transit: "In transit",
  delivered: "Delivered",
};

export interface TrackingShipment {
  id: string;
  dealId: string | null;
  name: string;
  status: ShipmentStatus;
  stale: boolean;
  trackingNumber: string;
  shipDate: string;
  carrierCode: string;
  voided: boolean;
}

export interface TrackingRow {
  key: string;
  dealId: string | null;
  name: string;
  stage: TrackingStage;
  detail: string;
  when: string;
  stuck: boolean;
}

function queueStage(item: ProductionQueueItem): TrackingStage {
  const tracking = item.fulfillment?.trackingNumber?.trim() ?? "";
  if (item.fulfillment?.labelBought || item.fulfillment?.trackingPasted || tracking) {
    return "labeled";
  }
  if (item.bucket === "in_production" || item.bucket === "ship_ready") return "printed";
  return "queue";
}

function shipmentStage(status: ShipmentStatus): TrackingStage {
  if (status === "delivered") return "delivered";
  if (status === "in transit" || status === "out for delivery" || status === "exception") return "transit";
  return "labeled";
}

function prefer(current: TrackingRow, next: TrackingRow): TrackingRow {
  if (STAGE_RANK[next.stage] > STAGE_RANK[current.stage]) return next;
  if (STAGE_RANK[next.stage] === STAGE_RANK[current.stage] && next.stuck) return { ...current, stuck: true, detail: next.detail || current.detail };
  return current;
}

export function buildTrackingRows(queue: ProductionQueueItem[], shipments: TrackingShipment[]): TrackingRow[] {
  const byKey = new Map<string, TrackingRow>();

  for (const item of queue) {
    const stage = queueStage(item);
    byKey.set(`deal:${item.dealId}`, {
      key: `deal:${item.dealId}`,
      dealId: item.dealId,
      name: (item.dealName || "").trim() || "Order",
      stage,
      detail: stage === "labeled" ? item.fulfillment.trackingNumber.trim() || "Label on the order" : item.stage,
      when: item.shipBy,
      stuck: false,
    });
  }

  for (const shipment of shipments) {
    if (shipment.voided) continue;
    const stage = shipmentStage(shipment.status);
    const stuck = shipment.stale || shipment.status === "exception";
    const name = (shipment.name || "").trim() || "Shipment";
    const detail = [shipment.carrierCode, shipment.status, shipment.trackingNumber].filter(Boolean).join(" · ");
    const row: TrackingRow = {
      key: shipment.dealId ? `deal:${shipment.dealId}` : `shipment:${shipment.id}`,
      dealId: shipment.dealId,
      name,
      stage,
      detail,
      when: shipment.shipDate,
      stuck,
    };
    const existing = byKey.get(row.key);
    byKey.set(row.key, existing ? prefer(existing, row) : row);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
    return STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || a.name.localeCompare(b.name);
  });
}
