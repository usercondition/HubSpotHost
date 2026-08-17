/**
 * Owner morning digest: shop-floor briefing delivered via Telegram.
 *
 * Sections: do-first priorities, next print, plates on open orders,
 * fleet health, resin. Uses live Performance + printers + resin + plates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  PerformanceResponse,
  PrintFileRecord,
  PrinterFleetSnapshot,
  PrinterUsageBreakdown,
  ResinInventorySnapshot,
} from "../../shared/schema";
import {
  answerTrackerQuestionRules,
  type TrackerAssistantContext,
} from "./tracker-assistant";
import { sendTelegramMessage, telegramConfigured } from "./telegram";
import {
  formatMarketplaceFollowUpsForDigest,
  listConversationFollowUps,
  reopenExpiredSnoozes,
} from "./conversation-watchlist";

export type OwnerDigestContext = TrackerAssistantContext & {
  fleet: PrinterFleetSnapshot;
  resin: ResinInventorySnapshot;
  recentPlates: PrintFileRecord[];
};

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

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function hoursLabel(seconds: number | null | undefined): string {
  if (seconds == null || !(seconds > 0)) return "—";
  const hours = seconds / 3_600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysAgo(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

function fepDue(printer: PrinterUsageBreakdown): boolean {
  const hoursPct = printer.fepHoursUsedPercent ?? 0;
  const layersPct = printer.fepLayersUsedPercent ?? 0;
  return hoursPct >= 85 || layersPct >= 85;
}

function printerLine(printer: PrinterUsageBreakdown, now: Date): string {
  const bits: string[] = [];
  if (fepDue(printer)) {
    const pct = Math.max(printer.fepHoursUsedPercent ?? 0, printer.fepLayersUsedPercent ?? 0);
    bits.push(`FEP ~${Math.round(pct)}%`);
  }
  const ago = daysAgo(printer.lastJobAt, now);
  if (ago == null) bits.push("no plates yet");
  else if (ago === 0) bits.push("used today");
  else if (ago === 1) bits.push("used yesterday");
  else bits.push(`last plate ${ago}d ago`);
  if (printer.plateCount > 0) bits.push(`${printer.plateCount} plates`);
  return `• ${printer.name} — ${bits.join(" · ")}`;
}

function openDealIds(snapshot: PerformanceResponse): Set<string> {
  return new Set(snapshot.activeDeals.map((deal) => deal.dealId));
}

/** Latest attached plate per open deal — proxy for “in production.” */
export function platesOnOpenOrders(
  snapshot: PerformanceResponse,
  recentPlates: PrintFileRecord[],
  limit = 6,
): Array<{
  dealId: string;
  dealName: string;
  stage: string;
  fileName: string;
  printerProfile: string;
  printTimeSeconds: number | null;
  attachedAt: string;
  plateCount: number;
}> {
  const open = openDealIds(snapshot);
  const byDeal = new Map<string, PrintFileRecord[]>();
  for (const plate of recentPlates) {
    if (!open.has(plate.hubspotDealId)) continue;
    const list = byDeal.get(plate.hubspotDealId) ?? [];
    list.push(plate);
    byDeal.set(plate.hubspotDealId, list);
  }

  const rows = Array.from(byDeal.entries()).map(([dealId, plates]) => {
    const sorted = [...plates].sort((a, b) => b.attachedAt.localeCompare(a.attachedAt));
    const latest = sorted[0]!;
    const deal = snapshot.activeDeals.find((item) => item.dealId === dealId);
    return {
      dealId,
      dealName: deal?.dealName || latest.hubspotDealName || dealId,
      stage: deal?.stage || latest.dealStage || "Open",
      fileName: latest.fileName,
      printerProfile: latest.printerProfile?.trim() || "Unknown printer",
      printTimeSeconds: latest.printTimeSeconds,
      attachedAt: latest.attachedAt,
      plateCount: plates.length,
    };
  });

  rows.sort((a, b) => b.attachedAt.localeCompare(a.attachedAt));
  return rows.slice(0, limit);
}

