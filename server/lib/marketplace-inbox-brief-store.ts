/**
 * Short-lived store for Marketplace inbox secretary briefs.
 */
import crypto from "node:crypto";
import type { MarketplaceInboxBrief, MarketplaceThreadInput } from "./marketplace-inbox-brief";
import { buildMarketplaceInboxBrief } from "./marketplace-inbox-brief";

type StoredBrief = {
  brief: MarketplaceInboxBrief;
  createdAt: number;
};

const briefs = new Map<string, StoredBrief>();
const TTL_MS = 30 * 60 * 1000;
const MAX_THREADS = 40;

function sweep(now = Date.now()): void {
  for (const [id, row] of Array.from(briefs.entries())) {
    if (now - row.createdAt > TTL_MS) briefs.delete(id);
  }
}

export function createMarketplaceInboxBrief(threads: MarketplaceThreadInput[]): {
  id: string;
  expiresAt: string;
  brief: MarketplaceInboxBrief;
} {
  sweep();
  if (!Array.isArray(threads) || threads.length === 0) {
    throw new Error("Scan at least one Marketplace conversation");
  }
  const clipped = threads.slice(0, MAX_THREADS).map((thread, index) => ({
    id: String(thread.id || `t-${index}`).slice(0, 160),
    title: String(thread.title || `Thread ${index + 1}`).slice(0, 200),
    conversation: String(thread.conversation || "").slice(0, 40_000),
    unread: Boolean(thread.unread),
    lastActivityAt: thread.lastActivityAt ? String(thread.lastActivityAt).slice(0, 80) : null,
  }));
  if (!clipped.some((t) => t.conversation.trim().length >= 20)) {
    throw new Error("Scanned threads did not include enough message text");
  }
  const brief = buildMarketplaceInboxBrief(clipped);
  const id = crypto.randomBytes(24).toString("hex");
  briefs.set(id, { brief, createdAt: Date.now() });
  return { id, expiresAt: new Date(Date.now() + TTL_MS).toISOString(), brief };
}

export function getMarketplaceInboxBrief(id: string): MarketplaceInboxBrief | null {
  sweep();
  const row = briefs.get(String(id || "").trim());
  return row?.brief ?? null;
}

export function clearMarketplaceInboxBriefs(): void {
  briefs.clear();
}
