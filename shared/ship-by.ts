/**
 * Shop-floor ship-by calendar helpers.
 *
 * Dates are always America/Los_Angeles calendar days (`YYYY-MM-DD`), matching
 * production-queue projection. Shared by Floor UI, Ask Ops, and Telegram digests.
 */

export const SHIP_BY_TIME_ZONE = "America/Los_Angeles";

export type ShipByAgendaBucket = "overdue" | "due_today" | "this_week" | "later";

export type ShipByAgendaItem = {
  shipBy: string;
  dealId?: string;
  dealName?: string;
};

export type ShipByWeekDay<T extends ShipByAgendaItem = ShipByAgendaItem> = {
  date: string;
  items: T[];
};

export type ShipByAgenda<T extends ShipByAgendaItem = ShipByAgendaItem> = {
  today: string;
  overdue: T[];
  dueToday: T[];
  thisWeek: T[];
  later: T[];
  /** Today through today+6 (7 shop days), each with deals due that day. */
  weekDays: ShipByWeekDay<T>[];
};

export function shipByCalendarDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHIP_BY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addShipByCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function shipByAgendaBucket(shipBy: string, today: string): ShipByAgendaBucket {
  if (shipBy < today) return "overdue";
  if (shipBy === today) return "due_today";
  const weekEnd = addShipByCalendarDays(today, 7);
  if (shipBy <= weekEnd) return "this_week";
  return "later";
}

function sortByShipThenName<T extends ShipByAgendaItem>(a: T, b: T): number {
  if (a.shipBy !== b.shipBy) return a.shipBy.localeCompare(b.shipBy);
  return String(a.dealName ?? a.dealId ?? "").localeCompare(String(b.dealName ?? b.dealId ?? ""));
}

export function groupShipByAgenda<T extends ShipByAgendaItem>(
  items: T[],
  today: string = shipByCalendarDate(),
): ShipByAgenda<T> {
  const overdue: T[] = [];
  const dueToday: T[] = [];
  const thisWeek: T[] = [];
  const later: T[] = [];

  for (const item of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.shipBy)) continue;
    switch (shipByAgendaBucket(item.shipBy, today)) {
      case "overdue":
        overdue.push(item);
        break;
      case "due_today":
        dueToday.push(item);
        break;
      case "this_week":
        thisWeek.push(item);
        break;
      default:
        later.push(item);
        break;
    }
  }

  overdue.sort(sortByShipThenName);
  dueToday.sort(sortByShipThenName);
  thisWeek.sort(sortByShipThenName);
  later.sort(sortByShipThenName);

  const weekDays: ShipByWeekDay<T>[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addShipByCalendarDays(today, offset);
    weekDays.push({
      date,
      items: items.filter((item) => item.shipBy === date).sort(sortByShipThenName),
    });
  }

  return { today, overdue, dueToday, thisWeek, later, weekDays };
}

export function formatShipByShort(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatShipByWeekday(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

export type ShopDateSource = "override" | "derived" | "local" | "unset";

/**
 * App-generated ship date. Tentative wins over set/plan.
 * Caller-typed notes stay untouched — this only labels the date itself.
 */
export function shopDateLabel(input: {
  date: string;
  today: string;
  source: ShopDateSource;
  tentative?: boolean;
}): string {
  const when =
    input.date < input.today
      ? `Overdue ${formatShipByShort(input.date)}`
      : input.date === input.today
        ? "Due today"
        : formatShipByShort(input.date);
  if (input.tentative) return `${when} · tentative`;
  const honesty =
    input.source === "override" || input.source === "local"
      ? " · set"
      : input.source === "unset"
        ? " · unset"
        : " · plan";
  return `${when}${honesty}`;
}

export function shipByHonestyLabel(
  shipBy: string,
  today: string = shipByCalendarDate(),
  source?: "override" | "derived",
): string {
  const base =
    shipBy < today
      ? `Overdue · ${formatShipByShort(shipBy)}`
      : shipBy === today
        ? "Due today"
        : `Ship ${formatShipByShort(shipBy)}`;
  if (source === "override") return `${base} · set`;
  if (source === "derived") return `${base} · plan`;
  return base;
}
