/**
 * Read-only ShipStation shipment ingestion. Webhook delivery only stores and
 * displays shipment state; it deliberately never updates HubSpot or notifies a buyer.
 */
import { getSqlite } from "./order-links";
import { normalizeTrackingNumber } from "./fulfillment";
import type { ShipmentStatus, ShipstationShipmentView } from "../../shared/schema";

const SHIPSTATION_BASE = "https://api.shipstation.com";

type RecordLike = Record<string, unknown>;
export type ShipmentMatch = { dealId: string; dealName: string } | null;
export type IncomingShipment = {
  shipmentId: string;
  orderNumber: string;
  shipToName: string;
  carrierCode: string;
  serviceCode: string;
  trackingNumber: string;
  shipDate: string;
  shipmentCost: string;
  voided?: boolean;
  status?: ShipmentStatus;
  lastEventAt?: string | null;
};

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const iso = () => new Date().toISOString();

export function shipstationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SHIPSTATION_API_KEY?.trim());
}

export function mapShipmentStatus(value: unknown): ShipmentStatus {
  const code = text(value).toUpperCase();
  if (code === "DE" || code === "SP") return "delivered";
  if (code === "IT" || code === "AC" || code === "AT") return "in transit";
  if (code === "EX") return "exception";
  if (code === "NY" || code === "UN") return "label created";
  const status = text(value).toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(delivered|delivery complete)\b/.test(status)) return "delivered";
  if (/\b(out\s*for\s*delivery|outfordelivery)\b/.test(status)) return "out for delivery";
  if (/\b(exception|failed|return to sender|undeliverable)\b/.test(status)) return "exception";
  if (/\b(in transit|intransit|accepted|picked up|delivery attempt)\b/.test(status)) return "in transit";
  if (/\b(unknown|error|not yet in system)\b/.test(status)) return "label created";
  return "label created";
}

function money(value: unknown): string {
  const candidate = typeof value === "object" && value ? (value as RecordLike).amount : value;
  const n = Number(candidate);
  return Number.isFinite(n) ? n.toFixed(2) : text(candidate);
}

export function mapShipstationShipment(raw: RecordLike): IncomingShipment | null {
  const shipmentId = text(raw.label_id ?? raw.labelId ?? raw.shipment_id ?? raw.shipmentId);
  if (!shipmentId) return null;
  const shipTo = (raw.ship_to ?? raw.shipTo ?? {}) as RecordLike;
  const statusRaw = raw.tracking_status ?? raw.trackingStatus ?? raw.status ?? raw.status_code;
  const eventAt = text(raw.last_event_at ?? raw.lastEventDate ?? raw.delivery_date ?? raw.deliveryDate ?? raw.created_at);
  return {
    shipmentId,
    orderNumber: text(raw.order_number ?? raw.orderNumber ?? raw.external_shipment_id),
    shipToName: text(shipTo.name ?? raw.ship_to_name ?? raw.shipToName),
    carrierCode: text(raw.carrier_code ?? raw.carrierCode),
    serviceCode: text(raw.service_code ?? raw.serviceCode),
    trackingNumber: text(raw.tracking_number ?? raw.trackingNumber),
    shipDate: text(raw.created_at ?? raw.createDate ?? raw.ship_date ?? raw.shipDate),
    shipmentCost: money(raw.shipment_cost ?? raw.shipmentCost ?? raw.cost),
    voided: Boolean(raw.voided ?? raw.void),
    status: statusRaw == null ? undefined : mapShipmentStatus(statusRaw),
    lastEventAt: eventAt || null,
  };
}

