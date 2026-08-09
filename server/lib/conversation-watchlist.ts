/**
 * Lightweight Marketplace conversation watchlist.
 *
 * Stores summaries only (no full transcripts) so buried follow-ups can remind
 * the owner via Command center / Telegram digest.
 */

import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  CONVERSATION_STAGE_LABELS,
  conversationWatchlist,
  type ConversationFollowUp,
  type ConversationMessageRole,
  type ConversationScanResult,
  type ConversationStage,
  type ConversationWaitingOn,
  type ConversationWatchlistEntry,
  type ConversationWatchlistStatus,
} from "../../shared/schema";
import { getDb } from "./order-links";
import { lastMessageAtFrom, type ConversationScanInput, normalizeScanMessages } from "./conversation-scan";

function clean(value: string | undefined, limit = 240): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function hoursSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round(((now.getTime() - then) / 3_600_000) * 10) / 10);
}

function reminderLine(entry: ConversationWatchlistEntry, hoursWaiting: number | null): string {
  const who = entry.counterpartName || "A Marketplace buyer";
  const age =
    hoursWaiting == null
      ? ""
      : hoursWaiting < 1
        ? " (just now)"
        : hoursWaiting < 24
          ? ` (${Math.round(hoursWaiting)}h)`
          : ` (${Math.round(hoursWaiting / 24)}d)`;

  if (entry.waitingOn === "you") {
    return `Hey — you may have forgotten about ${who}${age}. They’re waiting on your reply: “${clean(entry.lastMessagePreview, 100) || "…"}”`;
  }
  if (entry.stage === "payment_claimed" || entry.stage === "ready_for_intake") {
    return `${who}${age}: payment/details look ready — verify and create the Print Order if you haven’t.`;
  }
  if (entry.waitingOn === "buyer") {
    return `${who}${age}: still waiting on them (${CONVERSATION_STAGE_LABELS[entry.stage as ConversationStage] || entry.stage}).`;
  }
  return `${who}${age}: ${entry.headline || CONVERSATION_STAGE_LABELS[entry.stage as ConversationStage] || "open chat"}`;
}

export function toFollowUp(entry: ConversationWatchlistEntry, now: Date = new Date()): ConversationFollowUp {
  const hoursWaiting = hoursSince(entry.lastMessageAt || entry.updatedAt, now);
  return {
    id: entry.id,
    threadKey: entry.threadKey,
    counterpartName: entry.counterpartName,
    stage: entry.stage as ConversationStage,
    stageLabel: CONVERSATION_STAGE_LABELS[entry.stage as ConversationStage] || entry.stage,
    waitingOn: entry.waitingOn as ConversationWaitingOn,
    lastMessageRole: entry.lastMessageRole,
    lastMessagePreview: entry.lastMessagePreview,
    lastMessageAt: entry.lastMessageAt,
    headline: entry.headline,
    suggestedReply: entry.suggestedReply,
    threadUrl: entry.threadUrl,
    status: entry.status as ConversationWatchlistStatus,
    hoursWaiting,
    reminder: reminderLine(entry, hoursWaiting),
  };
}

