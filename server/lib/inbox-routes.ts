/**
 * Client Inbox API.
 *
 * - Mac → Print Ops: POST /api/inbox/cards and GET /api/inbox/edits, secured
 *   by INBOX_PUSH_TOKEN (Authorization: Bearer … or x-inbox-push-token).
 * - Owner UI: everything else, behind the existing owner access code.
 * - Scheduler: POST /api/cron/followup-reminders, behind OWNER_DIGEST_CRON_SECRET.
 * - Live mirror (Mac → Print Ops, push token): POST /api/inbox/mac/poll (heartbeat + claim refresh/sends),
 *   POST /api/inbox/mac/refresh/:id, POST /api/inbox/mac/outbound/:id, POST /api/inbox/mac/thread/:id.
 * - Live mirror (owner): POST /api/inbox/refresh, POST /api/inbox/cards/:id/send, POST /api/inbox/outbound/:id/retry.
 *
 * Nothing here messages a buyer by itself. A message is only queued when the owner presses Send
 * (owner code + idempotency key); the Mac sends it through the FB browser and reports back.
 * Retries happen only when the owner taps Retry.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { channelForSource, normalizeInboxPayload } from "../../shared/inbox";
import {
  VersionConflictError,
  createFollowup,
  getFollowup,
  getInboxCard,
  OutboundKeyConflictError,
  claimOutbound,
  claimRefresh,
  finishOutbound,
  finishRefresh,
  getMeta,
  getOutbound,
  latestRefresh,
  listFollowups,
  listOutbound,
  mergeThreadRead,
  purgeInboxCards,
  queueOutbound,
  requestInboxRefresh,
  retryOutbound,
  setInboxMeta,
  listInboxCards,
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
    const purged = purgeInboxCards(excludeIds);
    const result = upsertInboxCards(cards, updatedAt);
    return res.json({ ok: true, ...result, rejected, purged });
  });

  app.get("/api/inbox/edits", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    setInboxMeta("last_checkin_at", new Date().toISOString());
    const since = typeof req.query.since === "string" && req.query.since.trim() ? req.query.since.trim() : null;
    return res.json({ ok: true, edits: listReplyEditsSince(since), now: new Date().toISOString() });
  });

  app.get("/api/inbox/cards", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({
      ok: true,
      cards: listInboxCards(),
      lastPushAt: getMeta("last_push_at"),
      lastCheckinAt: getMeta("last_checkin_at"),
      liveMirror: getMeta("mac_live") === "1",
      sourceUpdatedAt: getMeta("source_updated_at"),
      refresh: latestRefresh(),
      outbound: listOutbound(),
      pushConfigured: inboxPushToken().length >= 24,
      notionConfigured: Boolean(getNotionFollowupsConfig()),
    });
  });

  /* ---------------------------------------------- live mirror: owner side --- */

  app.post("/api/inbox/refresh", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = refreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Expected { reason: 'open' | 'manual' }" });
    const result = requestInboxRefresh(parsed.data.reason);
    return res.status(result.queued ? 202 : 200).json({ ok: true, ...result });
  });

  app.post("/api/inbox/cards/:id/send", (req, res) => {
    if (rejectOwner(req, res)) return;
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "Expected { text, idempotencyKey }" });
    const text = parsed.data.text.replace(/\r/g, "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Empty message" });
    if (!getInboxCard(req.params.id)) return res.status(404).json({ ok: false, error: "Chat not found" });
    try {
      const { created, outbound } = queueOutbound(req.params.id, text, parsed.data.idempotencyKey);
      return res.status(created ? 202 : 200).json({ ok: true, created, outbound });
    } catch (error) {
      if (error instanceof OutboundKeyConflictError) return res.status(409).json({ ok: false, error: error.message });
      throw error;
    }
  });

  app.post("/api/inbox/outbound/:id/retry", (req, res) => {
    if (rejectOwner(req, res)) return;
    const current = getOutbound(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: "Message not found" });
    const outbound = retryOutbound(req.params.id);
    if (!outbound) return res.status(409).json({ ok: false, error: `Only failed messages can be retried (this one is ${current.status})`, outbound: current });
    return res.json({ ok: true, outbound });
  });

  /* ------------------------------------------------ live mirror: Mac side --- */

  app.post("/api/inbox/mac/poll", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const body = (req.body ?? {}) as { live?: unknown; maxSends?: unknown };
    const live = body.live === true;
    setInboxMeta("last_checkin_at", new Date().toISOString());
    setInboxMeta("mac_live", live ? "1" : "0");
    if (!live) return res.json({ ok: true, refresh: null, outbound: [] });
    const maxSends = typeof body.maxSends === "number" ? Math.max(0, Math.min(5, Math.floor(body.maxSends))) : 3;
    return res.json({ ok: true, refresh: claimRefresh(), outbound: claimOutbound(maxSends) });
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
