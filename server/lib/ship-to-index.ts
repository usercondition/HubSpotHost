/**
 * Ship-to city / state / ZIP / country from the HubSpot contact the label page uses.
 * Street is read nowhere and returned nowhere.
 */
import type { ShipToFields } from "../../shared/order-origins";
import { HubSpotError, hubspotRequest } from "./hubspot";

const CHUNK = 100;
const MAX_CACHE_ENTRIES = 2_000;
const CACHE_TTL_MS = 15 * 60_000;
const BATCH_CONCURRENCY = 2;
const shipToCache = new Map<string, { value: ShipToFields; expiresAt: number }>();

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBatch(path: string, body: object): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await hubspotRequest(path, { method: "POST", body: JSON.stringify(body), readOnly: true });
    } catch (error) {
      if (!(error instanceof HubSpotError) || error.status !== 429 || attempt >= 2) throw error;
      const base = error.retryAfterMs ?? 500 * 2 ** attempt;
      await wait(base + Math.floor(Math.random() * 250));
    }
  }
}

async function inBatches<T>(items: T[], run: (slice: T[]) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, Math.ceil(items.length / CHUNK)) }, async () => {
    while (next < items.length) {
      const offset = next;
      next += CHUNK;
      await run(items.slice(offset, offset + CHUNK));
    }
  }));
}

function remember(dealId: string, value: ShipToFields) {
  if (shipToCache.size >= MAX_CACHE_ENTRIES) shipToCache.delete(shipToCache.keys().next().value!);
  shipToCache.set(dealId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export async function loadDealShipTos(dealIds: string[]): Promise<Map<string, ShipToFields>> {
  const out = new Map<string, ShipToFields>();
  const ids = Array.from(new Set(dealIds.filter((id) => /^[0-9]{1,20}$/.test(id))));
  if (ids.length === 0) return out;
  const missing = ids.filter((id) => {
    const cached = shipToCache.get(id);
    if (!cached || cached.expiresAt < Date.now()) return true;
    out.set(id, cached.value);
    return false;
  });
  if (missing.length === 0) return out;
  try {
    const contactByDeal = new Map<string, string>();
    await inBatches(missing, async (slice) => {
      const data = await readBatch("/crm/v4/associations/deals/contacts/batch/read", { inputs: slice.map((id) => ({ id })) });
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const row of results) {
        const from = text(row?.from?.id);
        const to = Array.isArray(row?.to) ? row.to[0] : null;
        const contactId = text(to?.toObjectId);
        if (from && contactId) contactByDeal.set(from, contactId);
      }
    });

    const contactIds = Array.from(new Set(Array.from(contactByDeal.values())));
    const contacts = new Map<string, ShipToFields>();
    await inBatches(contactIds, async (slice) => {
      const data = await readBatch("/crm/v3/objects/contacts/batch/read", {
        properties: ["city", "state", "zip", "country"],
        inputs: slice.map((id) => ({ id })),
      });
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const row of results) {
        const id = text(row?.id);
        if (!id) continue;
        const props = (row?.properties ?? {}) as Record<string, unknown>;
        contacts.set(id, {
          city: text(props.city),
          state: text(props.state),
          zip: text(props.zip),
          country: text(props.country),
        });
      }
    });

    for (const [dealId, contactId] of Array.from(contactByDeal.entries())) {
      const shipTo = contacts.get(contactId);
      if (shipTo) {
        remember(dealId, shipTo);
        out.set(dealId, shipTo);
      }
    }
  } catch {
    return out;
  }
  return out;
}
