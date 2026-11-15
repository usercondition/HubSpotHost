/** System tiles shown on the Print Ops page. `polled` systems are filled by the hub, not by watchdogs. */
export const SYSTEM_STATUS_IDS = [
  "grok-bot",
  "paperclip",
  "make",
  "syncthing",
  "drives-backups",
  "shipment-tracking",
  "hubspot-webhook",
  "hubspot-sync",
  "mac-mini",
  "macbook-pro",
  "marketplace-apis",
  "shipengine",
] as const;

export type SystemStatusId = (typeof SYSTEM_STATUS_IDS)[number];

export const SYSTEM_CATALOG: Record<SystemStatusId, { label: string; polled: boolean }> = {
  "grok-bot": { label: "Grok Bot routines", polled: false },
  paperclip: { label: "Paperclip agents", polled: false },
  make: { label: "Make scenarios", polled: false },
  syncthing: { label: "Syncthing", polled: false },
  "drives-backups": { label: "Drives and backups", polled: false },
  "shipment-tracking": { label: "Shipment tracking", polled: true },
  "hubspot-webhook": { label: "HubSpot webhook", polled: true },
  "hubspot-sync": { label: "HubSpot sync", polled: true },
  "mac-mini": { label: "Mac mini", polled: false },
  "macbook-pro": { label: "MacBook Pro", polled: false },
  "marketplace-apis": { label: "Marketplace APIs", polled: false },
  shipengine: { label: "ShipEngine", polled: true },
};
