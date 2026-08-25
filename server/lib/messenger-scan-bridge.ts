/**
 * Short-lived capability tokens that carry a scanned Messenger thread into Manual entry.
 * Create requires the owner intake access code (enforced by the route). Redeem is
 * consume-once via unguessable id so the Manual page can load text before unlock.
 */
import crypto from "node:crypto";

export type MessengerScanBridgePayload = {
  conversation: string;
  title: string;
  source: string;
  createdAt: number;
};

const bridges = new Map<string, MessengerScanBridgePayload>();
const TTL_MS = 10 * 60 * 1000;
const MAX_CONVERSATION_CHARS = 100_000;

function sweep(now = Date.now()): void {
  for (const [id, payload] of bridges) {
    if (now - payload.createdAt > TTL_MS) bridges.delete(id);
  }
}

export function createMessengerScanBridge(input: {
  conversation: string;
  title?: string;
  source?: string;
}): { id: string; expiresAt: string } {
  sweep();
  const conversation = String(input.conversation || "").trim().slice(0, MAX_CONVERSATION_CHARS);
  if (conversation.length < 20) {
    throw new Error("Conversation text is too short to bridge");
  }
  const id = crypto.randomBytes(24).toString("hex");
  bridges.set(id, {
    conversation,
    title: String(input.title || "").trim().slice(0, 200),
    source: String(input.source || "messenger-extension").trim().slice(0, 80),
    createdAt: Date.now(),
  });
  return { id, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
}

/** Consume-once read. Returns null if missing/expired. */
export function redeemMessengerScanBridge(id: string): MessengerScanBridgePayload | null {
  sweep();
  const key = String(id || "").trim();
  if (!key) return null;
  const payload = bridges.get(key) || null;
  if (!payload) return null;
  bridges.delete(key);
  return payload;
}

/** Test helper — clear in-memory bridges. */
export function clearMessengerScanBridges(): void {
  bridges.clear();
}

export function messengerScanBridgeCount(): number {
  sweep();
  return bridges.size;
}
