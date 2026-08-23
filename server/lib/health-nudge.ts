/**
 * Health-check nudge bot: Telegram pings for missing plates, incomplete costs,
 * stale deals, and stuck intake — without the full morning briefing.
 *
 * Reuses Performance attention (same issue keys as the bell) and the Telegram
 * pipe from owner digests. Quiet when the shop is clear; fingerprint-dedupes so
 * the same open set is not re-spammed within a local hour.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PerformanceResponse } from "../../shared/schema";
import type { TrackerAssistantContext } from "./tracker-assistant";
import {
  buildHealthDigestEdition,
  digestSectionMeta,
  healthDigestCaption,
  renderHealthDigestPng,
  shopDigestTitle,
  type HealthDigestEdition,
} from "./health-digest-card";
import {
  sendTelegramMessage,
  sendTelegramPhoto,
  telegramConfigured,
  type TelegramReplyMarkup,
  type TelegramSendResult,
} from "./telegram";

const NUDGE_ISSUE_KEYS = new Set(["no_plates", "costs_incomplete", "stale"]);
const ISSUE_ORDER_KEYS = ["no_plates", "costs_incomplete", "stale"] as const;

export type HealthNudgeResult =
  | {
      ok: true;
      channel: "telegram";
      messageId: number;
      text: string;
      fingerprint: string;
      skipped?: false;
    }
  | {
      ok: true;
      skipped: true;
      reason: string;
      text?: string;
      fingerprint?: string;
    }
  | {
      ok: false;
      error: string;
      text?: string;
    };

type NudgeState = {
  lastDateKey?: string;
  lastHour?: number;
  lastFingerprint?: string;
  updatedAt?: string;
};

function publicAppBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function absoluteActionHref(href: string, env: NodeJS.ProcessEnv = process.env): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = publicAppBase(env);
  if (!base) return href.startsWith("/") ? `/#${href}` : href;
  const hashPath = href.startsWith("/") ? `/#${href}` : href;
  return `${base}${hashPath}`;
}

function nudgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OWNER_HEALTH_NUDGE_STATE_FILE?.trim();
  if (override) return resolve(override);
  const digestState = env.OWNER_DIGEST_STATE_FILE?.trim();
  if (digestState) return resolve(dirname(digestState), "health-nudge-state.json");
  return resolve(process.cwd(), "data", "health-nudge-state.json");
}

export function localNudgeDateKey(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function localNudgeHour(timeZone: string, now: Date = new Date()): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  return hour === 24 ? 0 : hour;
}

export function getHealthNudgeSchedule(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  timeZone: string;
  hours: number[];
} {
  const enabled =
    (env.OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED || "").trim().toLowerCase() === "true" ||
    (env.OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED || "").trim() === "1";
  const timeZone =
    env.OWNER_HEALTH_NUDGE_TZ?.trim() || env.OWNER_DIGEST_TZ?.trim() || "America/New_York";
  const rawHours =
    env.OWNER_HEALTH_NUDGE_HOURS?.trim() || env.OWNER_HEALTH_NUDGE_HOUR?.trim() || "12";
  const hours = [
    ...new Set(
      rawHours
        .split(",")
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= 23),
    ),
  ].sort((a, b) => a - b);
  return { enabled, timeZone, hours: hours.length > 0 ? hours : [12] };
}

function readNudgeState(env: NodeJS.ProcessEnv = process.env): NudgeState {
  const path = nudgeStatePath(env);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NudgeState;
  } catch {
    return {};
  }
}

function writeNudgeState(state: NudgeState, env: NodeJS.ProcessEnv = process.env): void {
  const path = nudgeStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
  );
}

export function collectHealthNudgeItems(snapshot: PerformanceResponse) {
  const attention = snapshot.attention.filter((item) => NUDGE_ISSUE_KEYS.has(item.issueKey));
  const intakePending = snapshot.intake.pendingReview;
  const intakeAwaiting = snapshot.intake.awaitingClient;
  return {
    attention,
    intakePending,
    intakeAwaiting,
    hasWork: attention.length > 0 || intakePending > 0 || intakeAwaiting > 0,
  };
}

export function healthNudgeFingerprint(snapshot: PerformanceResponse): string {
  const { attention, intakePending, intakeAwaiting } = collectHealthNudgeItems(snapshot);
  const parts = [
    ...attention.map((item) => `${item.dealId}:${item.issueKey}`).sort(),
    `intake:pending:${intakePending}`,
    `intake:awaiting:${intakeAwaiting}`,
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortLabel(value: string, limit = 42): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trim()}…`;
}

export function buildHealthNudgeButtons(
  _collected: ReturnType<typeof collectHealthNudgeItems>,
  env: NodeJS.ProcessEnv = process.env,
): TelegramReplyMarkup | undefined {
  const https = (href: string) => {
    const url = absoluteActionHref(href, env);
    return /^https:\/\//i.test(url) ? url : "";
  };
  const row = [
    { text: "Floor", url: https("/") },
    { text: "Queue", url: https("/queue") },
    { text: "Intake", url: https("/orders") },
    { text: "Prints", url: https("/prints") },
  ].filter((button) => Boolean(button.url));
  return row.length > 0 ? { inline_keyboard: [row] } : undefined;
}

export function buildHealthNudgeText(
  ctx: TrackerAssistantContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string; now?: Date; timeZone?: string },
): { text: string; fingerprint: string; hasWork: boolean; edition: HealthDigestEdition } {
  void env;
  const collected = collectHealthNudgeItems(ctx.snapshot);
  const fingerprint = healthNudgeFingerprint(ctx.snapshot);
  const edition = buildHealthDigestEdition(ctx, {
    title: shopDigestTitle(options?.title),
    now: options?.now,
    timeZone: options?.timeZone,
  });
  if (!collected.hasWork) {
    return {
      text: `<b>${escapeHtml(edition.kicker)}</b>\n${escapeHtml(edition.lede)}\n${escapeHtml(edition.deck)}`,
      fingerprint,
      hasWork: false,
      edition,
    };
  }

  const lines: string[] = [
    `<b>${escapeHtml(edition.kicker)}</b>`,
    escapeHtml(edition.dateLine),
    "",
    escapeHtml(edition.lede),
  ];
  if (edition.deck) lines.push(escapeHtml(edition.deck));
  if (edition.intakeLine) {
    lines.push("");
    lines.push(`<b>Intake</b> · ${escapeHtml(edition.intakeLine)}`);
  }

  const byKey = new Map<string, typeof collected.attention>();
  for (const item of collected.attention) {
    const list = byKey.get(item.issueKey) ?? [];
    list.push(item);
    byKey.set(item.issueKey, list);
  }

  for (const issueKey of ISSUE_ORDER_KEYS) {
    const items = byKey.get(issueKey);
    if (!items || items.length === 0) continue;
    const heading = digestSectionMeta(issueKey);
    lines.push("");
    lines.push(`<b>${heading.kicker}</b> · ${escapeHtml(heading.hint)}`);
    for (const item of items.slice(0, 4)) {
      const stage = item.stage.trim() ? ` · ${escapeHtml(shortLabel(item.stage, 24))}` : "";
      lines.push(`• ${escapeHtml(shortLabel(item.dealName))}${stage}`);
    }
    if (items.length > 4) {
      lines.push(`• and ${items.length - 4} more`);
    }
  }

  lines.push("");
  lines.push(escapeHtml(edition.folio));

  const text = lines.join("\n").trim();
  return {
    text: text.length > 3900 ? `${text.slice(0, 3890)}\n…` : text,
    fingerprint,
    hasWork: true,
    edition,
  };
}

export async function sendHealthNudge(
  ctx: TrackerAssistantContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string; force?: boolean; now?: Date },
): Promise<HealthNudgeResult> {
  if (!telegramConfigured(env)) {
    return { ok: false, error: "Telegram is not configured" };
  }

  const schedule = getHealthNudgeSchedule(env);
  const now = options?.now ?? new Date();
  const dateKey = localNudgeDateKey(schedule.timeZone, now);
  const hour = localNudgeHour(schedule.timeZone, now);
  const built = buildHealthNudgeText(ctx, env, {
    title: options?.title,
    now,
    timeZone: schedule.timeZone,
  });
  const buttons = buildHealthNudgeButtons(collectHealthNudgeItems(ctx.snapshot), env);
  const edition = built.edition;

  if (!built.hasWork && !options?.force) {
    return {
      ok: true,
      skipped: true,
      reason: "Nothing needs a nudge right now",
      text: built.text,
      fingerprint: built.fingerprint,
    };
  }

  if (!options?.force) {
    const previous = readNudgeState(env);
    if (
      previous.lastDateKey === dateKey &&
      previous.lastHour === hour &&
      previous.lastFingerprint === built.fingerprint
    ) {
      return {
        ok: true,
        skipped: true,
        reason: `Already nudged for ${dateKey} @ ${hour}:00 with the same open items`,
        text: built.text,
        fingerprint: built.fingerprint,
      };
    }
  }

  let sent: TelegramSendResult = { ok: false, error: "not sent" };
  try {
    const png = renderHealthDigestPng(edition);
    const photo = await sendTelegramPhoto(png, healthDigestCaption(edition), env, fetch, {
      replyMarkup: buttons,
    });
    if (photo.ok) sent = photo;
    else sent = { ok: false, error: photo.error };
  } catch (error) {
    sent = { ok: false, error: error instanceof Error ? error.message : "Could not render the digest card" };
  }

  if (!sent.ok) {
    const fallback = await sendTelegramMessage(built.text, env, fetch, {
      parseMode: "HTML",
      replyMarkup: buttons,
    });
    if (!fallback.ok) {
      return { ok: false, error: fallback.error, text: built.text };
    }
    sent = fallback;
  }

  if (!sent.ok) {
    return { ok: false, error: sent.error, text: built.text };
  }

  writeNudgeState(
    {
      lastDateKey: dateKey,
      lastHour: hour,
      lastFingerprint: built.fingerprint,
    },
    env,
  );

  return {
    ok: true,
    channel: "telegram",
    messageId: sent.messageId,
    text: built.text,
    fingerprint: built.fingerprint,
  };
}

export function shouldRunScheduledHealthNudge(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  fingerprint?: string,
): { run: boolean; reason: string; dateKey: string; hour: number } {
  const schedule = getHealthNudgeSchedule(env);
  const dateKey = localNudgeDateKey(schedule.timeZone, now);
  const hour = localNudgeHour(schedule.timeZone, now);

  if (!schedule.enabled) {
    return { run: false, reason: "Schedule disabled", dateKey, hour };
  }
  if (!telegramConfigured(env)) {
    return { run: false, reason: "Telegram not configured", dateKey, hour };
  }
  if (!schedule.hours.includes(hour)) {
    return {
      run: false,
      reason: `Waiting for hour ${schedule.hours.join("/")} (local ${hour})`,
      dateKey,
      hour,
    };
  }

  const previous = readNudgeState(env);
  if (
    previous.lastDateKey === dateKey &&
    previous.lastHour === hour &&
    (fingerprint == null || previous.lastFingerprint === fingerprint)
  ) {
    return {
      run: false,
      reason: `Already nudged for ${dateKey} @ ${hour}:00`,
      dateKey,
      hour,
    };
  }

  return { run: true, reason: "Due", dateKey, hour };
}

let nudgeTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthNudgeScheduler(
  loadContext: () => Promise<TrackerAssistantContext>,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): void {
  if (nudgeTimer) return;
  const schedule = getHealthNudgeSchedule(env);
  if (!schedule.enabled) {
    log("Health nudge schedule off (set OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED=true to enable).");
    return;
  }
  if (!telegramConfigured(env)) {
    log("Health nudge schedule enabled but Telegram env is incomplete.");
    return;
  }

  log(
    `Health nudge schedule on: ${schedule.hours.map((h) => `${h}:00`).join(", ")} ${schedule.timeZone} → Telegram.`,
  );

  const tick = async () => {
    try {
      const ctx = await loadContext();
      const fingerprint = healthNudgeFingerprint(ctx.snapshot);
      const due = shouldRunScheduledHealthNudge(env, new Date(), fingerprint);
      if (!due.run) return;
      const result = await sendHealthNudge(ctx, env, {
        title: "Print Ops — health check",
        force: false,
      });
      if (result.ok && !result.skipped) {
        log(`Health nudge sent (message ${result.messageId}).`);
      } else if (result.ok && result.skipped) {
        log(`Health nudge skipped: ${result.reason}`);
      } else if (!result.ok) {
        log(`Health nudge failed: ${result.error}`);
      }
    } catch (error) {
      log(`Health nudge tick error: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };

  void tick();
  nudgeTimer = setInterval(() => void tick(), 60_000);
  if (typeof nudgeTimer.unref === "function") nudgeTimer.unref();
}
