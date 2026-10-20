import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import type { FloorNeed } from "@/lib/floor-needs";
import { formatMoney } from "@/lib/format";
import { stackHref } from "@/lib/workflow";
import {
  StatusChip,
  addressFlagForRow,
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
import { shopDateLabel } from "@shared/ship-by";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

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

function QueueLane({ title, items, today }: { title: string; items: ProductionQueueItem[]; today: string }) {
  return (
    <section className="hub-queue-lane" aria-label={title}>
      <div className="hub-queue-head">
        <h3>{title}</h3>
        <span className="numeric">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="work-hub-empty">Nothing here right now.</p>
      ) : (
        items.map((item, index) => (
          <Link key={item.dealId} href={`/queue?dealId=${encodeURIComponent(item.dealId)}`} className="hub-queue-row">
            <span className="hub-queue-rank numeric">{index + 1}</span>
            <span className="min-w-0">
              <strong>{orderTitle(item.dealName, item.contactName)}</strong>
              <small>{item.plateCount ? `${item.plateCount} plate${item.plateCount === 1 ? "" : "s"}` : item.stage}{item.totalPrintTimeSeconds ? ` · ${Math.round(item.totalPrintTimeSeconds / 3600)}h` : ""}{item.assignedPrinterNames.length ? ` · ${item.assignedPrinterNames.join(", ")}` : ""}</small>
            </span>
            <span className={cn("hub-queue-date", item.shipBy <= today && "is-due")}>
              {shopDateLabel({ date: item.shipBy, today, source: item.shipBySource, tentative: item.tentative })}
            </span>
          </Link>
        ))
      )}
    </section>
  );
}

export function WorkHub({
  needs,
  stack,
  queue,
  today,
}: {
  needs: FloorNeed[];
  stack: StackView | undefined;
  queue: ProductionQueueResponse | undefined;
  today: string;
}) {
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
  const outTheDoor = stack?.outTheDoor ?? [];

  return (
    <div className="work-hub" data-testid="work-hub">
      <section className="work-hub-summary">
        <div>
          <p className="work-hub-eyebrow">Print Ops</p>
          <h2>Hub</h2>
          <p className="work-hub-note">{overdue > 0 ? `${overdue} overdue` : "Nothing overdue"}{dueToday > 0 ? ` · ${dueToday} due today` : ""} · {rows.length} open orders</p>
        </div>
        <Link href="/stack" className="work-hub-open">Advanced priority <ChevronRight className="h-4 w-4" /></Link>
      </section>

      <section className="work-hub-actions" aria-labelledby="work-hub-actions">
          <div className="work-hub-section-head">
            <div><h3 id="work-hub-actions">Needs attention</h3><p>Overdue, due today, then blockers.</p></div>
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

      <section className="hub-production" aria-labelledby="hub-production">
        <div className="work-hub-section-head">
          <div><h3 id="hub-production">Today’s print queue</h3><p>Only the next jobs and work already in production.</p></div>
          <Link href="/queue" className="work-hub-open">Queue details <ChevronRight className="h-4 w-4" /></Link>
        </div>
        <div className="hub-queue-grid">
          <QueueLane title="Next print" items={queue?.nextPrint ?? []} today={today} />
          <QueueLane title="In production" items={queue?.inProduction ?? []} today={today} />
        </div>
      </section>

      <section className="work-hub-outstanding" aria-labelledby="work-hub-outstanding">
          <div className="work-hub-section-head">
            <div>
              <h3 id="work-hub-outstanding">Coming up</h3>
              <p>Every open order, ordered by Stack auto priority.</p>
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
              const addressFlag = addressFlagForRow(row);
              return (
                <Link key={row.key} href={orderHref(row)} className="work-hub-order" data-testid={`hub-order-${row.key}`}>
                  <span className="work-hub-order-name">
                    <strong>{orderTitle(row.name, row.contactName)}</strong>
                    <small>{row.contactName || (row.kind === "offbook" ? "Off-book" : row.kind === "bundle" ? `${row.members.length} orders bundled` : "Customer order")}</small>
                  </span>
                  <span className="work-hub-status">
                    <StatusChip row={row} />
                    {addressFlag ? <small className="work-hub-address-flag">{addressFlag.label}</small> : null}
                  </span>
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

      <section className="hub-out-door" aria-labelledby="hub-out-door">
        <div className="work-hub-section-head">
          <div><h3 id="hub-out-door">Out the door</h3><p>Completed this week · counted once.</p></div>
          <span className="hub-out-door-total numeric">{stack ? formatMoney(stack.totals.outTheDoor) : "—"}</span>
        </div>
        {outTheDoor.length === 0 ? <p className="work-hub-empty">No completed orders this week.</p> : (
          <div className="hub-out-door-list">
            {outTheDoor.slice(0, 4).map((row) => (
              <Link key={row.key} href={orderHref(row)} className="hub-out-door-row">
                <span className="min-w-0"><strong>{orderTitle(row.name, row.contactName)}</strong><small>{statusForRow(row).label}</small></span>
                <span className="numeric">{row.amount == null ? "—" : formatMoney(row.amount)}</span>
              </Link>
            ))}
            {outTheDoor.length > 4 ? <Link className="work-hub-open px-4 pb-4" href="/shipments">Shipment history <ChevronRight className="h-4 w-4" /></Link> : null}
          </div>
        )}
      </section>
    </div>
  );
}
