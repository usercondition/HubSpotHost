/**
 * Ship-to city / state / ZIP / country from the HubSpot contact the label page uses.
 * Street is read nowhere and returned nowhere.
 */
import type { ShipToFields } from "../../shared/order-origins";
import { hubspotRequest } from "./hubspot";

const CHUNK = 100;

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export async function loadDealShipTos(dealIds: string[]): Promise<Map<string, ShipToFields>> {
  const out = new Map<string, ShipToFields>();
  const ids = Array.from(new Set(dealIds.filter((id) => /^[0-9]{1,20}$/.test(id))));
  if (ids.length === 0) return out;
  try {
    const contactByDeal = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      const slice = ids.slice(offset, offset + CHUNK);
      const data = await hubspotRequest("/crm/v4/associations/deals/contacts/batch/read", {
        method: "POST",
        body: JSON.stringify({ inputs: slice.map((id) => ({ id })) }),
      });
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const row of results) {
        const from = text(row?.from?.id);
        const to = Array.isArray(row?.to) ? row.to[0] : null;
        const contactId = text(to?.toObjectId);
        if (from && contactId) contactByDeal.set(from, contactId);
      }
    }

    const contactIds = Array.from(new Set(Array.from(contactByDeal.values())));
    const contacts = new Map<string, ShipToFields>();
    for (let offset = 0; offset < contactIds.length; offset += CHUNK) {
      const slice = contactIds.slice(offset, offset + CHUNK);
      const data = await hubspotRequest("/crm/v3/objects/contacts/batch/read", {
        method: "POST",
        body: JSON.stringify({
          properties: ["city", "state", "zip", "country"],
          inputs: slice.map((id) => ({ id })),
        }),
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
    }

    for (const [dealId, contactId] of Array.from(contactByDeal.entries())) {
      const shipTo = contacts.get(contactId);
      if (shipTo) out.set(dealId, shipTo);
    }
  } catch {
    return out;
  }
  return out;
}
