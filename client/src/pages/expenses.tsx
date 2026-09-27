import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { SHOP_PERIODS, type ShopPeriodId } from "@shared/shop-dashboard";
import {
  EXPENSE_CADENCE_LABELS,
  EXPENSE_CADENCES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  dollarsToCents,
  formatShopDate,
  formatUsdFromCents,
  type ExpenseCadence,
  type ExpenseCategory,
} from "@shared/expenses";

interface ExpenseRow {
  id: number;
  clientKey: string;
  vendor: string;
  name: string;
  category: ExpenseCategory;
  amountCents: number;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string | null;
  paymentNote: string;
  notes: string;
  archived: boolean;
  monthlyEquivalentCents: number | null;
  periodCents: number;
}

interface ExpenseList {
  ok: true;
  period: { id: ShopPeriodId; label: string; start: string | null; end: string };
  stored: number;
  expenses: ExpenseRow[];
  totals: { monthlyRunRateCents: number; periodCents: number };
}

const PERIOD_LABEL: Record<ShopPeriodId, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  ytd: "Year to date",
  all: "All time",
};

function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function newClientKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Draft {
  clientKey: string;
  vendor: string;
  name: string;
  category: ExpenseCategory | "";
  amount: string;
  cadence: ExpenseCadence;
  startDate: string;
  endDate: string;
  paymentNote: string;
  notes: string;
}

function emptyDraft(): Draft {
  return {
    clientKey: newClientKey(),
    vendor: "",
    name: "",
    category: "",
    amount: "",
    cadence: "monthly",
    startDate: localToday(),
    endDate: "",
    paymentNote: "",
    notes: "",
  };
}

function draftFrom(expense: ExpenseRow): Draft {
  return {
    clientKey: expense.clientKey,
    vendor: expense.vendor,
    name: expense.name,
    category: expense.category,
    amount: (expense.amountCents / 100).toFixed(2),
    cadence: expense.cadence,
    startDate: expense.startDate,
    endDate: expense.endDate ?? "",
    paymentNote: expense.paymentNote,
    notes: expense.notes,
  };
}

function plainError(error: unknown): string {
  const text = error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "";
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* The body is already a sentence. */
  }
  return text || "Could not save that expense.";
}

