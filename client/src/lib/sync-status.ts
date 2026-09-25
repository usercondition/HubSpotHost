/** Pacific clock labels for the top-bar sync pill and snapshot crumb. */

export function formatPacificClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(date)
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ");
  return `${time} PT`;
}

export function formatPacificSnapshot(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `Snapshot ${formatPacificClock(iso)} · ${part("weekday")} ${part("month")} ${part("day")}`;
}

export function syncPillCopy(summary: {
  issueCount?: number;
  writes?: { pending?: number; failed?: number };
  lastCheckedAt?: string | null;
} | null | undefined): { tone: "good" | "warn"; label: string } {
  const issues = summary?.issueCount ?? 0;
  const pending = summary?.writes?.pending ?? 0;
  const failed = summary?.writes?.failed ?? 0;
  if (issues > 0 || pending > 0 || failed > 0) {
    const parts: string[] = [];
    if (issues > 0) parts.push(`${issues} ${issues === 1 ? "issue" : "issues"}`);
    if (pending > 0) parts.push(`${pending} pending`);
    if (failed > 0) parts.push(`${failed} failed`);
    return { tone: "warn", label: `HubSpot sync: ${parts.join(" · ")}` };
  }
  const clock = summary?.lastCheckedAt ? formatPacificClock(summary.lastCheckedAt) : "";
  return { tone: "good", label: clock ? `HubSpot in sync · ${clock}` : "HubSpot in sync" };
}
