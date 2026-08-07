/**
 * Server kit persistence (SQLite). localStorage remains a cache / offline fallback.
 */

import { apiRequest } from "./queryClient";
import { parsePersistedKit } from "./kit-persistence";
import type { KitTracker } from "./kit-dry-run";

export type KitSummaryRow = {
  hubspotDealId: string;
  hubspotDealName: string;
  name: string;
  totalBits: number;
  good: number;
  needed: number;
  onPlate: number;
  reprint: number;
  plateCount: number;
  updatedAt: string;
};

type KitGetResponse = {
  ok: true;
  kit: unknown | null;
  summary: KitSummaryRow | null;
};

type KitPutResponse = {
  ok: true;
  kit: unknown;
  summary: KitSummaryRow;
};

export async function fetchKitFromServer(
  dealId: string,
  headers: Record<string, string>,
): Promise<KitTracker | null> {
  const id = dealId.trim();
  if (!id) return null;
  const response = await apiRequest("GET", `/api/kits/${encodeURIComponent(id)}`, undefined, {
    headers,
  });
  const body = (await response.json()) as KitGetResponse;
  if (!body.kit) return null;
  return parsePersistedKit({ kit: body.kit });
}

export async function saveKitToServer(
  kit: KitTracker,
  headers: Record<string, string>,
): Promise<KitTracker | null> {
  const dealId = (kit.hubspotDealId || "").trim();
  if (!dealId) return null;
  const response = await apiRequest(
    "PUT",
    `/api/kits/${encodeURIComponent(dealId)}`,
    { kit },
    { headers },
  );
  const body = (await response.json()) as KitPutResponse;
  return parsePersistedKit({ kit: body.kit }) ?? kit;
}

export async function listKitSummariesFromServer(
  headers: Record<string, string>,
): Promise<KitSummaryRow[]> {
  const response = await apiRequest("GET", "/api/kits", undefined, { headers });
  const body = (await response.json()) as { ok: true; kits: KitSummaryRow[] };
  return body.kits ?? [];
}
