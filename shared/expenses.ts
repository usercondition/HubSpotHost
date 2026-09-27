/**
 * Shop expenses that are not tied to one order.
 * Amounts are integer cents. Nothing here is written to HubSpot.
 */
import { z } from "zod";

export const EXPENSE_CATEGORIES = [
  "models_patreon",
  "model_marketplace",
  "software_ai",
  "hosting",
  "materials",
  "equipment",
  "shipping_supplies",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  models_patreon: "Models/Patreon",
  model_marketplace: "Model marketplace (MMF)",
  software_ai: "Software/AI",
  hosting: "Hosting",
  materials: "Materials",
  equipment: "Equipment",
  shipping_supplies: "Shipping supplies",
  other: "Other",
};

export const EXPENSE_CADENCES = ["one-off", "monthly", "yearly"] as const;
export type ExpenseCadence = (typeof EXPENSE_CADENCES)[number];

export const EXPENSE_CADENCE_LABELS: Record<ExpenseCadence, string> = {
  "one-off": "One-off",
  monthly: "Monthly",
  yearly: "Yearly",
};

export const OVERHEAD_FORMULA =
  "One-off expenses whose date falls in the period, plus each monthly or yearly expense for the days it was active in the period. A monthly amount is divided by the days in that month. A yearly amount is divided by the days in that year. Archived expenses are left out. Each expense is counted once. Supply receipts are not included.";

export const NET_PROFIT_FORMULA =
  "Gross profit for the period minus overhead for the same period. Supply receipts are not subtracted again.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ExpenseSlice {
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string | null;
  archived: boolean;
}

export function containsCardNumber(value: string): boolean {
  return /\d(?:[ -]*\d){12,18}/.test(value);
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export function formatShopDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match || !isIsoDate(match[0])) return value.trim();
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  const year = Number(match[1]);
  const thisYear = new Date().getUTCFullYear();
  return year === thisYear ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10_000_000) return null;
  return cents;
}

export function formatUsdFromCents(cents: number): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return (safe / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function addDays(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

function daysInMonth(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function daysInYear(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 366 : 365;
}

export function expenseActiveOn(expense: ExpenseSlice, day: string): boolean {
  if (expense.archived) return false;
  if (!isIsoDate(expense.startDate) || day < expense.startDate) return false;
  if (expense.endDate && day > expense.endDate) return false;
  return true;
}

/** Monthly run-rate. Yearly is amount ÷ 12. One-offs are not a run-rate. */
export function monthlyEquivalentCents(expense: ExpenseSlice, today: string): number | null {
  if (!expenseActiveOn(expense, today)) return null;
  if (expense.cadence === "monthly") return expense.amountCents;
  if (expense.cadence === "yearly") return Math.round(expense.amountCents / 12);
  return null;
}

export function monthlyRunRateCents(expenses: ExpenseSlice[], today: string): number {
  let total = 0;
  for (const expense of expenses) {
    const share = monthlyEquivalentCents(expense, today);
    if (share != null) total += share;
  }
  return total;
}

/**
 * Overhead for an inclusive date span. `start` null means from each expense's own start.
 * One-offs count once, on their start date. Recurring costs are the daily slice of each active day.
 */
export function overheadCentsForDates(expenses: ExpenseSlice[], start: string | null, end: string): number {
  if (!isIsoDate(end)) return 0;
  let total = 0;
  for (const expense of expenses) {
    if (expense.archived || !isIsoDate(expense.startDate)) continue;
    if (expense.cadence === "one-off") {
      const inSpan = (start == null || expense.startDate >= start) && expense.startDate <= end;
      if (inSpan) total += expense.amountCents;
      continue;
    }
    let day = start == null || expense.startDate > start ? expense.startDate : start;
    const last = expense.endDate && expense.endDate < end ? expense.endDate : end;
    if (day > last) continue;
    let guard = 0;
    while (day <= last && guard < 20000) {
      if (expenseActiveOn(expense, day)) {
        const divisor = expense.cadence === "monthly" ? daysInMonth(day) : daysInYear(day);
        total += expense.amountCents / divisor;
      }
      day = addDays(day, 1);
      guard += 1;
    }
  }
  return Math.round(total);
}

export function overheadDollars(cents: number): number {
  return Math.round(cents) / 100;
}

export function netProfitAfterOverhead(grossProfit: number | null, overheadCents: number): number | null {
  if (grossProfit == null || !Number.isFinite(grossProfit)) return null;
  return Math.round((grossProfit - overheadDollars(overheadCents) + Number.EPSILON) * 100) / 100;
}

const dateField = z.string().trim().refine(isIsoDate, "Use a real date");

const moneyFields = {
  vendor: z.string().trim().min(1, "Enter a vendor").max(120),
  name: z.string().trim().min(1, "Enter a name").max(180),
  category: z.enum(EXPENSE_CATEGORIES),
  amountCents: z.number().int().min(1, "Enter an amount").max(10_000_000),
  currency: z.literal("USD").default("USD"),
  cadence: z.enum(EXPENSE_CADENCES),
  startDate: dateField,
  endDate: z.union([dateField, z.literal(""), z.null()]).optional(),
  paymentNote: z.string().trim().max(80).default(""),
  notes: z.string().trim().max(2000).default(""),
};

function refineExpense(value: { startDate: string; endDate?: string | null; paymentNote: string; notes: string }, ctx: z.RefinementCtx) {
  const end = value.endDate?.trim() || null;
  if (end && end < value.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The end date is before the start date", path: ["endDate"] });
  }
  if (containsCardNumber(value.paymentNote) || containsCardNumber(value.notes)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Leave card numbers out. A short note like the card name is enough.",
      path: ["paymentNote"],
    });
  }
}

export const createExpenseSchema = z
  .object({
    clientKey: z
      .string()
      .trim()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/, "Use a simple id for this expense"),
    ...moneyFields,
  })
  .superRefine(refineExpense);

export const updateExpenseSchema = z
  .object({
    vendor: moneyFields.vendor.optional(),
    name: moneyFields.name.optional(),
    category: moneyFields.category.optional(),
    amountCents: moneyFields.amountCents.optional(),
    currency: moneyFields.currency.optional(),
    cadence: moneyFields.cadence.optional(),
    startDate: dateField.optional(),
    endDate: z.union([dateField, z.literal(""), z.null()]).optional(),
    paymentNote: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(2000).optional(),
    archived: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (containsCardNumber(value.paymentNote ?? "") || containsCardNumber(value.notes ?? "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Leave card numbers out. A short note like the card name is enough.",
        path: ["paymentNote"],
      });
    }
  });

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