export function upsertWatchlistFromScan(
  scan: Omit<ConversationScanResult, "ok" | "watchlistId">,
  input: ConversationScanInput,
  now: Date = new Date(),
): number {
  const db = getDb();
  const nowIso = now.toISOString();
  const messages = normalizeScanMessages(input);
  const lastMessageAt = lastMessageAtFrom(messages, nowIso);
  const suggestedReply = scan.nudges.find((nudge) => nudge.suggestedReply)?.suggestedReply ?? "";
  const threadUrl = clean(input.threadUrl, 500);

  const existing = db
    .select()
    .from(conversationWatchlist)
    .where(eq(conversationWatchlist.threadKey, scan.threadKey))
    .get();

  if (existing) {
    db.update(conversationWatchlist)
      .set({
        counterpartName: scan.counterpartName || existing.counterpartName,
        stage: scan.stage,
        waitingOn: scan.waitingOn,
        lastMessageRole: scan.lastMessageRole ?? "",
        lastMessagePreview: scan.lastMessagePreview,
        lastMessageAt,
        headline: scan.headline,
        suggestedReply,
        threadUrl: threadUrl || existing.threadUrl,
        status: "open",
        snoozeUntil: null,
        updatedAt: nowIso,
      })
      .where(eq(conversationWatchlist.id, existing.id))
      .run();
    return existing.id;
  }

  const inserted = db
    .insert(conversationWatchlist)
    .values({
      threadKey: scan.threadKey,
      counterpartName: scan.counterpartName,
      stage: scan.stage,
      waitingOn: scan.waitingOn,
      lastMessageRole: scan.lastMessageRole ?? "",
      lastMessagePreview: scan.lastMessagePreview,
      lastMessageAt,
      headline: scan.headline,
      suggestedReply,
      threadUrl,
      status: "open",
      snoozeUntil: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning({ id: conversationWatchlist.id })
    .get();

  return inserted.id;
}

export type InboxWatchlistItem = {
  threadKey?: string;
  counterpartName?: string;
  preview?: string;
  threadUrl?: string;
  lastMessageAt?: string;
  /** Optional hint from inbox DOM (e.g. unread badge). */
  waitingOn?: ConversationWaitingOn;
};

/** Upsert shallow inbox rows so unread / preview-only threads enter the watchlist. */
export function upsertWatchlistFromInbox(
  items: InboxWatchlistItem[],
  now: Date = new Date(),
): { upserted: number; ids: number[] } {
  const db = getDb();
  const nowIso = now.toISOString();
  const ids: number[] = [];

  for (const item of items.slice(0, 80)) {
    const counterpartName = clean(item.counterpartName, 100);
    const preview = clean(item.preview, 160);
    const threadUrl = clean(item.threadUrl, 500);
    const threadKey =
      clean(item.threadKey, 120) ||
      (counterpartName
        ? `inbox:${counterpartName.toLowerCase().replace(/\s+/g, "-")}`
        : "");
    if (!threadKey) continue;

    const lastMessageAt =
      item.lastMessageAt && !Number.isNaN(Date.parse(item.lastMessageAt))
        ? new Date(item.lastMessageAt).toISOString()
        : nowIso;
    const waitingOn: ConversationWaitingOn = item.waitingOn === "buyer" || item.waitingOn === "none" ? item.waitingOn : "you";
    const headline =
      waitingOn === "you"
        ? `${counterpartName || "Buyer"} may be waiting on you`
        : `${counterpartName || "Buyer"} · inbox snapshot`;

    const existing = db
      .select()
      .from(conversationWatchlist)
      .where(eq(conversationWatchlist.threadKey, threadKey))
      .get();

    if (existing) {
      db.update(conversationWatchlist)
        .set({
          counterpartName: counterpartName || existing.counterpartName,
          lastMessagePreview: preview || existing.lastMessagePreview,
          lastMessageAt,
          waitingOn: existing.lastMessageRole ? (existing.waitingOn as ConversationWaitingOn) : waitingOn,
          headline: existing.headline || headline,
          threadUrl: threadUrl || existing.threadUrl,
          status: existing.status === "done" ? existing.status : "open",
          updatedAt: nowIso,
        })
        .where(eq(conversationWatchlist.id, existing.id))
        .run();
      ids.push(existing.id);
      continue;
    }

    const inserted = db
      .insert(conversationWatchlist)
      .values({
        threadKey,
        counterpartName,
        stage: "unknown",
        waitingOn,
        lastMessageRole: waitingOn === "you" ? ("buyer" satisfies ConversationMessageRole) : "",
        lastMessagePreview: preview,
        lastMessageAt,
        headline,
        suggestedReply: "",
        threadUrl,
        status: "open",
        snoozeUntil: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .returning({ id: conversationWatchlist.id })
      .get();
    ids.push(inserted.id);
  }

  return { upserted: ids.length, ids };
}

function isActiveOpen(entry: ConversationWatchlistEntry, now: Date): boolean {
  if (entry.status === "done") return false;
  if (entry.status === "snoozed" && entry.snoozeUntil) {
    const until = Date.parse(entry.snoozeUntil);
    if (Number.isFinite(until) && until > now.getTime()) return false;
  }
  return true;
}

export function listConversationFollowUps(options?: {
  now?: Date;
  waitingOnYouOnly?: boolean;
  minHoursWaiting?: number;
  limit?: number;
}): ConversationFollowUp[] {
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? 40;
  const minHours = options?.minHoursWaiting ?? 0;
  const rows = getDb()
    .select()
    .from(conversationWatchlist)
    .where(ne(conversationWatchlist.status, "done"))
    .orderBy(desc(conversationWatchlist.updatedAt))
    .all();

  return rows
    .filter((row) => isActiveOpen(row, now))
    .map((row) => toFollowUp(row, now))
    .filter((row) => (options?.waitingOnYouOnly ? row.waitingOn === "you" : true))
    .filter((row) => (row.hoursWaiting == null ? minHours <= 0 : row.hoursWaiting >= minHours))
    .sort((a, b) => {
      if (a.waitingOn === "you" && b.waitingOn !== "you") return -1;
      if (b.waitingOn === "you" && a.waitingOn !== "you") return 1;
      return (b.hoursWaiting ?? 0) - (a.hoursWaiting ?? 0);
    })
    .slice(0, limit);
}

export function snoozeConversationWatchlist(id: number, hours = 24, now: Date = new Date()): boolean {
  const until = new Date(now.getTime() + Math.max(1, hours) * 3_600_000).toISOString();
  const changed = getDb()
    .update(conversationWatchlist)
    .set({ status: "snoozed", snoozeUntil: until, updatedAt: now.toISOString() })
    .where(and(eq(conversationWatchlist.id, id), ne(conversationWatchlist.status, "done")))
    .run();
  return (changed.changes ?? 0) > 0;
}

export function dismissConversationWatchlist(id: number, now: Date = new Date()): boolean {
  const changed = getDb()
    .update(conversationWatchlist)
    .set({ status: "done", updatedAt: now.toISOString(), snoozeUntil: null })
    .where(eq(conversationWatchlist.id, id))
    .run();
  return (changed.changes ?? 0) > 0;
}

export function reopenExpiredSnoozes(now: Date = new Date()): number {
  const nowIso = now.toISOString();
  const changed = getDb()
    .update(conversationWatchlist)
    .set({ status: "open", snoozeUntil: null, updatedAt: nowIso })
    .where(
      and(
        eq(conversationWatchlist.status, "snoozed"),
        sql`${conversationWatchlist.snoozeUntil} IS NOT NULL AND ${conversationWatchlist.snoozeUntil} <= ${nowIso}`,
      ),
    )
    .run();
  return changed.changes ?? 0;
}

export function formatMarketplaceFollowUpsForDigest(
  followUps: ConversationFollowUp[],
  limit = 5,
): string[] {
  const waiting = followUps.filter((row) => row.waitingOn === "you").slice(0, limit);
  if (waiting.length === 0) return ["No Marketplace chats marked as waiting on you."];
  return waiting.map((row) => `• ${row.reminder}`);
}
