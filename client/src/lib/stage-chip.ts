/** Shared stage chip labels. Phone uses the short form so the chip is not clipped. */

export type StageTone = "teal" | "fly" | "warn" | "good" | "shop" | "neutral";
export type OrderStatusKey = "queued" | "printing" | "review" | "waiting-address" | "ready" | "pickup" | "done" | "open";

export interface OrderStatusPresentation {
  key: OrderStatusKey;
  label: string;
  short: string;
  tone: StageTone;
}

export function stagePresentation(stage: string): OrderStatusPresentation {
  const value = stage.toLowerCase();
  if (value.includes("post") || value.includes("qc")) return { key: "review", label: "Post-process / QC", short: "QC", tone: "warn" };
  if (value.includes("ready")) return { key: "ready", label: "Ready to ship", short: "Ready", tone: "good" };
  if (value.includes("shipped") || value.includes("picked up")) return { key: "done", label: "Done", short: "Done", tone: "good" };
  if (value.includes("pickup") || value.includes("off-book") || value.includes("offbook")) {
    return { key: "pickup", label: "Pickup", short: "Pickup", tone: "shop" };
  }
  if (value.includes("queue") || value.includes("plate")) return { key: "queued", label: "Queued to print", short: "Queued", tone: "teal" };
  if (value.includes("print")) return { key: "printing", label: "Printing", short: "Printing", tone: "fly" };
  return { key: "open", label: stage || "Open", short: stage || "Open", tone: "neutral" };
}

/**
 * The checklist can identify an address hold even while HubSpot's pipeline
 * stage says "Ready to Ship". Use it everywhere status is presented so the
 * operator sees the actionable state first.
 */
export function orderStatusPresentation(input: {
  stage: string;
  blocker?: string | null;
  addressVerified?: boolean | null;
  shippingRequired?: boolean;
  done?: boolean;
}): OrderStatusPresentation {
  if (input.done) return { key: "done", label: "Done", short: "Done", tone: "good" };
  const blocker = input.blocker?.toLowerCase() ?? "";
  if (
    input.shippingRequired !== false &&
    (input.addressVerified === false || blocker.includes("address"))
  ) {
    return { key: "waiting-address", label: "Waiting on address", short: "Address", tone: "warn" };
  }
  return stagePresentation(input.stage);
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
