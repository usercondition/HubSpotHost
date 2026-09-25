import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileUp,
  Loader2,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { parkedQueueHref, printsDealHref, readHashQueryParam, searchWithoutParam, stackHref, stripDealIdFromLocation } from "@/lib/workflow";
import { shipByCalendarDate, shopDateLabel } from "@shared/ship-by";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsDrawer } from "@/components/deal-ops-panel";
import { Panel, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { orderTitle } from "@/lib/order-title";
import { cn } from "@/lib/utils";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

type QueueResponse = ProductionQueueResponse & { ok: true };

/** Keep `#/queue` vs `#/queue?dealId=` in sync without remounting the page. */
function replaceQueueHash(dealId: string | null) {
  if (typeof window === "undefined") return;
  const search = searchWithoutParam(window.location.search, "dealId");
  const nextHash = dealId
    ? `#/queue?dealId=${encodeURIComponent(dealId)}`
    : "#/queue";
  const next = `${window.location.pathname}${search}${nextHash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current === next) return;
  window.history.replaceState(null, "", next);
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
        <p className="board-name min-w-0 flex-1 truncate">{orderTitle(item.dealName, item.contactName)}</p>
        <span className="flex shrink-0 items-center gap-2">
          {needsPlates ? (
            <Link
              href={printsDealHref(item.dealId)}
              className="text-xs font-semibold text-primary"
              data-testid={`link-queue-plates-${item.dealId}`}
              onClick={(event) => event.stopPropagation()}
            >
              Attach plates
            </Link>
          ) : null}
          {item.isStale ? (
            <StatusPill tone="bad" icon={AlertTriangle} label="Stale" />
          ) : item.needsReply ? (
            <StatusPill tone="warn" icon={MessageCircle} label="Needs reply" />
          ) : null}
        </span>
      </div>
      <p className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
        {item.assignedPrinterNames.map((name) => (
          <span key={name} className="queue-printer">{name}</span>
        ))}
        <span className="truncate">
          {item.plateCount > 0 ? `${item.plateCount} plate${item.plateCount === 1 ? "" : "s"} · ${hoursLabel(item.totalPrintTimeSeconds)}` : item.stage}
        </span>
      </p>
      <p className="scan-facts text-muted-foreground">
        <span className="min-w-0 truncate font-medium">{item.contactName || item.stage}</span>
        <span
          className={cn(
            item.shipBy < shipByCalendarDate() && "text-destructive",
            item.shipBy === shipByCalendarDate() && "text-chart-4",
          )}
        >
          {shopDateLabel({
            date: item.shipBy,
            today: shipByCalendarDate(),
            source: item.shipBySource,
            tentative: item.tentative,
          })}
        </span>
        <span className="queue-amount text-foreground">{formatMoney(item.amount)}</span>
      </p>
      {item.shipPlanNote ? <p className="board-meta truncate">{item.shipPlanNote}</p> : detail ? <p className="board-meta truncate">{detail}</p> : null}
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
  const hours = items.reduce((sum, item) => sum + (item.totalPrintTimeSeconds > 0 ? item.totalPrintTimeSeconds : 0), 0);
  const dollars = items.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0);
  return (
    <section className="queue-lane min-w-0" data-lane={lane} data-testid={testId}>
      <div className="queue-lane-header flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight" title={subtitle}>
            {title}{" "}
            <span className="numeric font-medium text-muted-foreground">{items.length}</span>
          </h2>
          <p className="text-xs text-muted-foreground">{hours > 0 ? hoursLabel(hours) : "0h"} of plates</p>
        </div>
        <span className="queue-amount numeric text-sm">{formatMoney(dollars)}</span>
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
    successDescription: "Next print and in-production jobs. Ready and blocked orders are on the Stack.",
  });
  // Same as Stack: remember a deal link before stripping it from search and hash.
  const pendingDealId = useRef<string | null | undefined>(undefined);
  if (pendingDealId.current === undefined) {
    pendingDealId.current = readHashQueryParam("dealId");
  }
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [focus, setFocus] = useState<"needsReply" | null>(null);

  const selectDeal = useCallback((dealId: string | null) => {
    setSelectedDealId(dealId);
    replaceQueueHash(dealId);
  }, []);

  useEffect(() => {
    stripDealIdFromLocation();
  }, []);

  // Left-nav → Queue clears `?dealId=` in the hash; keep drawer state in sync without remounting.
  useEffect(() => {
    const syncFromHash = () => {
      if (!readHashQueryParam("dealId")) setSelectedDealId(null);
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

  useEffect(() => {
    if (!data || !selectedDealId) return;
    const parked = parkedQueueHref(selectedDealId, {
      nextPrint: data.nextPrint.map((item) => item.dealId),
      inProduction: data.inProduction.map((item) => item.dealId),
      shipReady: data.shipReady.map((item) => item.dealId),
      blocked: data.blocked.map((item) => item.dealId),
    });
    if (!parked) return;
    window.location.hash = `#${parked}`;
  }, [data, selectedDealId]);

  // A deal link opens the drawer only when that deal is still on a printer lane.
  // Closed and parked deals never stay in the URL, so the next tab click cannot reopen them.
  useEffect(() => {
    if (!data) return;
    const id = pendingDealId.current;
    if (!id) return;
    pendingDealId.current = null;
    const lanes = {
      nextPrint: data.nextPrint.map((item) => item.dealId),
      inProduction: data.inProduction.map((item) => item.dealId),
      shipReady: data.shipReady.map((item) => item.dealId),
      blocked: data.blocked.map((item) => item.dealId),
    };
    const parked = parkedQueueHref(id, lanes);
    if (parked) {
      window.location.hash = `#${parked}`;
      return;
    }
    if (queueBoardDealIds(data).has(id)) setSelectedDealId(id);
  }, [data]);

  return (
    <div className="mx-auto flex max-w-[100rem] flex-col">
      <PageHeader
        title="Queue"
        subtitle=""
        actions={
          isUnlocked ? (
            <Button
              size="sm"
              variant="outline"
              className="max-md:hidden"
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
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
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
              {focus ? (
                <Button size="sm" variant="ghost" onClick={() => setFocus(null)}>
                  Clear filter
                </Button>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground" data-testid="text-queue-stack-link">
              Ready to ship ({data.shipReady.length}) and blocked ({data.blocked.length}) orders are on the{" "}
              <Link href={stackHref()} className="font-medium text-primary hover:underline" data-testid="link-queue-stack">
                Stack
              </Link>
              .
            </p>

            <div className="grid gap-6 lg:grid-cols-2">
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

          </>
        )}
      </div>
    </div>
  );
}
