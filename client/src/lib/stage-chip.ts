/** Shared stage chip labels. Phone uses the short form so the chip is not clipped. */

export type StageTone = "teal" | "fly" | "warn" | "good" | "shop" | "neutral";

export function stagePresentation(stage: string): { label: string; short: string; tone: StageTone } {
  const value = stage.toLowerCase();
  if (value.includes("post") || value.includes("qc")) return { label: stage, short: "Post / QC", tone: "warn" };
  if (value.includes("ready") || value.includes("shipped")) return { label: stage, short: "Ready", tone: "good" };
  if (value.includes("pickup") || value.includes("off-book") || value.includes("offbook")) {
    return { label: stage, short: "Pickup", tone: "shop" };
  }
  if (value.includes("queue") || value.includes("plate")) return { label: stage, short: "Queued", tone: "teal" };
  if (value.includes("print")) return { label: stage, short: "Printing", tone: "fly" };
  return { label: stage || "Open", short: stage || "Open", tone: "neutral" };
}

export function floorGreeting(now: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function pacificDayLabel(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")} ${part("month")} ${part("day")}`;
}
