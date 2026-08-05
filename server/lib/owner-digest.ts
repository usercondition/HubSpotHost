/**
 * Owner morning digest: reuse tracker briefing text and deliver via Telegram.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  answerTrackerQuestionRules,
  type TrackerAssistantContext,
} from "./tracker-assistant";
import { sendTelegramMessage, telegramConfigured } from "./telegram";

export type OwnerDigestResult =
  | {
      ok: true;
      channel: "telegram";
      messageId: number;
      text: string;
      skipped?: false;
    }
  | {
      ok: true;
      skipped: true;
      reason: string;
      text?: string;
    }
  | {
      ok: false;
      error: string;
      text?: string;
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

export function buildOwnerDigestText(
  ctx: TrackerAssistantContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string },
): string {
  const briefing = answerTrackerQuestionRules("What should I do next?", ctx);
  const title = options?.title?.trim() || "Print Ops — morning briefing";
  const lines = [title, "", briefing.reply.trim()];

  if (briefing.actions.length > 0) {
    lines.push("", "Open:");
    for (const action of briefing.actions.slice(0, 5)) {
      lines.push(`• ${action.label}: ${absoluteActionHref(action.href, env)}`);
    }
  }

  return lines.join("\n").trim();
}

function digestStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OWNER_DIGEST_STATE_FILE?.trim();
  if (override) return resolve(override);
  const dbFile = env.ORDER_LINKS_DB_FILE?.trim();
  if (dbFile) return resolve(dirname(dbFile), "owner-digest-state.json");
  return resolve(process.cwd(), "data", "owner-digest-state.json");
}

export function localDigestDateKey(
  timeZone: string,
  now: Date = new Date(),
): string {
  // en-CA yields YYYY-MM-DD in most Node builds.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function localDigestHour(
  timeZone: string,
  now: Date = new Date(),
): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  // Some engines emit "24" for midnight.
  return hour === 24 ? 0 : hour;
}

export function getOwnerDigestSchedule(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  timeZone: string;
  hour: number;
} {
  const enabled =
    (env.OWNER_DIGEST_SCHEDULE_ENABLED || "").trim().toLowerCase() === "true" ||
    (env.OWNER_DIGEST_SCHEDULE_ENABLED || "").trim() === "1";
  const timeZone = env.OWNER_DIGEST_TZ?.trim() || "America/New_York";
  const parsed = Number.parseInt(env.OWNER_DIGEST_HOUR?.trim() || "7", 10);
  const hour = Number.isFinite(parsed) ? Math.min(23, Math.max(0, parsed)) : 7;
  return { enabled, timeZone, hour };
}

export function readLastDigestDateKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = digestStatePath(env);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { lastDateKey?: unknown };
    return typeof raw.lastDateKey === "string" ? raw.lastDateKey : null;
  } catch {
    return null;
  }
}

export function writeLastDigestDateKey(dateKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = digestStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ lastDateKey: dateKey, updatedAt: new Date().toISOString() }, null, 2));
}

export async function sendOwnerDigest(
  ctx: TrackerAssistantContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string; force?: boolean; now?: Date },
): Promise<OwnerDigestResult> {
  if (!telegramConfigured(env)) {
    return { ok: false, error: "Telegram is not configured" };
  }

  const schedule = getOwnerDigestSchedule(env);
  const now = options?.now ?? new Date();
  const dateKey = localDigestDateKey(schedule.timeZone, now);
  const text = buildOwnerDigestText(ctx, env, { title: options?.title });

  if (!options?.force) {
    const last = readLastDigestDateKey(env);
    if (last === dateKey) {
      return { ok: true, skipped: true, reason: `Already sent for ${dateKey}`, text };
    }
  }

  const sent = await sendTelegramMessage(text, env);
  if (!sent.ok) {
    return { ok: false, error: sent.error, text };
  }

  writeLastDigestDateKey(dateKey, env);
  return { ok: true, channel: "telegram", messageId: sent.messageId, text };
}

export function shouldRunScheduledDigest(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): { run: boolean; reason: string; dateKey: string } {
  const schedule = getOwnerDigestSchedule(env);
  const dateKey = localDigestDateKey(schedule.timeZone, now);
  if (!schedule.enabled) {
    return { run: false, reason: "Schedule disabled", dateKey };
  }
  if (!telegramConfigured(env)) {
    return { run: false, reason: "Telegram not configured", dateKey };
  }
  const hour = localDigestHour(schedule.timeZone, now);
  if (hour !== schedule.hour) {
    return { run: false, reason: `Waiting for hour ${schedule.hour} (local ${hour})`, dateKey };
  }
  if (readLastDigestDateKey(env) === dateKey) {
    return { run: false, reason: `Already sent for ${dateKey}`, dateKey };
  }
  return { run: true, reason: "Due", dateKey };
}

let scheduleTimer: ReturnType<typeof setInterval> | null = null;

export function startOwnerDigestScheduler(
  loadContext: () => Promise<TrackerAssistantContext>,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): void {
  if (scheduleTimer) return;
  const schedule = getOwnerDigestSchedule(env);
  if (!schedule.enabled) {
    log("Owner digest schedule off (set OWNER_DIGEST_SCHEDULE_ENABLED=true to enable).");
    return;
  }
  if (!telegramConfigured(env)) {
    log("Owner digest schedule enabled but Telegram env is incomplete.");
    return;
  }

  log(
    `Owner digest schedule on: ${schedule.hour}:00 ${schedule.timeZone} → Telegram.`,
  );

  const tick = async () => {
    const due = shouldRunScheduledDigest(env);
    if (!due.run) return;
    try {
      const ctx = await loadContext();
      const result = await sendOwnerDigest(ctx, env, {
        title: "Print Ops — morning briefing",
        force: false,
      });
      if (result.ok && !result.skipped) {
        log(`Owner digest sent (message ${result.messageId}).`);
      } else if (!result.ok) {
        log(`Owner digest failed: ${result.error}`);
      }
    } catch (error) {
      log(`Owner digest tick error: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };

  // First check shortly after boot, then every minute.
  void tick();
  scheduleTimer = setInterval(() => void tick(), 60_000);
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();
}
