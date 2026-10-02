/**
 * Read-only ShipStation shipment ingestion. Webhook delivery only stores and
 * displays shipment state; it deliberately never updates HubSpot or notifies a buyer.
 */
import { getShipEngineApiKey } from "./shipengine";
import { getSqlite } from "./order-links";
import { normalizeTrackingNumber } from "./fulfillment";
import type { ShipmentStatus, ShipstationShipmentView } from "../../shared/schema";

const SHIPSTATION_BASE = "https://ssapi.shipstation.com";

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
  voided: boolean;
  status?: ShipmentStatus;
  lastEventAt?: string | null;
};

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const iso = () => new Date().toISOString();

export function shipstationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SHIPSTATION_API_KEY?.trim() && env.SHIPSTATION_API_SECRET?.trim());
}

export function mapShipmentStatus(value: unknown): ShipmentStatus {
  const status = text(value).toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(delivered|delivery complete)\b/.test(status)) return "delivered";
  if (/\b(out\s*for\s*delivery|outfordelivery)\b/.test(status)) return "out for delivery";
  if (/\b(exception|failed|return to sender|undeliverable)\b/.test(status)) return "exception";
  if (/\b(in transit|intransit|accepted|picked up)\b/.test(status)) return "in transit";
  return "label created";
}

function money(value: unknown): string {
  const candidate = typeof value === "object" && value ? (value as RecordLike).amount : value;
  const n = Number(candidate);
  return Number.isFinite(n) ? n.toFixed(2) : text(candidate);
}

export function mapShipstationShipment(raw: RecordLike): IncomingShipment | null {
  const shipmentId = text(raw.shipmentId ?? raw.shipment_id);
  if (!shipmentId) return null;
  const shipTo = (raw.shipTo ?? raw.ship_to ?? {}) as RecordLike;
  const statusRaw = raw.shipmentStatus ?? raw.shipment_status ?? raw.status ?? raw.trackingStatus;
  const eventAt = text(raw.deliveryDate ?? raw.delivery_date ?? raw.lastEventDate ?? raw.last_event_at);
  return {
    shipmentId,
    orderNumber: text(raw.orderNumber ?? raw.order_number),
    shipToName: text(shipTo.name ?? raw.shipToName ?? raw.ship_to_name),
    carrierCode: text(raw.carrierCode ?? raw.carrier_code),
    serviceCode: text(raw.serviceCode ?? raw.service_code),
    trackingNumber: text(raw.trackingNumber ?? raw.tracking_number),
    shipDate: text(raw.shipDate ?? raw.ship_date ?? raw.createDate ?? raw.create_date),
    shipmentCost: money(raw.shipmentCost ?? raw.shipment_cost ?? raw.cost),
    voided: Boolean(raw.voided ?? raw.void),
    status: statusRaw == null ? undefined : mapShipmentStatus(statusRaw),
    lastEventAt: eventAt || null,
  };
}

function allowedResourceUrl(resourceUrl: string, env: NodeJS.ProcessEnv): string {
  const url = new URL(resourceUrl);
  const configured = new URL(env.SHIPSTATION_API_BASE?.trim() || SHIPSTATION_BASE);
  if (url.protocol !== "https:" && !/^127\.0\.0\.1$|^localhost$/i.test(url.hostname)) {
    throw new Error("ShipStation resource URL must use HTTPS");
  }
  if (url.host !== configured.host && url.host !== "ssapi.shipstation.com") {
    throw new Error("ShipStation resource URL host is not allowed");
  }
  return url.toString();
}

async function shipstationRequest(pathOrUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const key = env.SHIPSTATION_API_KEY?.trim() || "";
  const secret = env.SHIPSTATION_API_SECRET?.trim() || "";
  if (!key || !secret) throw new Error("ShipStation API credentials are not configured");
  const base = env.SHIPSTATION_API_BASE?.trim() || SHIPSTATION_BASE;
  const url = /^https?:\/\//i.test(pathOrUrl) ? allowedResourceUrl(pathOrUrl, env) : new URL(pathOrUrl, base).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ShipStation ${response.status}: ${response.statusText}`);
  return response.json();
}

