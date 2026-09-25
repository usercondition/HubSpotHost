/**
 * Webhook payload interpretation.
 *
 * HubSpot posts an array of event objects. Field naming varies across event
 * sources, so deal identification and property naming are handled defensively.
 * Only changes to the five input properties are actionable — output property
 * events are ignored so writes never feed back into themselves.
 */
import { INPUT_PROPERTIES, OUTPUT_PROPERTIES } from "./config";

const INPUT_SET = new Set<string>(INPUT_PROPERTIES);
const OUTPUT_SET = new Set<string>(OUTPUT_PROPERTIES);

/**
 * Subscriptions this handler acts on. Anything else is stored and ignored.
 * Output profit fields are omitted on purpose so a write cannot loop.
 */
export const HUBSPOT_WEBHOOK_SUBSCRIPTIONS = [
  "deal.propertyChange: amount",
  "deal.propertyChange: print_material_cost",
  "deal.propertyChange: print_labor_cost",
  "deal.propertyChange: print_packaging_cost",
  "deal.propertyChange: print_actual_shipping_cost",
  "deal.propertyChange: dealstage",
  "deal.creation",
  "deal.deletion",
] as const;

export interface EventSummary {
  /** De-duplicated deal ids that need recalculation. */
  dealIds: string[];
  /** Deal created, deleted, or moved to another stage. Bust the deals cache. */
  cacheBust: boolean;
  /** Total event objects inspected. */
  received: number;
  /** Events that matched a deal + input property change. */
  matched: number;
  /** Creation, deletion, and dealstage changes. */
  lifecycle: number;
  /** Events ignored because they referenced an output property. */
  ignoredOutputEvents: number;
  /** Events ignored for any other reason (wrong object, other property, no id). */
  ignoredOther: number;
}

function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["events", "eventList", "data", "payload"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    return [payload];
  }
  return [];
}

export function readPropertyName(event: Record<string, unknown>): string | null {
  const candidate =
    event.propertyName ?? event.property ?? event.propertyname ?? event.property_name;
  if (typeof candidate !== "string") return null;
  const name = candidate.trim().toLowerCase();
  return name === "" ? null : name;
}

export function readDealId(event: Record<string, unknown>): string | null {
  const candidate =
    event.objectId ??
    event.dealId ??
    event.objectIdString ??
    event.recordId ??
    (event.object as Record<string, unknown> | undefined)?.id;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(candidate);
  }
  if (typeof candidate === "string" && candidate.trim() !== "") {
    return candidate.trim();
  }
  return null;
}

export function isDealEvent(event: Record<string, unknown>): boolean {
  const objectTypeId = event.objectTypeId;
  if (typeof objectTypeId === "string" && objectTypeId.trim() === "0-3") return true;

  const objectType = event.objectType ?? event.object_type;
  if (typeof objectType === "string" && objectType.trim().toLowerCase() === "deal") {
    return true;
  }

  const subscriptionType = event.subscriptionType ?? event.subscription_type;
  if (
    typeof subscriptionType === "string" &&
    subscriptionType.trim().toLowerCase().startsWith("deal.")
  ) {
    return true;
  }

  // A payload carrying dealId is unambiguous even without a type marker.
  if (event.dealId !== undefined) return true;

  return false;
}

function readSubscription(event: Record<string, unknown>): string {
  const raw = event.subscriptionType ?? event.subscription_type;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function summarizeEvents(payload: unknown): EventSummary {
  const events = asArray(payload);
  const dealIds: string[] = [];
  const seen = new Set<string>();
  let matched = 0;
  let lifecycle = 0;
  let cacheBust = false;
  let ignoredOutputEvents = 0;
  let ignoredOther = 0;

  for (const raw of events) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      ignoredOther += 1;
      continue;
    }
    const event = raw as Record<string, unknown>;
    const property = readPropertyName(event);
    const subscription = readSubscription(event);

    if (property && OUTPUT_SET.has(property)) {
      ignoredOutputEvents += 1;
      continue;
    }
    if (
      subscription === "deal.creation" ||
      subscription === "deal.deletion" ||
      (property === "dealstage" && isDealEvent(event))
    ) {
      lifecycle += 1;
      cacheBust = true;
      continue;
    }
    if (!isDealEvent(event) || !property || !INPUT_SET.has(property)) {
      ignoredOther += 1;
      continue;
    }
    const dealId = readDealId(event);
    if (!dealId) {
      ignoredOther += 1;
      continue;
    }
    matched += 1;
    if (!seen.has(dealId)) {
      seen.add(dealId);
      dealIds.push(dealId);
    }
  }

  return {
    dealIds,
    cacheBust,
    received: events.length,
    matched,
    lifecycle,
    ignoredOutputEvents,
    ignoredOther,
  };
}