/** Open deals still needing plates — suggested next work. */
export function nextPrintCandidates(snapshot: PerformanceResponse, limit = 4) {
  return snapshot.activeDeals
    .filter((deal) => !deal.hasPlates)
    .sort((a, b) => {
      const aClose = a.closeDate || "9999";
      const bClose = b.closeDate || "9999";
      if (aClose !== bClose) return aClose.localeCompare(bClose);
      return a.dealName.localeCompare(b.dealName);
    })
    .slice(0, limit);
}

export function buildOwnerDigestText(
  ctx: OwnerDigestContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string; now?: Date },
): string {
  const now = options?.now ?? new Date();
  const { snapshot, fleet, resin } = ctx;
  const briefing = answerTrackerQuestionRules("What should I do next?", ctx);
  const title = options?.title?.trim() || "Print Ops — morning briefing";
  const lines: string[] = [title, ""];

  // —— Do first (admin priorities from tracker rules) ——
  lines.push("DO FIRST");
  const priorityLines = briefing.reply
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line) || line.startsWith("Queue looks clear"));
  if (priorityLines.length > 0) {
    lines.push(...priorityLines);
  } else {
    lines.push(briefing.reply.trim().split("\n")[0] || "Queue looks clear.");
  }

  // —— Next print ——
  lines.push("", "NEXT PRINT");
  const next = nextPrintCandidates(snapshot);
  if (next.length === 0) {
    const withPlates = snapshot.activeDeals.filter((deal) => deal.hasPlates).length;
    lines.push(
      withPlates > 0
        ? `All ${withPlates} open order${withPlates === 1 ? "" : "s"} already have plate data. Review IN PRODUCTION or advance stages in HubSpot.`
        : "No open Print Orders waiting for plates.",
    );
  } else {
    for (const deal of next) {
      const amount = deal.amount > 0 ? ` · ${money(deal.amount)}` : "";
      const due = deal.closeDate ? ` · due ${shortDate(deal.closeDate)}` : "";
      lines.push(`• ${deal.dealName} — ${deal.stage}${amount}${due}`);
    }
  }

  // —— In production ——
  lines.push("", "IN PRODUCTION");
  const inProd = platesOnOpenOrders(snapshot, ctx.recentPlates);
  if (inProd.length === 0) {
    lines.push("No open orders with attached plates yet.");
  } else {
    for (const row of inProd) {
      const plates = row.plateCount > 1 ? ` · ${row.plateCount} plates` : "";
      lines.push(
        `• ${row.dealName} — ${row.fileName} · ${row.printerProfile} · ${hoursLabel(row.printTimeSeconds)}${plates}`,
      );
    }
  }

  // —— Fleet ——
  lines.push("", "FLEET");
  const active = fleet.printers.filter((printer) => printer.status === "active");
  const retired = fleet.printers.filter((printer) => printer.status === "retired").length;
  lines.push(
    `${fleet.fleetTotals.activePrinters} active` +
      (retired > 0 ? ` · ${retired} retired` : "") +
      ` · ${fleet.fleetTotals.plateCount} plates logged · ${fleet.fleetTotals.totalPrintHours.toFixed(0)}h total`,
  );

  const maintenance = active.filter(fepDue);
  const recentlyUsed = active
    .filter((printer) => {
      const ago = daysAgo(printer.lastJobAt, now);
      return ago != null && ago <= 7;
    })
    .sort((a, b) => (b.lastJobAt || "").localeCompare(a.lastJobAt || ""));

  if (maintenance.length > 0) {
    lines.push("Maintenance soon:");
    for (const printer of maintenance.slice(0, 4)) {
      lines.push(printerLine(printer, now));
    }
  }

  if (recentlyUsed.length > 0) {
    lines.push("Recently used:");
    for (const printer of recentlyUsed.slice(0, 5)) {
      if (maintenance.some((item) => item.printerId === printer.printerId)) continue;
      lines.push(printerLine(printer, now));
    }
  }

  if (maintenance.length === 0 && recentlyUsed.length === 0) {
    lines.push("No recent plate activity and no FEP warnings.");
  }

  // —— Resin ——
  lines.push("", "RESIN");
  if (resin.activeBottle) {
    const left = Math.max(0, resin.activeBottle.remainingMassG);
    const remainingPct =
      resin.activeBottle.initialMassG > 0
        ? Math.round((left / resin.activeBottle.initialMassG) * 100)
        : Math.max(0, Math.round(100 - resin.activeBottle.usedPercent));
    lines.push(`Active: ${resin.activeBottle.productName} · ~${left.toFixed(0)}g left (${remainingPct}%)`);
  } else {
    lines.push("No active open bottle set.");
  }
  const lowSealed = resin.products.filter((product) => product.sealedCount <= 1);
  if (lowSealed.length > 0) {
    lines.push(
      `Low sealed: ${lowSealed
        .slice(0, 4)
        .map((product) => `${product.name} (${product.sealedCount})`)
        .join(", ")}`,
    );
  } else {
    lines.push(
      `Sealed stock: ${resin.totals.sealedBottles} bottle${resin.totals.sealedBottles === 1 ? "" : "s"} · ${money(resin.totals.sealedValueUsd)}`,
    );
  }

  // —— Marketplace chat follow-ups (from Chrome helper watchlist) ——
  reopenExpiredSnoozes(now);
  const followUps = listConversationFollowUps({
    now,
    waitingOnYouOnly: true,
    minHoursWaiting: 0,
    limit: 8,
  });
  lines.push("", "MARKETPLACE FOLLOW-UPS");
  lines.push(...formatMarketplaceFollowUpsForDigest(followUps, 5));

  // —— Snapshot footer + links ——
  lines.push("");
  lines.push(
    `Snapshot: ${snapshot.summary.activeOrders} active · ${snapshot.summary.attentionCount} attention · intake ${snapshot.intake.pendingReview}/${snapshot.intake.awaitingClient} (review/awaiting)`,
  );

  const actions = [...briefing.actions];
  const extra = [
    { label: "Printers", href: "/printers" },
    { label: "Resin", href: "/resin" },
    { label: "Print files", href: "/prints" },
  ];
  for (const action of extra) {
    if (!actions.some((item) => item.href === action.href)) actions.push(action);
  }

  if (actions.length > 0) {
    lines.push("", "Open:");
    for (const action of actions.slice(0, 6)) {
      lines.push(`• ${action.label}: ${absoluteActionHref(action.href, env)}`);
    }
  }

  const text = lines.join("\n").trim();
  // Keep headroom under Telegram's 4096 limit.
  return text.length > 3900 ? `${text.slice(0, 3890)}\n…` : text;
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
  ctx: OwnerDigestContext,
  env: NodeJS.ProcessEnv = process.env,
  options?: { title?: string; force?: boolean; now?: Date },
): Promise<OwnerDigestResult> {
  if (!telegramConfigured(env)) {
    return { ok: false, error: "Telegram is not configured" };
  }

  const schedule = getOwnerDigestSchedule(env);
  const now = options?.now ?? new Date();
  const dateKey = localDigestDateKey(schedule.timeZone, now);
  const text = buildOwnerDigestText(ctx, env, { title: options?.title, now });

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
  loadContext: () => Promise<OwnerDigestContext>,
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

  log(`Owner digest schedule on: ${schedule.hour}:00 ${schedule.timeZone} → Telegram.`);

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

  void tick();
  scheduleTimer = setInterval(() => void tick(), 60_000);
  if (typeof scheduleTimer.unref === "function") scheduleTimer.unref();
}
