/** Shared display helpers — keep $ and dates consistent across Daily Work pages. */

export function formatMoney(value: number, options?: { compact?: boolean }): string {
  const compact = options?.compact !== false;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact && value % 1 === 0 ? 0 : 2,
  });
}

export function formatLocalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit", year: "numeric" });
}

export function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
