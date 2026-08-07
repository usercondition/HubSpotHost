/**
 * Persist kit trackers in localStorage, keyed by HubSpot deal (or "local").
 * STL File blobs are session-only and are not stored.
 */

import type { KitBit, KitPlate, KitTracker } from "./kit-dry-run";

const STORAGE_PREFIX = "printops.kit.v1.";
export const LOCAL_KIT_STORAGE_KEY = "local";

export type PersistedKitTracker = {
  version: 1;
  savedAt: string;
  kit: KitTracker;
};

function storageKey(dealId: string | null | undefined): string {
  const id = (dealId || "").trim();
  return `${STORAGE_PREFIX}${id || LOCAL_KIT_STORAGE_KEY}`;
}

function isBitStatus(value: unknown): value is KitBit["status"] {
  return value === "needed" || value === "on_plate" || value === "good" || value === "reprint";
}

function parseBit(raw: unknown): KitBit | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.fileName !== "string" || typeof row.label !== "string") {
    return null;
  }
  if (typeof row.group !== "string" || !isBitStatus(row.status)) return null;
  return {
    id: row.id,
    fileName: row.fileName,
    label: row.label,
    group: row.group,
    status: row.status,
    plateId: typeof row.plateId === "string" ? row.plateId : null,
  };
}

function parsePlate(raw: unknown): KitPlate | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.ctbFileName !== "string") {
    return null;
  }
  if (typeof row.createdAt !== "string" || !Array.isArray(row.bitIds)) return null;
  const bitIds = row.bitIds.filter((id): id is string => typeof id === "string");
  return {
    id: row.id,
    name: row.name,
    ctbFileName: row.ctbFileName,
    createdAt: row.createdAt,
    bitIds,
    printFileRecordId:
      typeof row.printFileRecordId === "number" && Number.isFinite(row.printFileRecordId)
        ? row.printFileRecordId
        : null,
  };
}

export function parsePersistedKit(raw: unknown): KitTracker | null {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw as Record<string, unknown>;
  const kitRaw = envelope.kit && typeof envelope.kit === "object" ? (envelope.kit as Record<string, unknown>) : envelope;
  if (typeof kitRaw.name !== "string" || !Array.isArray(kitRaw.bits) || !Array.isArray(kitRaw.plates)) {
    return null;
  }
  const bits = kitRaw.bits.map(parseBit).filter((bit): bit is KitBit => Boolean(bit));
  const plates = kitRaw.plates.map(parsePlate).filter((plate): plate is KitPlate => Boolean(plate));
  if (bits.length === 0 && plates.length === 0 && !kitRaw.name.trim()) return null;
  return {
    name: kitRaw.name.trim() || "Kit",
    hubspotDealId: typeof kitRaw.hubspotDealId === "string" ? kitRaw.hubspotDealId : null,
    hubspotDealName: typeof kitRaw.hubspotDealName === "string" ? kitRaw.hubspotDealName : null,
    bits,
    plates,
    updatedAt: typeof kitRaw.updatedAt === "string" ? kitRaw.updatedAt : new Date().toISOString(),
  };
}

export function loadKitFromStorage(dealId: string | null | undefined): KitTracker | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(dealId));
    if (!raw) return null;
    return parsePersistedKit(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function saveKitToStorage(kit: KitTracker): void {
  if (typeof localStorage === "undefined") return;
  const payload: PersistedKitTracker = {
    version: 1,
    savedAt: new Date().toISOString(),
    kit: {
      ...kit,
      updatedAt: new Date().toISOString(),
    },
  };
  try {
    localStorage.setItem(storageKey(kit.hubspotDealId), JSON.stringify(payload));
  } catch {
    /* quota / private mode — kit still works in-session */
  }
}

export function clearKitStorage(dealId: string | null | undefined): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(storageKey(dealId));
  } catch {
    /* ignore */
  }
}

export function listStoredKitDealIds(): string[] {
  if (typeof localStorage === "undefined") return [];
  const ids: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const id = key.slice(STORAGE_PREFIX.length);
    if (id && id !== LOCAL_KIT_STORAGE_KEY) ids.push(id);
  }
  return ids.sort();
}
