import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Beaker,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  Loader2,
  MapPin,
  Printer,
  RefreshCw,
  Ship,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { attentionNextStep, floorFocusMeta, hubspotDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { CardMenu, Panel, StatusPill } from "@/components/primitives";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  formatShipByShort,
  formatShipByWeekday,
  groupShipByAgenda,
  shipByCalendarDate,
  shipByHonestyLabel,
} from "@shared/ship-by";
import { addressStatusPill } from "@shared/ship-address";
import type {
  HealthResponse,
  PerformanceResponse,
  PrinterFleetSnapshot,
  ProductionQueueItem,
  ProductionQueueResponse,
  ResinReorderResponse,
} from "@shared/schema";

type AttentionItem = PerformanceResponse["attention"][number];
type ActiveDeal = PerformanceResponse["activeDeals"][number];
type QueueResponse = ProductionQueueResponse & { ok: true };

/** Cap in-flight strip so Floor stays scannable; full board is Queue. */
const FLOOR_ACTIVE_DEAL_CAP = 8;

function shipByLabel(shipBy: string, today = shipByCalendarDate(), source?: "override" | "derived"): string {
  return shipByHonestyLabel(shipBy, today, source);
}

function SystemStatusPill({ health }: { health: HealthResponse | undefined }) {
  if (!health) return null;
  const live = health.safety.liveWriteReady === true;
  const signing = health.webhook.verification === "configured";
  const storageWarn = health.storage?.warning;
  if (live && signing && !storageWarn) return null;

  return (
    <Link
      href="/setup"
      data-testid="panel-system-status"
      className="inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-chart-4/10 px-2.5 py-1 text-sm font-medium text-chart-4 hover:bg-chart-4/15"
      title={storageWarn || "HubSpot writes or webhook need a quick check"}
    >
      <SlidersHorizontal className="h-3 w-3" />
      Setup
    </Link>
  );
}

function countByIssueKey(attention: AttentionItem[], key: string): number {
  return attention.filter((item) => item.issueKey === key).length;
}

