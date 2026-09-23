import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Clock3,
  FileUp,
  Loader2,
  MessageCircle,
  Package,
  PackageCheck,
  RefreshCw,
  Ship,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { queueDealHref, readHashQueryParam } from "@/lib/workflow";
import { formatShipByShort, shipByCalendarDate } from "@shared/ship-by";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsDrawer } from "@/components/deal-ops-panel";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

type QueueResponse = ProductionQueueResponse & { ok: true };

/** Keep `#/queue` vs `#/queue?dealId=` in sync without remounting the page. */
function replaceQueueHash(dealId: string | null) {
  if (typeof window === "undefined") return;
  const nextHash = dealId
    ? `#/queue?dealId=${encodeURIComponent(dealId)}`
    : "#/queue";
  if (window.location.hash === nextHash) return;
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
}

function queueBoardDealIds(data: ProductionQueueResponse): Set<string> {
  return new Set(
    [...data.nextPrint, ...data.inProduction, ...data.shipReady, ...data.blocked].map(
      (item) => item.dealId,
    ),
  );
}

function hoursLabel(seconds: number | null): string {
  if (seconds == null || !(seconds > 0)) return "—";
  const hours = seconds / 3_600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function QueueCard({
  item,
  selected,
  onSelect,
}: {
  item: ProductionQueueItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const needsPlates = item.requiresPlates && !item.hasPlates;
  const tone = item.isStale
    ? "bad"
    : needsPlates
      ? "plates"
      : item.costsIncomplete || item.bucket === "blocked"
        ? "warn"
        : item.fulfillment.shipReady || item.bucket === "ship_ready"
          ? "good"
          : undefined;

  const detail = [
    item.plateCount > 0 ? `${item.plateCount} plate · ${hoursLabel(item.totalPrintTimeSeconds)}` : "",
    item.assignedPrinterNames.length > 0 ? item.assignedPrinterNames.join(", ") : "",
    item.unassignedPlateCount > 0 ? `${item.unassignedPlateCount} unassigned` : "",
    item.kitNeeded > 0 || item.kitReprint > 0
      ? `Parts ${item.kitNeeded} open${item.kitReprint ? ` · ${item.kitReprint} reprint` : ""}`
      : "",
    item.shipPlanNote ?? "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn("workspace-node scan-row w-full cursor-pointer text-left", selected && "ring-0")}
      data-active={selected ? "true" : "false"}
      data-tone={tone}
      data-testid={`button-queue-deal-${item.dealId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="board-name min-w-0 flex-1 truncate">{item.dealName}</p>
        {item.isStale ? (
          <StatusPill tone="bad" icon={AlertTriangle} label="Stale" />
        ) : item.needsReply ? (
          <StatusPill tone="warn" icon={MessageCircle} label="Needs reply" />
        ) : needsPlates ? (
          <StatusPill tone="warn" icon={FileUp} label="Needs plates" />
        ) : item.costsIncomplete ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Needs costs" />
        ) : item.bucket === "blocked" ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Blocked" />
        ) : item.readyToPack || item.bucket === "ship_ready" ? (
          <StatusPill tone="good" icon={PackageCheck} label="Ready to ship" />
        ) : !item.requiresPlates ? (
          <StatusPill tone="neutral" icon={Package} label="No plates" />
        ) : null}
      </div>
      <p className="scan-facts text-muted-foreground">
        <span className="min-w-0 truncate font-medium">{item.contactName || item.stage}</span>
        <span
          className={cn(
            item.shipBy < shipByCalendarDate() && "text-destructive",
            item.shipBy === shipByCalendarDate() && "text-chart-4",
          )}
        >
          {item.shipBy < shipByCalendarDate()
            ? `Overdue ${formatShipByShort(item.shipBy)}`
            : item.shipBy === shipByCalendarDate()
              ? "Due today"
              : formatShipByShort(item.shipBy)}
          {item.shipBySource === "override" ? " · set" : ""}
        </span>
        <span className="text-foreground">{formatMoney(item.amount)}</span>
      </p>
      {detail ? <p className="board-meta truncate">{detail}</p> : null}
    </article>
  );
}

function QueueColumn({
  title,
  subtitle,
  items,
  selectedId,
  onSelect,
  empty,
  testId,
  lane,
}: {
  title: string;
  subtitle: string;
  items: ProductionQueueItem[];
  selectedId: string | null;
  onSelect: (dealId: string) => void;
  empty: string;
  testId: string;
  lane: "plates" | "fly" | "warn" | "bad" | "good" | "shop";
}) {
  return (
    <section className="queue-lane min-w-0" data-lane={lane} data-testid={testId}>
      <div className="queue-lane-header">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">
            {title}{" "}
            <span className="numeric font-medium text-muted-foreground">{items.length}</span>
          </h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="queue-lane-body">
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        ) : (
          items.map((item) => (
            <QueueCard
              key={item.dealId}
              item={item}
              selected={selectedId === item.dealId}
              onSelect={() => onSelect(item.dealId)}
            />
          ))
        )}
      </div>
    </section>
  );
}

export default function ProductionQueuePage() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Production queue unlocked",
    successDescription: "Next print, in-production jobs, and ship-ready checklists.",
  });
  const [selectedDealId, setSelectedDealId] = useState<string | null>(() => readHashQueryParam("dealId"));
  const [focus, setFocus] = useState<"needsReply" | "readyToPack" | null>(null);

  const selectDeal = useCallback((dealId: string | null) => {
    setSelectedDealId(dealId);
    replaceQueueHash(dealId);
  }, []);

  // Left-nav → Queue clears `?dealId=` in the hash; keep drawer state in sync without remounting.
  useEffect(() => {
    const syncFromHash = () => {
      setSelectedDealId(readHashQueryParam("dealId"));
    };
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const queue = useQuery<QueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return (await response.json()) as QueueResponse;
    },
  });

  const data = queue.data;
  const focusedItems = useCallback(
    (items: ProductionQueueItem[]) => (focus ? items.filter((item) => item[focus]) : items),
    [focus],
  );

  const selectedExists = useMemo(() => {
    if (!data || !selectedDealId) return false;
    return queueBoardDealIds(data).has(selectedDealId);
  }, [data, selectedDealId]);

  // Stale deep-links (Completed / left the board) still had ?dealId= and reopened ops.
  // Only clear once when queue data first arrives — don't yank a deal the user just opened.
  const clearedStaleHash = useRef(false);
  useEffect(() => {
    if (!data || clearedStaleHash.current) return;
    clearedStaleHash.current = true;
    const fromHash = readHashQueryParam("dealId");
    if (!fromHash) return;
    if (queueBoardDealIds(data).has(fromHash)) return;
    selectDeal(null);
  }, [data, selectDeal]);

  return (
    <div className="mx-auto flex max-w-[100rem] flex-col">
      <PageHeader
        title="Queue"
        subtitle="Primary production board — next print → ship. Select a card; ops slides in from the right."
        actions={
          isUnlocked ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => queue.refetch()}
              disabled={queue.isFetching}
              data-testid="button-refresh-queue"
            >
              {queue.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          ) : null
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the production queue"
            description="Same owner code as Daily Work. Live HubSpot orders plus local plates, parts QC, and ship checklists."
            buttonLabel="Unlock Queue"
            testIdPrefix="queue"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : queue.isLoading ? (
          <div className="grid gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : queue.isError || !data ? (
          <Panel title="Queue could not be loaded">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {(queue.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Check HubSpot connectivity."}
              </p>
            </div>
          </Panel>
        ) : (
          <>
            <div className="metric-strip">
              <StatCard label="Open orders" value={String(data.summary.openOrders)} hint="Active HubSpot deals" icon={PackageCheck} />
              <StatCard label="Next print" value={String(data.summary.nextPrint)} hint="Needs plates" icon={FileUp} />
              <StatCard label="In production" value={String(data.summary.inProduction)} hint="Plates attached" icon={Clock3} />
              <StatCard label="Blocked" value={String(data.summary.blocked)} hint="Parts / unassigned" icon={AlertTriangle} tone="warn" />
              <StatCard label="Ship-ready" value={String(data.summary.shipReady)} hint="Checklist progressing" icon={Ship} tone="good" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={focus === "needsReply" ? "default" : "outline"}
                onClick={() => setFocus((current) => (current === "needsReply" ? null : "needsReply"))}
                data-testid="button-filter-needs-reply"
              >
                <MessageCircle className="mr-2 h-3.5 w-3.5" />
                Needs reply ({data.summary.needsReply})
              </Button>
              <Button
                size="sm"
                variant={focus === "readyToPack" ? "default" : "outline"}
                onClick={() => setFocus((current) => (current === "readyToPack" ? null : "readyToPack"))}
                data-testid="button-filter-ready-to-pack"
              >
                <PackageCheck className="mr-2 h-3.5 w-3.5" />
                Ready to pack / ship ({data.summary.readyToPack})
              </Button>
              {focus ? (
                <Button size="sm" variant="ghost" onClick={() => setFocus(null)}>
                  Clear filter
                </Button>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              {selectedDealId
                ? selectedExists
                  ? "Ops open on the right — click outside or press Esc to close."
                  : "That deal isn’t on the board anymore — pick another card or close ops."
                : "Select an order for costs, stage, printers, ship checklist, or packing slip."}
            </p>

            <div className="grid gap-6 xl:grid-cols-4 lg:grid-cols-2">
              <QueueColumn
                title="Next print"
                subtitle="Open orders still missing plate data"
                items={focusedItems(data.nextPrint)}
                selectedId={selectedDealId}
                onSelect={selectDeal}
                empty="All open orders already have plates."
                testId="column-next-print"
                lane="plates"
              />
              <QueueColumn
                title="In production"
                subtitle="Plates on, progressing toward ship"
                items={focusedItems(data.inProduction)}
                selectedId={selectedDealId}
                onSelect={selectDeal}
                empty="Nothing mid-flight right now."
                testId="column-in-production"
                lane="fly"
              />
              <QueueColumn
                title="Blocked"
                subtitle="Needs parts QC or printer assignment"
                items={focusedItems(data.blocked)}
                selectedId={selectedDealId}
                onSelect={selectDeal}
                empty="No QC or assignment blockers."
                testId="column-blocked"
                lane="bad"
              />
              <QueueColumn
                title="Ship ready"
                subtitle="Checklist mostly done — buy label & pack"
                items={focusedItems(data.shipReady)}
                selectedId={selectedDealId}
                onSelect={selectDeal}
                empty="No orders near ship-ready yet."
                testId="column-ship-ready"
                lane="good"
              />
            </div>

            <DealOpsDrawer
              dealId={selectedDealId}
              headers={headers}
              onClose={() => selectDeal(null)}
            />

            {data.recentFailures.length > 0 ? (
              <Panel title="Recent failures / reprints">
                <ul className="space-y-2 text-sm">
                  {data.recentFailures.map((failure) => (
                    <li key={failure.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 last:border-0">
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() => selectDeal(failure.dealId)}
                      >
                        {failure.dealName}
                      </button>
                      <span className="text-sm text-muted-foreground">
                        {failure.failureType.replaceAll("_", " ")} · {new Date(failure.occurredAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <p className="text-sm text-muted-foreground">
              Deep-link any deal with{" "}
              <code className="rounded bg-muted px-1 py-0.5">{queueDealHref("DEAL_ID")}</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
