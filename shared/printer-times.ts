/**
 * Print time text for the Printers cards. Every clock is Pacific Time (the shop's zone)
 * no matter where the browser is. Every helper is null/NaN safe: a job without a
 * duration says "finish unknown" instead of NaN or a broken progress bar.
 */
export const SHOP_TIME_ZONE = "America/Los_Angeles";

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function validSeconds(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** "4h 05m" / "45m" / "under 1m"; "" when unknown. */
export function formatDurationShort(seconds: number | null | undefined): string {
  const s = validSeconds(seconds);
  if (s == null) return "";
  if (s < 60) return "under 1m";
  const totalMin = Math.round(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** "5.3 h" style hours for a file's estimate (voice + Start this job). */
export function formatHours(seconds: number | null | undefined): string {
  const s = validSeconds(seconds);
  if (s == null) return "";
  const h = s / 3600;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} h`;
}

function ptParts(ms: number): { day: string; key: string; time: string } {
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TIME_ZONE, weekday: "short" }).format(date);
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return { day, key, time };
}

/** "7:42 PM" when on the same PT day as now, else "Sun 3:10 AM". "" when invalid. */
export function formatClockPT(iso: string | null | undefined, nowMs: number): string {
  const ms = toMs(iso);
  if (ms == null || !Number.isFinite(nowMs)) return "";
  const at = ptParts(ms);
  const now = ptParts(nowMs);
  return at.key === now.key ? at.time : `${at.day} ${at.time}`;
}

export type RunTimes = {
  started: string;
  /** Total estimated duration, "" when the job has none. */
  total: string;
  /** "2h 10m left", "" when unknown or already past. */
  left: string;
  /** "10:15 PM PT" or "finish unknown". */
  finish: string;
  hasEstimate: boolean;
  /** 0..100 integer, null when there is no estimate (no bar is drawn). */
  pct: number | null;
};

/** Times for a printing card. */
export function describeRunTimes(
  run: { startedAt: string; etaAt?: string | null; estSeconds?: number | null },
  nowMs: number,
): RunTimes {
  const start = toMs(run.startedAt);
  let total = validSeconds(run.estSeconds ?? null);
  let eta = toMs(run.etaAt ?? null);
  if (total == null && start != null && eta != null && eta > start) total = (eta - start) / 1000;
  if (eta == null && start != null && total != null) eta = start + total * 1000;
  const started = start != null ? `${formatClockPT(run.startedAt, nowMs)} PT` : "";
  if (start == null || total == null || eta == null) {
    return { started, total: "", left: "", finish: "finish unknown", hasEstimate: false, pct: null };
  }
  const remaining = Math.max(0, Math.round((eta - nowMs) / 1000));
  const pct = Math.round(Math.min(1, Math.max(0, (nowMs - start) / (eta - start))) * 100);
  return {
    started,
    total: formatDurationShort(total),
    left: remaining >= 60 ? `${formatDurationShort(remaining)} left` : remaining > 0 ? "under 1m left" : "should be done",
    finish: `${formatClockPT(new Date(eta).toISOString(), nowMs)} PT`,
    hasEstimate: true,
    pct: Number.isFinite(pct) ? pct : null,
  };
}

/** Times for an idle card's last run: "ran 4h 05m · ended 3:10 PM PT". */
export function describeLastRun(
  last: { startedAt?: string | null; endedAt: string; durationSeconds?: number | null },
  nowMs: number,
): { duration: string; ended: string } {
  let duration = validSeconds(last.durationSeconds ?? null);
  const start = toMs(last.startedAt ?? null);
  const end = toMs(last.endedAt);
  if (duration == null && start != null && end != null && end > start) duration = (end - start) / 1000;
  return {
    duration: formatDurationShort(duration),
    ended: end != null ? `${formatClockPT(last.endedAt, nowMs)} PT` : "",
  };
}