function AttentionCard({
  item,
  portalId,
  dismissPending,
  onDismiss,
}: {
  item: AttentionItem;
  portalId: string | null | undefined;
  dismissPending: boolean;
  onDismiss: () => void;
}) {
  const step = attentionNextStep({
    dealId: item.dealId,
    issue: item.issue,
    portalId,
  });
  const tone = item.severity === "bad" ? "bad" : "warn";

  return (
    <article
      className="workspace-node w-full p-3.5 text-left"
      data-tone={tone}
      data-testid={`row-glance-${item.dealId}-${item.issueKey}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={step.href}
            className="board-name block truncate hover:underline"
            data-testid={`link-glance-action-${item.dealId}`}
          >
            {item.dealName}
          </Link>
          <p className="board-meta truncate">{item.stage}</p>
          <p className="board-meta">{item.detail}</p>
        </div>
        <CardMenu label={`More actions for ${item.dealName}`}>
          <DropdownMenuItem
            disabled={dismissPending}
            onSelect={onDismiss}
            data-testid={`button-glance-skip-${item.dealId}-${item.issueKey}`}
          >
            Skip
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={hubspotDealHref(item.dealId, portalId)} target="_blank" rel="noopener noreferrer">
              HubSpot
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </DropdownMenuItem>
        </CardMenu>
      </div>
      <div className="mt-2.5">
        <StatusPill tone={tone} icon={item.issueKey === "no_plates" ? FileUp : ListOrdered} label={step.label} />
      </div>
    </article>
  );
}

function ShopCard({
  title,
  detail,
  href,
  label,
  icon: Icon,
  testId,
  tone = "warn",
}: {
  title: string;
  detail: string;
  href: string;
  label: string;
  icon: typeof Link2;
  testId: string;
  tone?: "warn" | "bad" | "good";
}) {
  return (
    <Link
      href={href}
      className="workspace-node block w-full p-3.5 text-left"
      data-tone={tone}
      data-testid={testId}
    >
      <span className="board-name block truncate">{title}</span>
      <span className="board-meta block">{detail}</span>
      <span className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
        <Icon className="h-4 w-4" />
        {label}
      </span>
    </Link>
  );
}

function FlightCard({
  deal,
  queueItem,
  attention,
  portalId,
  onCopyChase,
}: {
  deal: ActiveDeal;
  queueItem?: ProductionQueueItem;
  attention: AttentionItem[];
  portalId: string | null | undefined;
  onCopyChase?: (draft: string) => void;
}) {
  const needsPlates = deal.promptAttachPlates;
  const dealAlerts = attention.filter((item) => item.dealId === deal.dealId);
  const needsCosts = dealAlerts.some((item) => item.issueKey === "costs_incomplete");
  const isStale = dealAlerts.some((item) => item.issueKey === "stale");
  const showAddress =
    queueItem &&
    (queueItem.bucket === "ship_ready" || queueItem.readyToPack || queueItem.fulfillment.readyPercent >= 80);
  const addressPill = showAddress && queueItem ? addressStatusPill(queueItem.addressStatus) : null;
  const tone = isStale
    ? "bad"
    : needsPlates || needsCosts || (addressPill && addressPill.tone !== "good")
      ? "warn"
      : "good";

  return (
    <article
      className="workspace-node w-full p-3.5 text-left"
      data-tone={tone === "good" ? undefined : tone}
      data-testid={`row-todays-active-deal-${deal.dealId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={needsPlates ? printsDealHref(deal.dealId) : queueDealHref(deal.dealId)}
            className="board-name block truncate hover:underline"
            data-testid={needsPlates ? `link-todays-attach-${deal.dealId}` : `link-todays-ops-${deal.dealId}`}
          >
            {deal.dealName}
          </Link>
          <p className="board-meta truncate">
            {deal.stage}
            {queueItem?.addressSummary ? ` · ${queueItem.addressSummary}` : ""}
          </p>
        </div>
        <div onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <CardMenu label={`More actions for ${deal.dealName}`}>
            {needsPlates ? (
              <DropdownMenuItem asChild>
                <Link href={queueDealHref(deal.dealId)} data-testid={`link-todays-ops-${deal.dealId}`}>
                  Open in Queue
                </Link>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem asChild>
                <Link href={printsDealHref(deal.dealId)} data-testid={`link-todays-attach-${deal.dealId}`}>
                  Plates
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <a
                href={hubspotDealHref(deal.dealId, portalId)}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`link-todays-hubspot-${deal.dealId}`}
              >
                HubSpot
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </DropdownMenuItem>
          </CardMenu>
        </div>
      </div>
      {queueItem ? (
        <p
          className={cn(
            "board-figure mt-2.5",
            queueItem.shipBy < shipByCalendarDate() && "text-destructive",
            queueItem.shipBy === shipByCalendarDate() && "text-chart-4",
          )}
        >
          <span>{formatShipByShort(queueItem.shipBy)}</span>
          <span className="board-figure-label">
            {queueItem.shipBy < shipByCalendarDate()
              ? "Overdue"
              : queueItem.shipBy === shipByCalendarDate()
                ? "Due today"
                : "Ship by"}
            {queueItem.shipBySource === "override" ? " · set" : ""}
          </span>
        </p>
      ) : null}
      <p className="board-figure">
        <span>{formatMoney(deal.amount)}</span>
        <span className="board-figure-label">Paid</span>
      </p>
      <div className="mt-2.5">
        {needsPlates ? (
          <StatusPill tone="warn" icon={FileUp} label="Needs plates" />
        ) : needsCosts ? (
          <StatusPill tone="warn" icon={AlertTriangle} label="Needs costs" />
        ) : isStale ? (
          <StatusPill tone="bad" icon={AlertTriangle} label="Stale" />
        ) : addressPill && addressPill.tone !== "good" ? (
          <StatusPill
            tone={addressPill.tone}
            icon={MapPin}
            label={addressPill.label}
            testId={`status-address-${deal.dealId}`}
          />
        ) : queueItem?.readyToPack || queueItem?.bucket === "ship_ready" ? (
          <StatusPill tone="good" icon={Ship} label="Ready to ship" />
        ) : addressPill ? (
          <StatusPill
            tone={addressPill.tone}
            icon={MapPin}
            label={addressPill.label}
            testId={`status-address-${deal.dealId}`}
          />
        ) : (
          <StatusPill tone="good" icon={CheckCircle2} label="On track" />
        )}
      </div>
      {showAddress &&
      queueItem &&
      queueItem.addressStatus !== "ready" &&
      queueItem.addressStatus !== "pickup" &&
      queueItem.chaseDraft ? (
        <button
          type="button"
          className="mt-2 text-sm font-semibold text-primary hover:underline"
          data-testid={`button-chase-address-${deal.dealId}`}
          onClick={() => onCopyChase?.(queueItem.chaseDraft)}
        >
          Copy chase
        </button>
      ) : null}
    </article>
  );
}

function FloorColumn({
  title,
  subtitle,
  count,
  empty,
  testId,
  lane,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  empty: string;
  testId: string;
  lane: "plates" | "fly" | "warn" | "bad" | "good" | "shop";
  children: ReactNode;
}) {
  return (
    <section className="queue-lane min-w-0" data-lane={lane} data-testid={testId}>
      <div className="queue-lane-header">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">
            {title}{" "}
            <span className="numeric font-medium text-muted-foreground">{count}</span>
          </h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="queue-lane-body">
        {count === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm leading-5 text-muted-foreground">
            {empty}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function ShipCalendarDeal({ item, today }: { item: ProductionQueueItem; today: string }) {
  const tone = item.shipBy < today ? "bad" : item.shipBy === today ? "warn" : undefined;
  return (
    <Link
      href={queueDealHref(item.dealId)}
      className="ship-cal-deal"
      data-tone={tone}
      data-testid={`link-ship-cal-${item.dealId}`}
      title={shipByLabel(item.shipBy, today, item.shipBySource)}
    >
      <span className="truncate font-medium">{item.dealName}</span>
      <span className="ship-cal-deal-meta">
        {item.shipBySource === "override" ? "set" : "plan"}
        {item.amount > 0 ? ` · ${formatMoney(item.amount)}` : ""}
      </span>
    </Link>
  );
}

function ShipCalendar({ items, loading }: { items: ProductionQueueItem[]; loading: boolean }) {
  const today = shipByCalendarDate();
  const agenda = groupShipByAgenda(items, today);
  const pressure = agenda.overdue.length + agenda.dueToday.length;

  return (
    <section
      className="queue-lane min-w-0"
      data-lane={pressure > 0 ? "bad" : "good"}
      data-testid="panel-floor-ship-calendar"
    >
      <div className="queue-lane-header">
        <div className="min-w-0">
          <h2 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            Ship calendar{" "}
            <span className="numeric text-muted-foreground">({items.length})</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Los Angeles dates · keep overdue and due-today honest
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {pressure > 0 ? (
            <StatusPill
              tone={agenda.overdue.length > 0 ? "bad" : "warn"}
              icon={Ship}
              label={
                agenda.overdue.length > 0
                  ? `${agenda.overdue.length} overdue`
                  : `${agenda.dueToday.length} due today`
              }
              testId="status-ship-cal-pressure"
            />
          ) : (
            <StatusPill tone="good" icon={CheckCircle2} label="Dates clear" testId="status-ship-cal-clear" />
          )}
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
        </div>
      </div>

      <div className="queue-lane-body !max-h-none space-y-3">
        {agenda.overdue.length > 0 ? (
          <div className="ship-cal-overdue" data-testid="panel-ship-cal-overdue">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-destructive">Overdue</p>
              <p className="text-sm text-muted-foreground">{agenda.overdue.length} past ship-by</p>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              {agenda.overdue.map((item) => (
                <ShipCalendarDeal key={item.dealId} item={item} today={today} />
              ))}
            </div>
          </div>
        ) : null}

        <div className="ship-cal-week" data-testid="panel-ship-cal-week">
          {agenda.weekDays.map((day) => {
            const isToday = day.date === today;
            const tone = isToday && day.items.length > 0 ? "warn" : day.items.length > 0 ? "live" : undefined;
            return (
              <div
                key={day.date}
                className={cn("ship-cal-day", isToday && "is-today")}
                data-tone={tone}
                data-testid={`ship-cal-day-${day.date}`}
              >
                <div className="ship-cal-day-head">
                  <span className="ship-cal-weekday">{formatShipByWeekday(day.date)}</span>
                  <span className="ship-cal-date numeric">{formatShipByShort(day.date)}</span>
                  {isToday ? <span className="ship-cal-today-mark">Today</span> : null}
                </div>
                {day.items.length === 0 ? (
                  <p className="ship-cal-empty">—</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {day.items.slice(0, 4).map((item) => (
                      <ShipCalendarDeal key={item.dealId} item={item} today={today} />
                    ))}
                    {day.items.length > 4 ? (
                      <p className="text-sm text-muted-foreground">+{day.items.length - 4} more</p>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {agenda.later.length > 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-ship-cal-later">
            +{agenda.later.length} later than this week on{" "}
            <Link href="/queue" className="font-medium text-primary hover:underline">
              Queue
            </Link>
            .
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TodaysWork() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlockMutation = useOwnerUnlock({
    successTitle: "Floor unlocked",
    successDescription: "Queue, Orders, Prints, Intake, and Stats share this session.",
  });

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const resinReorder = useQuery<ResinReorderResponse>({
    queryKey: ["/api/resin-reorder", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/resin-reorder", undefined, { headers });
      return (await response.json()) as ResinReorderResponse;
    },
    staleTime: 60_000,
  });

  const printers = useQuery<{ ok: true } & PrinterFleetSnapshot>({
    queryKey: ["/api/printers", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/printers", undefined, { headers });
      return (await response.json()) as { ok: true } & PrinterFleetSnapshot;
    },
    staleTime: 60_000,
  });

  const productionQueue = useQuery<QueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return (await response.json()) as QueueResponse;
    },
    staleTime: 30_000,
  });

  const dismissAttention = useMutation({
    mutationFn: async (input: { dealId: string; issueKey: string }) => {
      const response = await apiRequest(
        "POST",
        "/api/attention/dismiss",
        { dealId: input.dealId, issueKey: input.issueKey, note: "Skipped from Floor" },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      toast({
        title: "Alert skipped",
        description: "Hidden for this order until you reopen it or HubSpot clears the issue.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not skip that alert",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 160),
        variant: "destructive",
      });
    },
  });

  if (!isUnlocked) {
    return (
      <OwnerUnlockPanel
        title="Unlock the floor"
        description="See what needs plates, costs, or review — then jump into Queue."
        buttonLabel="Unlock the floor"
        testIdPrefix="dashboard"
        pending={unlockMutation.isPending}
        onUnlock={(code) => unlockMutation.mutate(code)}
      />
    );
  }

  if (performance.isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-4" data-testid="skeleton-todays-work">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-28 rounded-lg" />
        ))}
      </div>
    );
  }

  if (performance.isError || !performance.data) {
    return (
      <Panel title="Floor board could not be loaded" testId="panel-todays-work-error">
        <Button size="sm" onClick={() => performance.refetch()}>
          Try again
        </Button>
      </Panel>
    );
  }

  const snapshot = performance.data;
  const attention = snapshot.attention ?? [];
  const activeDeals = (snapshot.activeDeals ?? []).filter((deal) => deal.requiresPlates);
  const visibleDeals = activeDeals.slice(0, FLOOR_ACTIVE_DEAL_CAP);
  const hiddenDealCount = Math.max(0, activeDeals.length - visibleDeals.length);
  const portalId = snapshot.hubspotPortalId;
  const queueItems = productionQueue.data
    ? [
        ...productionQueue.data.nextPrint,
        ...productionQueue.data.inProduction,
        ...productionQueue.data.blocked,
        ...productionQueue.data.shipReady,
      ]
    : [];
  const queueByDealId = new Map(queueItems.map((item) => [item.dealId, item]));
  const today = shipByCalendarDate();
  const shipAgenda = groupShipByAgenda(queueItems, today);

  const plates = attention.filter((item) => item.issueKey === "no_plates");
  const costs = attention.filter((item) => item.issueKey === "costs_incomplete");
  const stale = attention.filter((item) => item.issueKey === "stale");
  const pendingReview = snapshot.intake.pendingReview;
  const awaitingClient = snapshot.intake.awaitingClient;
  const buyNow = resinReorder.data?.buyNow ?? [];
  const fepDue =
    printers.data?.printers.filter((printer) => {
      if (printer.status !== "active") return false;
      const hours = printer.fepHoursUsedPercent ?? 0;
      const layers = printer.fepLayersUsedPercent ?? 0;
      return Math.max(hours, layers) >= 85;
    }) ?? [];

  const shopCount =
    (pendingReview > 0 ? 1 : 0) +
    (awaitingClient > 0 ? 1 : 0) +
    (buyNow.length > 0 ? 1 : 0) +
    (fepDue.length > 0 ? 1 : 0);

  const shipPressure = shipAgenda.overdue.length + shipAgenda.dueToday.length;
  const clearFloor =
    plates.length + costs.length + stale.length + shopCount + shipPressure === 0;

  return (
    <div className="space-y-4" data-testid="panel-todays-work">
      <div className="flex flex-wrap items-center gap-2">
        {clearFloor ? (
          <StatusPill tone="good" icon={CheckCircle2} label="Floor clear" testId="status-floor-clear" />
        ) : (
          <StatusPill
            tone={shipAgenda.overdue.length > 0 ? "bad" : "warn"}
            icon={AlertTriangle}
            label={`${attention.length + pendingReview + shipPressure} open`}
            testId="status-floor-pressure"
          />
        )}
        <Button asChild size="sm" variant="outline" data-testid="link-floor-open-queue">
          <Link href="/queue">
            <ListOrdered className="mr-2 h-3.5 w-3.5" />
            Open Queue
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost" data-testid="link-floor-open-prints">
          <Link href={floorFocusMeta("plates").workspaceHref}>Prints</Link>
        </Button>
        <Button asChild size="sm" variant="ghost" data-testid="link-floor-open-intake">
          <Link href="/orders">Intake</Link>
        </Button>
        {performance.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
      </div>

      <ShipCalendar items={queueItems} loading={productionQueue.isLoading || productionQueue.isFetching} />

      <div className="grid gap-6 xl:grid-cols-4 lg:grid-cols-2" data-testid="panel-floor-glance">
        <FloorColumn
          title="Needs plates"
          subtitle="Attach CTB / slice files"
          count={plates.length}
          empty="All open print jobs have plates."
          testId="column-floor-plates"
          lane="plates"
        >
          {plates.map((item) => (
            <AttentionCard
              key={`${item.dealId}-${item.issueKey}`}
              item={item}
              portalId={portalId}
              dismissPending={dismissAttention.isPending}
              onDismiss={() => dismissAttention.mutate({ dealId: item.dealId, issueKey: item.issueKey })}
            />
          ))}
        </FloorColumn>

        <FloorColumn
          title="Needs costs"
          subtitle="Enter material / postage in Ops"
          count={costs.length}
          empty="No cost gaps on open orders."
          testId="column-floor-costs"
          lane="warn"
        >
          {costs.map((item) => (
            <AttentionCard
              key={`${item.dealId}-${item.issueKey}`}
              item={item}
              portalId={portalId}
              dismissPending={dismissAttention.isPending}
              onDismiss={() => dismissAttention.mutate({ dealId: item.dealId, issueKey: item.issueKey })}
            />
          ))}
        </FloorColumn>

        <FloorColumn
          title="Stale"
          subtitle="Poke stage or update HubSpot"
          count={stale.length}
          empty="Nothing going quiet."
          testId="column-floor-stale"
          lane="bad"
        >
          {stale.map((item) => (
            <AttentionCard
              key={`${item.dealId}-${item.issueKey}`}
              item={item}
              portalId={portalId}
              dismissPending={dismissAttention.isPending}
              onDismiss={() => dismissAttention.mutate({ dealId: item.dealId, issueKey: item.issueKey })}
            />
          ))}
        </FloorColumn>

        <FloorColumn
          title="Shop"
          subtitle="Intake, resin, FEP"
          count={shopCount}
          empty="No intake or shop blockers."
          testId="column-floor-shop"
          lane="shop"
        >
          {pendingReview > 0 ? (
            <ShopCard
              testId="row-glance-intake-review"
              title={`${pendingReview} intake waiting`}
              detail="Approve or cancel paid order forms"
              href="/orders"
              label="Open Intake"
              icon={Link2}
            />
          ) : null}
          {awaitingClient > 0 ? (
            <ShopCard
              testId="row-glance-awaiting-client"
              title={`${awaitingClient} buyer link${awaitingClient === 1 ? "" : "s"} open`}
              detail="Still awaiting client details"
              href={floorFocusMeta("buyer").workspaceHref}
              label="Open Intake"
              icon={Link2}
            />
          ) : null}
          {buyNow.length > 0 ? (
            <ShopCard
              testId="row-glance-resin-buy"
              title={`Buy resin · ${buyNow.length}`}
              detail={`${buyNow[0]?.name}${buyNow.length > 1 ? ` +${buyNow.length - 1}` : ""}`}
              href="/resin"
              label="Resin stock"
              icon={Beaker}
            />
          ) : null}
          {fepDue.length > 0 ? (
            <ShopCard
              testId="row-glance-fep-due"
              title={`FEP due · ${fepDue.length}`}
              detail={fepDue
                .map((p) => p.name)
                .slice(0, 2)
                .join(", ")}
              href="/printers"
              label="Printers"
              icon={Printer}
            />
          ) : null}
        </FloorColumn>
      </div>

      <section className="queue-lane min-w-0" data-testid="panel-todays-active-deals">
        <div className="queue-lane-header">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">
              Jobs in flight{" "}
              <span className="numeric font-medium text-muted-foreground">{activeDeals.length}</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              Snapshot of open print jobs — full board is Queue
            </p>
          </div>
          <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
            <Link href="/queue">Queue</Link>
          </Button>
        </div>
        <div className="queue-lane-body !max-h-none">
          {visibleDeals.length === 0 ? (
            <p
              className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid="empty-todays-active-deals"
            >
              New print deals land here once they’re in the pipeline.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {visibleDeals.map((deal) => (
                <FlightCard
                  key={deal.dealId}
                  deal={deal}
                  queueItem={queueByDealId.get(deal.dealId)}
                  attention={attention}
                  portalId={portalId}
                  onCopyChase={async (draft) => {
                    try {
                      await navigator.clipboard.writeText(draft);
                      toast({
                        title: "Chase draft copied",
                        description: "Paste into Messenger or email — nothing was sent.",
                      });
                    } catch {
                      toast({
                        title: "Could not copy",
                        description: draft.slice(0, 120),
                        variant: "destructive",
                      });
                    }
                  }}
                />
              ))}
            </div>
          )}
          {hiddenDealCount > 0 ? (
            <p className="mt-2 text-sm text-muted-foreground" data-testid="text-floor-more-deals">
              +{hiddenDealCount} more on{" "}
              <Link href="/queue" className="font-medium text-primary hover:underline">
                Queue
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      {clearFloor ? (
        <p className="text-sm text-muted-foreground" data-testid="text-floor-clear">
          Floor is clear — when something needs plates, costs, or review, it shows up in the lanes above.
        </p>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const { isUnlocked, headers, ownerCode } = useOwnerSession();

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  return (
    <div className="mx-auto flex max-w-[100rem] flex-col" data-testid="page-floor">
      <PageHeader
        title="Floor"
        subtitle="Attention board — same lane look as Queue. Act here, produce on Queue."
        actions={
          <>
            <SystemStatusPill health={health.data} />
            {isUnlocked ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => performance.refetch()}
                disabled={performance.isFetching}
                data-testid="button-refresh-floor"
              >
                {performance.isFetching ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Refresh
              </Button>
            ) : null}
          </>
        }
      />

      <div className="page-stack">
        <TodaysWork />
      </div>
    </div>
  );
}
