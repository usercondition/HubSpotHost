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
import { sendTelegramMessage, telegramConfigured } from "./telegram";

const NUDGE_ISSUE_KEYS = new Set(["no_plates", "costs_incomplete", "stale"]);

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

function htmlLink(label: string, href: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function groupHeading(issueKey: string): { title: string; hint: string } {
  switch (issueKey) {
    case "no_plates":
      return { title: "Plates", hint: "attach sliced files" };
    case "costs_incomplete":
      return { title: "Costs", hint: "add as they become known" };
    case "stale":
      return { title: "Stale", hint: "no HubSpot update in 7+ days" };
    default:
      return { title: "Attention", hint: "needs a look" };
  }
}

function hrefForIssue(issueKey: string, dealId: string): string {
  if (issueKey === "no_plates") {
    return `/prints?dealId=${encodeURIComponent(dealId)}`;
  }
  return `/queue?dealId=${encodeURIComponent(dealId)}`;
}

export function buildHealthNudgeText(
  ctx: TrackerAssistantContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string },
): { text: string; fingerprint: string; hasWork: boolean } {
  const snapshot = ctx.snapshot;
  const collected = collectHealthNudgeItems(snapshot);
  const fingerprint = healthNudgeFingerprint(snapshot);
  const title = options?.title?.trim() || "Print Ops — health check";

  if (!collected.hasWork) {
    return {
      text: `<b>${escapeHtml(title)}</b>\n\nAll clear — no missing plates, incomplete costs, stale deals, or stuck intake.`,
      fingerprint,
      hasWork: false,
    };
  }

  const lines: string[] = [`<b>${escapeHtml(title)}</b>`];
  const needBits: string[] = [];
  if (collected.attention.length > 0) {
    needBits.push(
      `${collected.attention.length} deal${collected.attention.length === 1 ? "" : "s"}`,
    );
  }
  if (collected.intakePending > 0) {
    needBits.push(`${collected.intakePending} to review`);
  }
  if (collected.intakeAwaiting > 0) {
    needBits.push(`${collected.intakeAwaiting} awaiting buyer`);
  }
  lines.push(`Needs you: ${needBits.join(" · ")}`);

  if (collected.intakePending > 0 || collected.intakeAwaiting > 0) {
    lines.push("");
    lines.push(`<b>Intake</b> · ${htmlLink("open", absoluteActionHref("/orders", env))}`);
    if (collected.intakePending > 0) {
      lines.push(
        `• ${collected.intakePending} paid order${collected.intakePending === 1 ? "" : "s"} waiting for review`,
      );
    }
    if (collected.intakeAwaiting > 0) {
      lines.push(
        `• ${collected.intakeAwaiting} buyer form${collected.intakeAwaiting === 1 ? "" : "s"} still open`,
      );
    }
  }

  const byKey = new Map<string, typeof collected.attention>();
  for (const item of collected.attention) {
    const list = byKey.get(item.issueKey) ?? [];
    list.push(item);
    byKey.set(item.issueKey, list);
  }

  for (const issueKey of ["no_plates", "costs_incomplete", "stale"]) {
    const items = byKey.get(issueKey);
    if (!items || items.length === 0) continue;
    const heading = groupHeading(issueKey);
    lines.push("");
    lines.push(`<b>${heading.title}</b> · ${escapeHtml(heading.hint)}`);
    for (const item of items.slice(0, 6)) {
      const href = absoluteActionHref(hrefForIssue(item.issueKey, item.dealId), env);
      const name = htmlLink(shortLabel(item.dealName), href);
      const stage = item.stage.trim() ? ` · ${escapeHtml(shortLabel(item.stage, 24))}` : "";
      lines.push(`• ${name}${stage}`);
    }
    if (items.length > 6) {
      const moreHref =
        issueKey === "no_plates"
          ? absoluteActionHref("/prints", env)
          : absoluteActionHref("/queue", env);
      lines.push(`• ${htmlLink(`and ${items.length - 6} more`, moreHref)}`);
    }
  }

  lines.push("");
  lines.push(
    `${snapshot.summary.activeOrders} active · ${htmlLink("Floor", absoluteActionHref("/", env))} · ${htmlLink("Stats", absoluteActionHref("/performance", env))}`,
  );

  const text = lines.join("\n").trim();
  return {
    text: text.length > 3900 ? `${text.slice(0, 3890)}\n…` : text,
    fingerprint,
    hasWork: true,
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
  const built = buildHealthNudgeText(ctx, env, { title: options?.title });

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

  const sent = await sendTelegramMessage(built.text, env, fetch, { parseMode: "HTML" });
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
