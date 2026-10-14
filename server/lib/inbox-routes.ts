/**
 * Client Inbox API.
 *
 * - Mac → Print Ops: POST /api/inbox/cards and GET /api/inbox/edits, secured
 *   by INBOX_PUSH_TOKEN (Authorization: Bearer … or x-inbox-push-token).
 * - Owner UI: everything else, behind the existing owner access code.
 * - Scheduler: POST /api/cron/followup-reminders, behind OWNER_DIGEST_CRON_SECRET.
 *
 * Sending replies to clients stays manual; nothing here messages a buyer.
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
  getMeta,
  listFollowups,
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
    const { cards, updatedAt, rejected } = normalizeInboxPayload(req.body);
    if (cards.length === 0 && rejected > 0) {
      return res.status(400).json({ ok: false, error: "No valid cards in payload", rejected });
    }
    const result = upsertInboxCards(cards, updatedAt);
    return res.json({ ok: true, ...result, rejected });
  });

  app.get("/api/inbox/edits", (req, res) => {
    if (rejectInboxPush(req, res)) return;
    const since = typeof req.query.since === "string" && req.query.since.trim() ? req.query.since.trim() : null;
    return res.json({ ok: true, edits: listReplyEditsSince(since), now: new Date().toISOString() });
  });

  app.get("/api/inbox/cards", (req, res) => {
    if (rejectOwner(req, res)) return;
    return res.json({
      ok: true,
      cards: listInboxCards(),
      lastPushAt: getMeta("last_push_at"),
      sourceUpdatedAt: getMeta("source_updated_at"),
      pushConfigured: inboxPushToken().length >= 24,
      notionConfigured: Boolean(getNotionFollowupsConfig()),
    });
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
