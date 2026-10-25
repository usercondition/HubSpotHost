/**
 * Client Inbox API.
 *
 * - Watcher → Print Ops: POST /api/inbox/ingest (Gmail message notifications) and
 *   POST /api/inbox/cards (full snapshot), plus GET /api/inbox/edits. All three use
 *   INBOX_PUSH_TOKEN (Authorization: Bearer … or x-inbox-push-token).
 * - Owner UI: everything else, behind the existing owner access code.
 * - Scheduler: POST /api/cron/followup-reminders, behind OWNER_DIGEST_CRON_SECRET.
 *
 * The Inbox shows eBay, Etsy, and MyMiniFactory. Facebook Marketplace is paused:
 * those cards are dropped and deleted, and no Facebook read is queued.
 *
 * Buyer Send is off. POST /api/inbox/cards/:id/send and /api/inbox/outbound/:id/retry
 * refuse before anything is queued. The Mac poll records a heartbeat and does not
 * claim a refresh or a send. Draft replies and follow-ups still save.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { BUYER_SEND_OFF_ERROR, channelForSource, normalizeInboxPayload, sellerInboxChannel } from "../../shared/inbox";
import { normalizeSellerMailBatch } from "../../shared/inbox-mail";
import {
  VersionConflictError,
  createFollowup,
  getFollowup,
  getInboxCard,
  finishOutbound,
  finishRefresh,
  getMeta,
  getOutbound,
  latestRefresh,
  listFollowups,
  mergeThreadRead,
  purgeInboxCards,
  purgePausedFacebookCards,
  setInboxMeta,
  listInboxCards,
  mergeInboxCards,
  listReplyEditsSince,
  saveReplyEdit,
  setCardStatus,
  setFollowupNotion,
  updateFollowup,
  upsertInboxCards,
} from "./inbox-cards-store";
import { getNotionFollowupsConfig, writeFollowupToNotion } from "./notion-followups";
import { runFollowupReminders } from "./followup-reminders";

type Gate = (req: Request, res: Response) => boolean;

export function inboxPushToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.INBOX_PUSH_TOKEN?.trim() || "";
}

function providedPushToken(req: Request): string {
  const header = req.get("x-inbox-push-token") ?? "";
  const bearer = (req.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  return (header || bearer).trim();
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Returns true (and responds) when the push token is missing or wrong. */
export function rejectInboxPush(req: Request, res: Response, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = inboxPushToken(env);
  if (expected.length < 24) {
    res.status(503).json({ ok: false, error: "Inbox push is not configured (INBOX_PUSH_TOKEN)" });
    return true;
  }
  const provided = providedPushToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    res.status(401).json({ ok: false, error: "Inbox push token missing or wrong" });
    return true;
  }
  return false;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const replySchema = z.object({ reply: z.string().max(4000), version: z.number().int().min(0).optional() });
const statusSchema = z.object({
  status: z.enum(["replied", "handled"]),
  followup: z
    .object({
      said: z.string().max(4000).default(""),
      nextAction: z.string().max(1000).default(""),
      reminderDate: dateSchema.nullable().optional(),
      hubspotUrl: z.string().max(500).regex(/^(https:\/\/.*)?$/).default(""),
      client: z.string().max(160).optional(),
      listing: z.string().max(300).optional(),
    })
    .optional(),
});
const refreshSchema = z.object({ reason: z.enum(["open", "manual"]).default("manual") });
const sendSchema = z.object({
  text: z.string().min(1).max(2000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "idempotencyKey must be 8-80 letters/digits/-/_"),
});
const macRefreshSchema = z.object({ ok: z.boolean(), detail: z.string().max(300).optional() });
const macOutboundSchema = z.object({
  attempt: z.number().int().min(1),
  status: z.enum(["sent", "failed", "unverified"]),
  detail: z.string().max(300).optional(),
});
const macThreadSchema = z.object({
  messages: z
    .array(z.object({ who: z.string().min(1), text: z.string(), when: z.string().optional(), at: z.string().max(40).nullable().optional() }))
    .max(400),
});
const ingestMessageSchema = z.object({
  id: z.string().min(1).max(160),
  threadId: z.string().max(160).optional(),
  from: z.string().max(300).optional(),
  subject: z.string().max(300).optional(),
  snippet: z.string().max(4000).optional(),
  text: z.string().max(4000).optional(),
  date: z.string().max(40).optional(),
  channel: z.string().max(40).optional(),
  buyer: z.string().max(160).optional(),
  listing: z.string().max(300).optional(),
  listingUrl: z.string().max(1000).optional(),
});
const ingestSchema = z.object({ messages: z.array(ingestMessageSchema).max(100) });
const followupPatchSchema = z.object({
  status: z.enum(["open", "done", "snoozed"]).optional(),
  reminderDate: dateSchema.nullable().optional(),
  nextAction: z.string().max(1000).optional(),
});