async function shipstationRequest(path: string, init: RequestInit = {}, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const key = env.SHIPSTATION_API_KEY?.trim() || "";
  if (!key) throw new Error("ShipStation API key is not configured");
  const base = env.SHIPSTATION_API_BASE?.trim() || SHIPSTATION_BASE;
  const urlObject = new URL(path, base);
  if (/^https?:\/\//i.test(path) && (urlObject.protocol !== "https:" || urlObject.hostname !== "api.shipstation.com")) {
    throw new Error("ShipStation resource URL host is not allowed");
  }
  const url = urlObject.toString();
  const response = await fetch(url, {
    ...init,
    headers: { "API-Key": key, Accept: "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`ShipStation ${response.status}: ${response.statusText}`);
  return response.json();
}

/** Fetch a v2 webhook resource only from ShipStation's documented API host. */
export async function fetchShipstationResource(resourceUrl: string, env?: NodeJS.ProcessEnv): Promise<IncomingShipment[]> {
  const body = await shipstationRequest(resourceUrl, {}, env);
  const rows = Array.isArray((body as RecordLike)?.labels)
    ? (body as RecordLike).labels as unknown[]
    : [body];
  return rows.flatMap((row) => row && typeof row === "object" ? [mapShipstationShipment(row as RecordLike)].filter(Boolean) : []) as IncomingShipment[];
}

export async function fetchShipstationShipments(days: number, env?: NodeJS.ProcessEnv): Promise<IncomingShipment[]> {
  const start = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString().slice(0, 10);
  const shipments: IncomingShipment[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await shipstationRequest(`/v2/labels?created_at_start=${encodeURIComponent(start)}&page=${page}&page_size=500&sort_dir=desc`, {}, env) as RecordLike;
    const rows = Array.isArray(body.labels) ? body.labels : Array.isArray(body.data) ? body.data : [];
    shipments.push(...rows.flatMap((row) => row && typeof row === "object" ? [mapShipstationShipment(row as RecordLike)].filter(Boolean) : []) as IncomingShipment[]);
    const pages = Number(body.pages ?? body.total_pages ?? 1);
    if (!rows.length || !Number.isFinite(pages) || page >= pages) break;
  }
  return shipments;
}

export function upsertShipstationShipment(input: IncomingShipment, match: ShipmentMatch = null): void {
  const db = getSqlite();
  const now = iso();
  const existing = db.prepare("SELECT * FROM shipstation_shipments WHERE shipment_id = ? OR (? <> '' AND tracking_number = ?) LIMIT 1").get(input.shipmentId, input.trackingNumber, input.trackingNumber) as RecordLike | undefined;
  const shipmentId = text(existing?.shipment_id) || input.shipmentId;
  db.prepare(`
    INSERT INTO shipstation_shipments (
      shipment_id, order_number, ship_to_name, carrier_code, service_code, tracking_number, ship_date, shipment_cost,
      voided, status, last_event_at, matched_deal_id, matched_deal_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shipment_id) DO UPDATE SET
      shipment_cost=COALESCE(NULLIF(excluded.shipment_cost, ''), shipment_cost),
      order_number=COALESCE(NULLIF(excluded.order_number, ''), order_number),
      ship_to_name=COALESCE(NULLIF(excluded.ship_to_name, ''), ship_to_name),
      carrier_code=COALESCE(NULLIF(excluded.carrier_code, ''), carrier_code),
      service_code=COALESCE(NULLIF(excluded.service_code, ''), service_code),
      tracking_number=COALESCE(NULLIF(excluded.tracking_number, ''), tracking_number),
      ship_date=COALESCE(NULLIF(excluded.ship_date, ''), ship_date),
      voided=excluded.voided, status=excluded.status,
      last_event_at=excluded.last_event_at, matched_deal_id=excluded.matched_deal_id,
      matched_deal_name=excluded.matched_deal_name, updated_at=excluded.updated_at
  `).run(
    shipmentId, input.orderNumber, input.shipToName, input.carrierCode, input.serviceCode, input.trackingNumber,
    input.shipDate, input.shipmentCost, input.voided === undefined ? Boolean(existing?.voided) ? 1 : 0 : input.voided ? 1 : 0, input.status ?? (text(existing?.status) || "label created"),
    input.lastEventAt ?? (text(existing?.last_event_at) || null), match?.dealId ?? (text(existing?.matched_deal_id) || null),
    match?.dealName ?? (text(existing?.matched_deal_name) || null), text(existing?.created_at) || now, now,
  );
}

export function listShipstationShipments(): ShipstationShipmentView[] {
  const rows = getSqlite().prepare("SELECT * FROM shipstation_shipments ORDER BY ship_date DESC, created_at DESC").all() as Array<RecordLike>;
  const now = Date.now();
  return rows.map((row) => {
    const status = mapShipmentStatus(row.status);
    const last = text(row.last_event_at) || text(row.ship_date) || text(row.created_at);
    const stale = status !== "delivered" && status !== "exception" && Boolean(last) && now - new Date(last).getTime() >= 4 * 86_400_000;
    return {
      shipmentId: text(row.shipment_id), orderNumber: text(row.order_number), shipToName: text(row.ship_to_name),
      carrierCode: text(row.carrier_code), serviceCode: text(row.service_code), trackingNumber: text(row.tracking_number),
      shipDate: text(row.ship_date), shipmentCost: text(row.shipment_cost), voided: Boolean(row.voided), status,
      lastEventAt: text(row.last_event_at) || null, matchedDealId: text(row.matched_deal_id) || null,
      matchedDealName: text(row.matched_deal_name) || null, createdAt: text(row.created_at), updatedAt: text(row.updated_at),
      trackingUrl: trackingUrl(text(row.carrier_code), text(row.tracking_number)), stale,
    };
  });
}

export function trackingUrl(carrier: string, tracking: string): string | null {
  if (!tracking) return null;
  const code = carrier.toLowerCase();
  const value = encodeURIComponent(tracking);
  if (/ups/.test(code)) return `https://www.ups.com/track?tracknum=${value}`;
  if (/fedex/.test(code)) return `https://www.fedex.com/fedextrack/?trknbr=${value}`;
  if (/usps|stamps/.test(code)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${carrier} tracking ${tracking}`)}`;
}

/** ShipStation v2 tracking refresh for recent non-delivered labels. */
export async function refreshShipstationTracking(): Promise<void> {
  if (!shipstationConfigured()) return;
  const candidates = listShipstationShipments().filter((row) => !row.voided && row.status !== "delivered" && row.shipDate && Date.now() - new Date(row.shipDate).getTime() < 30 * 86_400_000);
  for (const shipment of candidates) {
    if (!shipment.trackingNumber) continue;
    try {
      const body = await shipstationRequest(`/v2/labels/${encodeURIComponent(shipment.shipmentId)}/track`) as RecordLike;
      const status = mapShipmentStatus(body.tracking_status ?? body.status_code ?? body.status);
      const lastEventRow = body.last_event && typeof body.last_event === "object" ? body.last_event as RecordLike : {};
      const events = Array.isArray(body.events) ? body.events : [];
      const lastArrayEvent = events.at(-1) && typeof events.at(-1) === "object" ? events.at(-1) as RecordLike : {};
      const lastEvent = text(lastEventRow.occurred_at ?? body.last_event_at ?? lastArrayEvent.occurred_at) || null;
      getSqlite().prepare("UPDATE shipstation_shipments SET status=?, last_event_at=COALESCE(?, last_event_at), updated_at=? WHERE shipment_id=?").run(status, lastEvent, iso(), shipment.shipmentId);
    } catch {
      // Tracking must never make webhook ingestion fail.
    }
  }
}

export function mapTrackWebhook(payload: RecordLike): IncomingShipment | null {
  const tracking = text(payload.tracking_number);
  if (!tracking) return null;
  const events = Array.isArray(payload.events) ? payload.events : [];
  const event = events.at(-1) && typeof events.at(-1) === "object" ? events.at(-1) as RecordLike : {};
  return {
    shipmentId: text(payload.label_id) || `tracking:${normalizeTrackingNumber(tracking)}`,
    orderNumber: text(payload.order_number),
    shipToName: text(payload.ship_to_name),
    carrierCode: text(payload.carrier_code),
    serviceCode: text(payload.service_code),
    trackingNumber: tracking,
    shipDate: text(payload.created_at),
    shipmentCost: money(payload.shipment_cost),
    voided: payload.voided === undefined ? undefined : Boolean(payload.voided),
    status: mapShipmentStatus(payload.status_code ?? payload.status_description),
    lastEventAt: text(event.occurred_at ?? event.event_date ?? payload.event_date) || null,
  };
}

export async function registerShipstationWebhooks(url: string): Promise<{ created: string[]; existing: string[] }> {
  const list = await shipstationRequest("/v2/environment/webhooks") as RecordLike;
  const webhooks = Array.isArray(list.webhooks) ? list.webhooks as RecordLike[] : Array.isArray(list) ? list as RecordLike[] : [];
  const created: string[] = [];
  const existing: string[] = [];
  for (const event of ["track_event_v2", "label_created_v2"]) {
    if (webhooks.some((hook) => text(hook.url) === url && text(hook.event) === event)) {
      existing.push(event);
      continue;
    }
    await shipstationRequest("/v2/environment/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Print Ops ${event}`, url, event }),
    });
    created.push(event);
  }
  return { created, existing };
}

export function startShipstationTrackingSchedule(): void {
  void refreshShipstationTracking();
  setInterval(() => void refreshShipstationTracking(), 2 * 60 * 60 * 1000).unref();
}