export async function fetchShipstationResource(resourceUrl: string, env?: NodeJS.ProcessEnv): Promise<IncomingShipment[]> {
  const body = await shipstationRequest(resourceUrl, env);
  const rows = Array.isArray((body as RecordLike)?.shipments)
    ? ((body as RecordLike).shipments as unknown[])
    : Array.isArray(body) ? body : [body];
  return rows.flatMap((row) => (row && typeof row === "object" ? [mapShipstationShipment(row as RecordLike)].filter(Boolean) : [])) as IncomingShipment[];
}

export async function fetchShipstationShipments(days: number, env?: NodeJS.ProcessEnv): Promise<IncomingShipment[]> {
  const start = new Date(Date.now() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString().slice(0, 10);
  const body = await shipstationRequest(`/shipments?shipDateStart=${encodeURIComponent(start)}&pageSize=500`, env);
  const rows = Array.isArray((body as RecordLike)?.shipments) ? ((body as RecordLike).shipments as unknown[]) : [];
  return rows.flatMap((row) => (row && typeof row === "object" ? [mapShipstationShipment(row as RecordLike)].filter(Boolean) : [])) as IncomingShipment[];
}

export function upsertShipstationShipment(input: IncomingShipment, match: ShipmentMatch = null): void {
  const db = getSqlite();
  const now = iso();
  const existing = db.prepare("SELECT created_at, status, last_event_at, matched_deal_id, matched_deal_name FROM shipstation_shipments WHERE shipment_id = ?").get(input.shipmentId) as RecordLike | undefined;
  db.prepare(`
    INSERT INTO shipstation_shipments (
      shipment_id, order_number, ship_to_name, carrier_code, service_code, tracking_number, ship_date, shipment_cost,
      voided, status, last_event_at, matched_deal_id, matched_deal_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shipment_id) DO UPDATE SET
      order_number=excluded.order_number, ship_to_name=excluded.ship_to_name, carrier_code=excluded.carrier_code,
      service_code=excluded.service_code, tracking_number=excluded.tracking_number, ship_date=excluded.ship_date,
      shipment_cost=excluded.shipment_cost, voided=excluded.voided, status=excluded.status,
      last_event_at=excluded.last_event_at, matched_deal_id=excluded.matched_deal_id,
      matched_deal_name=excluded.matched_deal_name, updated_at=excluded.updated_at
  `).run(
    input.shipmentId, input.orderNumber, input.shipToName, input.carrierCode, input.serviceCode, input.trackingNumber,
    input.shipDate, input.shipmentCost, input.voided ? 1 : 0, input.status ?? (text(existing?.status) || "label created"),
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

/** ShipEngine tracking is optional; only known statuses are persisted. */
export async function refreshShipstationTracking(): Promise<void> {
  const key = getShipEngineApiKey();
  if (!key) return;
  const candidates = listShipstationShipments().filter((row) => !row.voided && row.status !== "delivered" && row.shipDate && Date.now() - new Date(row.shipDate).getTime() < 30 * 86_400_000);
  for (const shipment of candidates) {
    if (!shipment.trackingNumber) continue;
    try {
      const query = new URLSearchParams({ tracking_number: shipment.trackingNumber, carrier_code: shipment.carrierCode });
      const response = await fetch(`https://api.shipengine.com/v1/tracking?${query}`, { headers: { "API-Key": key, Accept: "application/json" } });
      if (!response.ok) continue;
      const body = await response.json() as RecordLike;
      const status = mapShipmentStatus(body.status ?? body.status_code);
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

export function startShipstationTrackingSchedule(): void {
  void refreshShipstationTracking();
  setInterval(() => void refreshShipstationTracking(), 2 * 60 * 60 * 1000).unref();
}
