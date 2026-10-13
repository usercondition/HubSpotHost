import { hubspotStageLooksShipReady, type ProductionQueueItem, type ProductionQueueResponse } from "@shared/schema";
import { isPostProcessStageLabel } from "@shared/priority-stack";
import { shipByAgendaBucket, type ShipByAgendaBucket } from "@shared/ship-by";

/** Physical shop loop. Mapped from HubSpot stage labels + production-queue buckets. */
export const WORKSHOP_STATIONS = [
  { id: "intake", label: "Intake", hint: "Desk" },
  { id: "print", label: "Print", hint: "Bench" },
  { id: "wash", label: "Wash & Cure", hint: "Station" },
  { id: "qa", label: "QA", hint: "Table" },
  { id: "pack", label: "Pack & Ship", hint: "Shelf" },
] as const;

export type WorkshopStationId = (typeof WORKSHOP_STATIONS)[number]["id"];

export type WorkshopStationInput = {
  stage: string | null | undefined;
  bucket: ProductionQueueItem["bucket"];
  hasPlates: boolean;
  requiresPlates?: boolean;
};

/**
 * Place an open order on the workshop loop.
 * Stage ids are HubSpot-defined and not hardcoded; labels + queue buckets decide the station.
 */
export function workshopStationForOrder(input: WorkshopStationInput): WorkshopStationId {
  const stage = String(input.stage ?? "");
  const value = stage.toLowerCase();

  if (input.bucket === "ship_ready" || hubspotStageLooksShipReady(stage)) return "pack";
  if (/\b(shipped|picked up)\b/.test(value)) return "pack";
  if (/\b(ship|label|pack|fulfill)\b/.test(value) && !isPostProcessStageLabel(stage)) return "pack";

  const wash = /\b(wash(?:ing)?|cur(?:e|ing))\b/.test(value);
  const qa = /\b(qc|quality control|inspection)\b/.test(value);
  if (qa && !wash) return "qa";
  if (wash) return "wash";
  if (/\bpost[\s-]?process/.test(value)) return "qa";

  if (input.bucket === "in_production") return "print";
  if (/\bprint/.test(value) && !/\bqueue/.test(value)) return "print";
  if (input.bucket === "next_print" && input.hasPlates) return "print";

  return "intake";
}

export function collectWorkshopOrders(queue: Pick<
  ProductionQueueResponse,
  "nextPrint" | "inProduction" | "shipReady" | "blocked"
>): ProductionQueueItem[] {
  const seen = new Set<string>();
  const out: ProductionQueueItem[] = [];
  for (const item of [...queue.nextPrint, ...queue.inProduction, ...queue.shipReady, ...queue.blocked]) {
    if (seen.has(item.dealId)) continue;
    seen.add(item.dealId);
    out.push(item);
  }
  return out;
}

export function groupOrdersByStation(orders: ProductionQueueItem[]): Record<WorkshopStationId, ProductionQueueItem[]> {
  const groups: Record<WorkshopStationId, ProductionQueueItem[]> = {
    intake: [],
    print: [],
    wash: [],
    qa: [],
    pack: [],
  };
  for (const order of orders) {
    groups[workshopStationForOrder(order)].push(order);
  }
  return groups;
}

export function printersAreRunning(orders: ProductionQueueItem[]): boolean {
  return orders.some((order) => workshopStationForOrder(order) === "print" && order.bucket === "in_production");
}

export function countDueThisWeek(orders: ProductionQueueItem[], today: string): number {
  return orders.filter((order) => {
    const bucket: ShipByAgendaBucket | "skip" = /^\d{4}-\d{2}-\d{2}$/.test(order.shipBy)
      ? shipByAgendaBucket(order.shipBy, today)
      : "skip";
    return bucket === "overdue" || bucket === "due_today" || bucket === "this_week";
  }).length;
}

export function printerStatusLabel(input: {
  printers: Array<{ status: string }>;
  printing: boolean;
}): string {
  const active = input.printers.filter((printer) => printer.status === "active").length;
  if (input.printing && active > 0) return `${active} printing`;
  if (active > 0) return `${active} ready`;
  if (input.printers.length > 0) return "Fleet idle";
  return "No printers";
}
