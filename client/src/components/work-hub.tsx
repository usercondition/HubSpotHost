import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import type { FloorNeed } from "@/lib/floor-needs";
import { formatMoney } from "@/lib/format";
import { stackHref } from "@/lib/workflow";
import {
  StatusChip,
  matchesOutstandingFilter,
  outstandingFilterOptions,
  statusForRow,
  targetLabel,
  type OutstandingFilter,
  type StackRowModel,
  type StackView,
} from "@/components/priority-stack-list";
import { orderTitle } from "@/lib/order-title";
import { cn } from "@/lib/utils";

type Sort = "priority" | "ship-by" | "amount";

function daysLabel(date: string, today: string): string {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

function orderHref(row: StackRowModel): string {
  return row.dealId ? stackHref(row.dealId) : "/stack";
}

export function WorkHub({ needs, stack, today }: { needs: FloorNeed[]; stack: StackView | undefined; today: string }) {
  const [filter, setFilter] = useState<OutstandingFilter>("all");
  const [sort, setSort] = useState<Sort>("priority");
  const rows = stack?.rows ?? [];
  const filters = outstandingFilterOptions(rows, today);
  const visible = useMemo(() => {
    const next = rows.filter((row) => matchesOutstandingFilter(row, filter, today));
    if (sort === "ship-by") return next.sort((a, b) => a.targetDate.localeCompare(b.targetDate) || a.rank - b.rank);
    if (sort === "amount") return next.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || a.rank - b.rank);
    return next;
  }, [filter, rows, sort, today]);
  const overdue = rows.filter((row) => row.targetDate < today).length;
  const dueToday = rows.filter((row) => row.targetDate === today).length;

  return (
    <div className="work-hub" data-testid="work-hub">
      <section className="work-hub-summary">
        <div>
          <p className="work-hub-eyebrow">Today’s work</p>
          <h2>What needs your attention</h2>
          <p className="work-hub-note">
            {overdue > 0 ? `${overdue} overdue` : "Nothing overdue"}{dueToday > 0 ? ` · ${dueToday} due today` : ""} · {needs.length} actions open
          </p>
        </div>
        <Link href="/stack" className="work-hub-open">Open priority controls <ChevronRight className="h-4 w-4" /></Link>
      </section>

      <div className="work-hub-layout">
        <section className="work-hub-actions" aria-labelledby="work-hub-actions">
          <div className="work-hub-section-head">
            <h3 id="work-hub-actions">Do next</h3>
            <span className="numeric">{needs.length}</span>
          </div>
          {needs.length === 0 ? (
            <p className="work-hub-empty">No actions waiting right now.</p>
          ) : (
            needs.map((need) => (
              <Link key={need.key} href={need.href} className="work-hub-action" data-testid={`hub-action-${need.key}`}>
                <span className={cn("work-hub-action-mark", `is-${need.lane}`)} />
                <span className="min-w-0">
                  <strong>{need.pill}</strong>
                  <span>{need.name} · {need.problem}</span>
                </span>
                {need.shipBy ? <span className={cn("work-hub-action-date", need.shipBy <= today && "is-due")}>{daysLabel(need.shipBy, today)}</span> : null}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            ))
          )}
        </section>

        <section className="work-hub-outstanding" aria-labelledby="work-hub-outstanding">
          <div className="work-hub-section-head">
            <div>
              <h3 id="work-hub-outstanding">Outstanding orders</h3>
              <p>Every open order, ordered by the work that is due first.</p>
            </div>
            <span className="numeric">{rows.length} open</span>
          </div>
          <div className="work-hub-controls">
            <div className="work-hub-filter-scroll" aria-label="Filter outstanding orders">
              {filters.map((option) => (
                <button key={option.key} type="button" className="work-hub-filter" data-active={filter === option.key} onClick={() => setFilter(option.key)}>
                  {option.label} <span className="numeric">{option.count}</span>
                </button>
              ))}
            </div>
            <label className="work-hub-sort">
              <span>Sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort outstanding orders">
                <option value="priority">Priority</option>
                <option value="ship-by">Ship-by date</option>
                <option value="amount">Amount</option>
              </select>
            </label>
          </div>
          <div className="work-hub-table" data-testid="hub-outstanding-list">
            <div className="work-hub-table-head" aria-hidden="true">
              <span>Order</span><span>Status</span><span>Ship by</span><span>Amount</span>
            </div>
            {visible.length === 0 ? <p className="work-hub-empty">No outstanding orders match this view.</p> : visible.map((row) => {
              const date = targetLabel(row, today);
              const status = statusForRow(row);
              return (
                <Link key={row.key} href={orderHref(row)} className="work-hub-order" data-testid={`hub-order-${row.key}`}>
                  <span className="work-hub-order-name">
                    <strong>{orderTitle(row.name, row.contactName)}</strong>
                    <small>{row.contactName || (row.kind === "offbook" ? "Off-book" : row.kind === "bundle" ? `${row.members.length} orders bundled` : "Customer order")}</small>
                  </span>
                  <StatusChip row={row} />
                  <span className={cn("work-hub-date", row.targetDate <= today && "is-due")} title={date}>
                    <strong>{daysLabel(row.targetDate, today)}</strong><small>{date}</small>
                  </span>
                  <span className="work-hub-amount numeric">{row.amount == null ? "—" : formatMoney(row.amount)}</span>
                  <span className="sr-only">{status.label}</span>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