export default function ExpensesPage() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Expenses unlocked",
    successDescription: "Shop costs that are not tied to one order.",
  });
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<ShopPeriodId>("30");
  const [category, setCategory] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const listed = useQuery({
    queryKey: ["/api/expenses", ownerCode, period, category, showArchived],
    enabled: isUnlocked,
    queryFn: async () => {
      const params = new URLSearchParams({ period });
      if (category) params.set("category", category);
      if (showArchived) params.set("archived", "1");
      const response = await apiRequest("GET", `/api/expenses?${params.toString()}`, undefined, { headers });
      return (await response.json()) as ExpenseList;
    },
  });

  const groups = useMemo(() => {
    const rows = listed.data?.expenses ?? [];
    return {
      recurring: rows.filter((row) => row.cadence !== "one-off"),
      once: rows.filter((row) => row.cadence === "one-off"),
    };
  }, [listed.data]);

  async function save() {
    if (!draft) return;
    const amountCents = dollarsToCents(draft.amount);
    if (!draft.vendor.trim() || !draft.name.trim() || !draft.category || amountCents == null) {
      setError("Enter a vendor, a name, a category, and an amount.");
      return;
    }
    setSaving(true);
    setError("");
    const body = {
      vendor: draft.vendor.trim(),
      name: draft.name.trim(),
      category: draft.category,
      amountCents,
      currency: "USD" as const,
      cadence: draft.cadence,
      startDate: draft.startDate,
      endDate: draft.endDate.trim() || null,
      paymentNote: draft.paymentNote.trim(),
      notes: draft.notes.trim(),
    };
    try {
      if (editingId == null) {
        await apiRequest("POST", "/api/expenses", { ...body, clientKey: draft.clientKey }, { headers });
      } else {
        await apiRequest("PATCH", `/api/expenses/${editingId}`, body, { headers });
      }
      setDraft(null);
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
    } catch (reason) {
      setError(plainError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function archive(id: number) {
    setMenuId(null);
    setError("");
    try {
      await apiRequest("POST", `/api/expenses/${id}/archive`, {}, { headers });
      await queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
    } catch (reason) {
      setError(plainError(reason));
    }
  }

  async function cancel(expense: ExpenseRow) {
    setMenuId(null);
    setError("");
    try {
      await apiRequest("PATCH", `/api/expenses/${expense.id}`, { endDate: localToday() }, { headers });
      await queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
    } catch (reason) {
      setError(plainError(reason));
    }
  }

  const totals = listed.data?.totals;

  return (
    <div className="mx-auto flex max-w-6xl flex-col" data-testid="page-expenses">
      <PageHeader title="Expenses" subtitle="Shop costs that are not tied to one order." />
      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock expenses"
            description="Same owner code as Floor. Subscriptions and one-off shop purchases stay in Print Ops."
            buttonLabel="Unlock expenses"
            testIdPrefix="expenses"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="library-printer-chips" data-testid="expense-period-chips">
                {SHOP_PERIODS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="library-printer-chip"
                    data-testid={`chip-expense-period-${id}`}
                    data-active={period === id ? "true" : "false"}
                    onClick={() => setPeriod(id)}
                  >
                    {PERIOD_LABEL[id]}
                  </button>
                ))}
              </div>
              <Button
                type="button"
                size="sm"
                data-testid="button-add-expense"
                onClick={() => {
                  setEditingId(null);
                  setDraft(emptyDraft());
                  setError("");
                }}
              >
                Add expense
              </Button>
            </div>
            <div className="library-printer-chips" data-testid="expense-category-chips">
              <button
                type="button"
                className="library-printer-chip"
                data-testid="chip-expense-category-all"
                data-active={category ? "false" : "true"}
                onClick={() => setCategory("")}
              >
                All categories
              </button>
              {EXPENSE_CATEGORIES.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="library-printer-chip"
                  data-testid={`chip-expense-category-${id}`}
                  data-active={category === id ? "true" : "false"}
                  onClick={() => setCategory(id)}
                >
                  {EXPENSE_CATEGORY_LABELS[id]}
                </button>
              ))}
              <button
                type="button"
                className="library-printer-chip"
                data-testid="chip-expense-archived"
                data-active={showArchived ? "true" : "false"}
                onClick={() => setShowArchived((value) => !value)}
              >
                Archived
              </button>
            </div>
            {listed.isLoading ? <Skeleton className="h-40 rounded-lg" /> : null}
            {listed.isError ? <p className="text-sm text-destructive">Could not load expenses.</p> : null}
            {error && !draft ? <p className="text-sm text-destructive">{error}</p> : null}
            {listed.data && listed.data.expenses.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-expenses-empty">
                {listed.data.stored === 0
                  ? "No expenses yet. Add a subscription or a one-off shop purchase. Nothing is filled in until you enter it."
                  : "No expenses match that filter."}
              </p>
            ) : null}
            {listed.data && listed.data.expenses.length > 0 ? (
              <div data-testid="expense-list">
                <div className="expense-head" aria-hidden="true">
                  <span>Name</span>
                  <span>Category</span>
                  <span>Cadence</span>
                  <span>Started</span>
                  <span className="expense-amount">Amount</span>
                  <span className="expense-monthly">Monthly</span>
                  <span className="expense-period">Period</span>
                  <span />
                </div>
                <div className="expense-row" data-testid="expense-totals">
                  <span className="expense-name text-sm font-semibold">Totals</span>
                  <span className="expense-category" />
                  <span className="expense-cadence" />
                  <span className="expense-started" />
                  <span className="expense-amount" />
                  <span className="expense-monthly text-sm font-semibold" data-testid="expense-run-rate">
                    {formatUsdFromCents(totals?.monthlyRunRateCents ?? 0)}
                  </span>
                  <span className="expense-period text-sm font-semibold" data-testid="expense-period-total">
                    {formatUsdFromCents(totals?.periodCents ?? 0)}
                  </span>
                  <span className="expense-menu" />
                  <p className="expense-meta">Monthly run-rate {formatUsdFromCents(totals?.monthlyRunRateCents ?? 0)}</p>
                </div>
                {(
                  [
                    ["Recurring", groups.recurring],
                    ["One-off", groups.once],
                  ] as const
                ).map(([label, rows]) =>
                  rows.length === 0 ? null : (
                    <section key={label}>
                      <h2 className="expense-group">{label}</h2>
                      {rows.map((expense) => (
                        <article key={expense.id} className="expense-row" data-testid={`expense-row-${expense.id}`}>
                          <div className="expense-name min-w-0">
                            <p className="truncate text-sm font-semibold">{expense.name}</p>
                            <p className="truncate text-xs text-muted-foreground">{expense.vendor}</p>
                          </div>
                          <span className="expense-category truncate text-sm">{EXPENSE_CATEGORY_LABELS[expense.category]}</span>
                          <span className="expense-cadence truncate text-sm">{EXPENSE_CADENCE_LABELS[expense.cadence]}</span>
                          <span className="expense-started text-sm" data-testid="expense-started">
                            {formatShopDate(expense.startDate)}
                          </span>
                          <span className="expense-amount text-sm" data-testid="expense-amount">
                            {formatUsdFromCents(expense.amountCents)}
                          </span>
                          <span className="expense-monthly text-sm" data-testid="expense-monthly">
                            {expense.monthlyEquivalentCents == null ? "—" : formatUsdFromCents(expense.monthlyEquivalentCents)}
                          </span>
                          <span className="expense-period text-sm" data-testid="expense-period">
                            {formatUsdFromCents(expense.periodCents)}
                          </span>
                          <div className="expense-menu">
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label={`Actions for ${expense.name}`}
                              aria-expanded={menuId === expense.id}
                              data-testid={`button-expense-menu-${expense.id}`}
                              onClick={() => setMenuId((current) => (current === expense.id ? null : expense.id))}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                            {menuId === expense.id ? (
                              <div className="expense-menu-panel rounded-md border border-border bg-popover p-1 text-sm shadow-md">
                                <button
                                  type="button"
                                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                                  data-testid={`button-edit-expense-${expense.id}`}
                                  onClick={() => {
                                    setMenuId(null);
                                    setEditingId(expense.id);
                                    setDraft(draftFrom(expense));
                                    setError("");
                                  }}
                                >
                                  Edit
                                </button>
                                {expense.cadence !== "one-off" && !expense.endDate ? (
                                  <button
                                    type="button"
                                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                                    data-testid={`button-cancel-expense-${expense.id}`}
                                    onClick={() => void cancel(expense)}
                                  >
                                    Cancel
                                  </button>
                                ) : null}
                                {!expense.archived ? (
                                  <button
                                    type="button"
                                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                                    data-testid={`button-archive-expense-${expense.id}`}
                                    onClick={() => void archive(expense.id)}
                                  >
                                    Archive
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          <p className="expense-meta">
                            {[
                              EXPENSE_CATEGORY_LABELS[expense.category],
                              EXPENSE_CADENCE_LABELS[expense.cadence],
                              formatShopDate(expense.startDate),
                              expense.monthlyEquivalentCents == null ? "" : `${formatUsdFromCents(expense.monthlyEquivalentCents)} / mo`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </article>
                      ))}
                    </section>
                  ),
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
      {draft ? (
        <div className="fixed inset-0 z-[80] flex justify-end bg-black/50" data-testid="drawer-expense" onClick={() => setDraft(null)}>
          <form
            className="h-full w-full max-w-md overflow-auto border-l border-border bg-card p-4"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{editingId == null ? "Add expense" : "Edit expense"}</h2>
              <button type="button" className="text-sm text-primary" data-testid="button-close-expense" onClick={() => setDraft(null)}>
                Close
              </button>
            </div>
            <div className="space-y-3">
              <label className="block text-sm">
                Vendor
                <input className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.vendor} maxLength={120} data-testid="input-expense-vendor" onChange={(event) => setDraft({ ...draft, vendor: event.target.value })} />
              </label>
              <label className="block text-sm">
                Name
                <input className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.name} maxLength={180} data-testid="input-expense-name" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label className="block text-sm">
                Category
                <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.category} data-testid="select-expense-category" onChange={(event) => setDraft({ ...draft, category: event.target.value as ExpenseCategory })}>
                  <option value="">Choose</option>
                  {EXPENSE_CATEGORIES.map((id) => (
                    <option key={id} value={id}>
                      {EXPENSE_CATEGORY_LABELS[id]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Amount (USD)
                <input className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" inputMode="decimal" value={draft.amount} data-testid="input-expense-amount" onChange={(event) => setDraft({ ...draft, amount: event.target.value })} />
              </label>
              <label className="block text-sm">
                Cadence
                <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.cadence} data-testid="select-expense-cadence" onChange={(event) => setDraft({ ...draft, cadence: event.target.value as ExpenseCadence })}>
                  {EXPENSE_CADENCES.map((id) => (
                    <option key={id} value={id}>
                      {EXPENSE_CADENCE_LABELS[id]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-sm">
                  Start
                  <input type="date" className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.startDate} data-testid="input-expense-start" onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} />
                </label>
                <label className="block text-sm">
                  End
                  <input type="date" className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.endDate} data-testid="input-expense-end" onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} />
                </label>
              </div>
              <label className="block text-sm">
                Payment note
                <input className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2" value={draft.paymentNote} maxLength={80} placeholder="Card name, no card number" data-testid="input-expense-payment" onChange={(event) => setDraft({ ...draft, paymentNote: event.target.value })} />
              </label>
              <label className="block text-sm">
                Notes
                <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-2 py-1" value={draft.notes} maxLength={2000} data-testid="input-expense-notes" onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </label>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" size="sm" disabled={saving} data-testid="button-save-expense">
                {saving ? "Saving" : "Save"}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
