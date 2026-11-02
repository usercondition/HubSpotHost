import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import type { FloorNeed } from "@/lib/floor-needs";
import type { HomeConnection } from "@/lib/home-connections";
import type { StackView } from "@/components/priority-stack-list";
import { orderTitle } from "@/lib/order-title";
import { cn } from "@/lib/utils";
import { shopDateLabel } from "@shared/ship-by";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

function daysLabel(date: string, today: string): string {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
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

function ConnectionTile({ connection }: { connection: HomeConnection }) {
  const inner = (
    <>
      <strong>{connection.label}</strong>
      <small>{connection.detail}</small>
    </>
  );
  const common = {
    className: "hub-connection-tile",
    "data-tone": connection.tone,
    "data-testid": `hub-connection-${connection.id}`,
  };
  if (/^https?:\/\//.test(connection.href)) {
    return <a {...common} href={connection.href} target="_blank" rel="noreferrer">{inner}</a>;
  }
  return <Link {...common} href={connection.href}>{inner}</Link>;
}

export function WorkHub({
  needs,
  stack,
  today,
  queue,
  connections,
  openOrderCount,
}: {
  needs: FloorNeed[];
  stack: StackView | undefined;
  today: string;
  queue: ProductionQueueResponse | undefined;
  connections: HomeConnection[];
  openOrderCount: number;
}) {
  const rows = stack?.rows ?? [];
  const overdue = rows.filter((row) => row.targetDate < today).length;
  const dueToday = rows.filter((row) => row.targetDate === today).length;

  return (
    <div className="work-hub" data-testid="work-hub">
      <section className="work-hub-summary">
        <div>
          <p className="work-hub-eyebrow">Print Ops</p>
          <h2>Hub</h2>
          <p className="work-hub-note">{overdue > 0 ? `${overdue} overdue` : "Nothing overdue"}{dueToday > 0 ? ` · ${dueToday} due today` : ""}</p>
        </div>
        <Link href="/stack" className="work-hub-open">Advanced priority <ChevronRight className="h-4 w-4" /></Link>
      </section>

      <section className="work-hub-actions" aria-labelledby="work-hub-actions">
        <div className="work-hub-section-head">
          <div><h3 id="work-hub-actions">Needs you</h3><p>Overdue, due today, then blockers.</p></div>
          <span className="numeric">{needs.length}</span>
        </div>
        {needs.length === 0 ? (
          <p className="work-hub-empty">Nothing needs you right now.</p>
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
          <div><h3 id="hub-production">Production</h3><p>Next jobs and work already in production.</p></div>
          <Link href="/queue" className="work-hub-open">Queue details <ChevronRight className="h-4 w-4" /></Link>
        </div>
        <div className="hub-queue-grid">
          <QueueLane title="Next print" items={queue?.nextPrint ?? []} today={today} />
          <QueueLane title="In production" items={queue?.inProduction ?? []} today={today} />
        </div>
      </section>

      <section className="hub-connections" aria-labelledby="hub-connections">
        <div className="work-hub-section-head">
          <div><h3 id="hub-connections">Connections</h3><p>Sales channels, CRM, agents, and sync.</p></div>
        </div>
        <div className="hub-connections-grid">
          {connections.map((connection) => <ConnectionTile key={connection.id} connection={connection} />)}
        </div>
      </section>

      <Link href="/stack" className="hub-open-orders" data-testid="hub-open-orders">
        {openOrderCount} open orders <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