async function syncToNotion(id: string) {
  const f = getFollowup(id);
  if (!f) return null;
  if (!getNotionFollowupsConfig()) {
    setFollowupNotion(id, { error: "Notion not configured; saved in Print Ops only" });
    return getFollowup(id);
  }
  const r = await writeFollowupToNotion(f);
  setFollowupNotion(id, r.ok ? { pageId: r.pageId, url: r.url, error: null } : { error: r.error });
  return getFollowup(id);
}

export function registerInboxRoutes(app: Express, rejectOwner: Gate, rejectCron: Gate): void {
  app.post("/api/inbox/cards", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const { cards, updatedAt, rejected, excludeIds } = normalizeInboxPayload(req.body);
    if (cards.length === 0 && rejected > 0) {
      return res.status(400).json({ ok: false, error: "No valid cards in payload", rejected });
    }
    const seller = cards.filter((card) => sellerInboxChannel(card.source));
    const dropped = cards.length - seller.length;
    const purged = purgeInboxCards(excludeIds) + purgePausedFacebookCards();
    const result = seller.length
      ? upsertInboxCards(seller, updatedAt)
      : { received: 0, changed: 0, reopened: 0, removed: 0 };
    return res.json({ ok: true, ...result, rejected, purged, dropped, buyerSend: "off" as const });
  });

  app.post("/api/inbox/ingest", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const parsed = ingestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { messages: [...] }" });
    const { cards, skipped } = normalizeSellerMailBatch(parsed.data.messages);
    const purged = purgePausedFacebookCards();
    const result = mergeInboxCards(cards);
    const at = new Date().toISOString();
    setInboxMeta("last_ingest_at", at);
    setInboxMeta("last_checkin_at", at);
    return res.json({ ok: true, ...result, skipped, purged, buyerSend: "off" as const });
  });

  app.get("/api/inbox/edits", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    setInboxMeta("last_checkin_at", new Date().toISOString());
    const since = typeof req.query.since === "string" && req.query.since.trim() ? req.query.since.trim() : null;
    return res.json({ ok: true, edits: listReplyEditsSince(since), now: new Date().toISOString() });
  });

  app.get("/api/inbox/cards", (req, res) => {
    if (rejectOwner(req, res)) return;
    purgePausedFacebookCards();
    return res.json({
      ok: true,
      cards: listInboxCards().filter((card) => sellerInboxChannel(card.source)),
      lastPushAt: getMeta("last_push_at"),
      lastCheckinAt: getMeta("last_checkin_at"),
      lastIngestAt: getMeta("last_ingest_at"),
      liveMirror: getMeta("mac_live") === "1",
      sourceUpdatedAt: getMeta("source_updated_at"),
      refresh: null,
      outbound: [],
      buyerSend: "off" as const,
      facebookPaused: true,
      ingest: "gmail" as const,
      pushConfigured: inboxPushToken().length >= 24,
      notionConfigured: Boolean(getNotionFollowupsConfig()),
    });
  });

  /* ---------------------------------------------- live mirror: owner side --- */

  app.post("/api/inbox/refresh", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = refreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { reason: 'open' | 'manual' }" });
    return res.status(200).json({
      ok: true,
      queued: false,
      reason: "paused",
      detail: "Facebook Marketplace refresh is paused. eBay, Etsy, and MyMiniFactory chats show up when a Gmail watcher posts message notifications.",
      refresh: null,
    });
  });

  app.post("/api/inbox/cards/:id/send", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Expected { text, idempotencyKey }" });
    const text = parsed.data.text.replace(/\r/g, "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Empty message" });
    if (!getInboxCard(req.params.id)) return res.status(404).json({ ok: false, error: "Chat not found" });
    return res.status(403).json({ ok: false, error: BUYER_SEND_OFF_ERROR });
  });

  app.post("/api/inbox/outbound/:id/retry", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.status(403).json({ ok: false, error: BUYER_SEND_OFF_ERROR });
  });

  /* ------------------------------------------------ live mirror: Mac side --- */

  app.post("/api/inbox/mac/poll", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const body = (req.body ?? {}) as { live?: unknown };
    const live = body.live === true;
    setInboxMeta("last_checkin_at", new Date().toISOString());
    setInboxMeta("mac_live", live ? "1" : "0");
    // Facebook sync and buyer send stay off. A poll is only a heartbeat.
    return res.json({ ok: true, refresh: null, outbound: [], facebookPaused: true, buyerSend: "off" as const });
  });

  app.post("/api/inbox/mac/refresh/:id", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const parsed = macRefreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { ok, detail? }" });
    const updated = finishRefresh(req.params.id, parsed.data.ok, parsed.data.detail ?? "");
    return res.status(updated ? 200 : 409).json({ ok: updated, refresh: latestRefresh() });
  });

  app.post("/api/inbox/mac/outbound/:id", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const parsed = macOutboundSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { attempt, status, detail? }" });
    const outbound = finishOutbound(req.params.id, parsed.data.attempt, parsed.data.status, parsed.data.detail ?? "");
    if (!outbound) return res.status(409).json({ ok: false, error: "Not a claimed attempt", outbound: getOutbound(req.params.id) });
    return res.json({ ok: true, outbound });
  });

  app.post("/api/inbox/mac/thread/:id", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const parsed = macThreadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { messages: [{ who, text, when?, at? }] }" });
    const messages = parsed.data.messages
      .map((m) => ({ who: m.who.slice(0, 40), text: m.text.slice(0, 2000), when: (m.when ?? "").slice(0, 80), at: m.at ?? null }))
      .filter((m) => m.text.trim());
    const result = mergeThreadRead(req.params.id, messages);
    if (!result.ok) return res.status(404).json({ ok: false, error: "Chat not found" });
    return res.json({ ...result, ok: true });
  });

  app.patch("/api/inbox/cards/:id/reply", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = replySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { reply, version? }" });
    if (!getInboxCard(req.params.id)) return res.status(404).json({ ok: false, error: "Card not found" });
    try {
      const saved = saveReplyEdit(req.params.id, parsed.data.reply, parsed.data.version);
      return res.json({ ok: true, ...saved });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return res.status(409).json({ ok: false, error: error.message, currentVersion: error.current });
      }
      throw error;
    }
  });

  app.post("/api/inbox/cards/:id/status", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid body" });
    const card = getInboxCard(req.params.id);
    if (!card) return res.status(404).json({ ok: false, error: "Card not found" });
    setCardStatus(card.id, parsed.data.status);
    let followup = null;
    if (parsed.data.followup) {
      const f = parsed.data.followup;
      const created = createFollowup({
        cardId: card.id,
        client: f.client?.trim() || card.name,
        listing: f.listing?.trim() ?? card.listing,
        listingUrl: card.listingUrl,
        channel: channelForSource(card.source),
        said: f.said,
        nextAction: f.nextAction,
        reminderDate: f.reminderDate ?? null,
        outcome: parsed.data.status,
        stage: card.analysis?.stage || card.stage,
        hubspotUrl: f.hubspotUrl,
      });
      followup = await syncToNotion(created.id);
    }
    return res.json({ ok: true, card: getInboxCard(card.id), followup });
  });

  app.post("/api/inbox/cards/:id/reopen", (req, res) => {
    if (rejectOwner(req, res)) return;
    if (!setCardStatus(req.params.id, "open")) return res.status(404).json({ ok: false, error: "Card not found" });
    return res.json({ ok: true, card: getInboxCard(req.params.id) });
  });

  app.get("/api/followups", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({ ok: true, followups: listFollowups({ includeDone: req.query.all === "1" }) });
  });

  app.patch("/api/followups/:id", async (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = followupPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Invalid follow-up update" });
    const updated = updateFollowup(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ ok: false, error: "Follow-up not found" });
    return res.json({ ok: true, followup: await syncToNotion(updated.id) });
  });

  app.post("/api/cron/followup-reminders", async (req, res) => {
    if (rejectCron(req, res)) return;
    const force = Boolean(req.body && typeof req.body === "object" && (req.body as { force?: unknown }).force === true);
    const result = await runFollowupReminders({ force });
    return res.status(result.error ? 502 : 200).json({ ok: !result.error, ...result });
  });
}
