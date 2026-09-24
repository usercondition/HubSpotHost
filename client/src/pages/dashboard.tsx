import { useMutation, useQuery } from "@tanstack/react-query";
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
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { attentionNextStep, floorFocusMeta, hubspotDealHref, queueDealHref } from "@/lib/workflow";
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

type QueueResponse = ProductionQueueResponse & { ok: true };


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

type FloorLane = "plates" | "warn" | "bad" | "shop";

type FloorNeed = {
  key: string;
  lane: FloorLane;
  rank: number;
  shipBy: string;
  name: string;
  problem: string;
  money: string;
  href: string;
  pill: string;
  testId: string;
  dealId?: string;
  issueKey?: string;
  chaseDraft?: string;
  icon: typeof FileUp;
};

function issueLane(issueKey: string): FloorLane {
  if (issueKey === "no_plates") return "plates";
  if (issueKey === "stale") return "bad";
  return "warn";
}

const LANE_RANK: Record<FloorLane, number> = { bad: 0, plates: 1, warn: 2, shop: 3 };

function FloorNeeds({
  needs,
  portalId,
  dismissPending,
  onDismiss,
  onCopyChase,
}: {
  needs: FloorNeed[];
  portalId: string | null | undefined;
  dismissPending: boolean;
  onDismiss: (dealId: string, issueKey: string) => void;
  onCopyChase: (draft: string) => void;
}) {
  const today = shipByCalendarDate();
  return (
    <section className="queue-lane min-w-0" data-testid="panel-floor-needs">
      <div className="queue-lane-header">
        <h2 className="text-base font-semibold tracking-tight">
          Needs you{" "}
          <span className="numeric font-medium text-muted-foreground">{needs.length}</span>
        </h2>
      </div>
      <div className="queue-lane-body !max-h-none">
        {needs.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="empty-floor-needs">
            Nothing is waiting on you. Production lives on Queue.
          </p>
        ) : (
          needs.map((need) => {
            const Icon = need.icon;
            const tone = need.lane === "bad" ? "bad" : need.lane === "shop" ? "warn" : need.lane === "plates" ? "warn" : "warn";
            return (
              <article key={need.key} className="floor-row workspace-node scan-row" data-lane={need.lane} data-testid={need.testId}>
                <div className="flex items-center justify-between gap-2">
                  <Link href={need.href} className="board-name min-w-0 flex-1 truncate hover:underline" data-testid={need.dealId ? `link-glance-action-${need.dealId}` : undefined}>
                    {need.name}
                  </Link>
                  <StatusPill tone={tone} icon={Icon} label={need.pill} />
                  {need.dealId ? (
                    <CardMenu label={`More actions for ${need.name}`}>
                      {need.issueKey ? (
                        <DropdownMenuItem
                          disabled={dismissPending}
                          onSelect={() => onDismiss(need.dealId!, need.issueKey!)}
                          data-testid={`button-glance-skip-${need.dealId}-${need.issueKey}`}
                        >
                          Skip
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem asChild>
                        <a href={hubspotDealHref(need.dealId, portalId)} target="_blank" rel="noopener noreferrer">
                          HubSpot
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </DropdownMenuItem>
                    </CardMenu>
                  ) : null}
                </div>
                <p className="scan-facts text-muted-foreground">
                  <span className="min-w-0 truncate font-medium">{need.problem}</span>
                  {need.shipBy ? (
                    <span className={cn(need.shipBy < today && "text-destructive", need.shipBy === today && "text-chart-4")}>
                      {need.shipBy < today ? `Overdue ${formatShipByShort(need.shipBy)}` : need.shipBy === today ? "Due today" : formatShipByShort(need.shipBy)}
                    </span>
                  ) : null}
                  {need.money ? <span className="text-foreground">{need.money}</span> : null}
                </p>
                {need.chaseDraft ? (
                  <button
                    type="button"
                    className="mt-2 text-sm font-semibold text-primary hover:underline"
                    data-testid={need.dealId ? `button-chase-address-${need.dealId}` : undefined}
                    onClick={() => onCopyChase(need.chaseDraft!)}
                  >
                    Copy chase
                  </button>
                ) : null}
              </article>
            );
          })
        )}
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

  const dealById = new Map((snapshot.activeDeals ?? []).map((deal) => [deal.dealId, deal]));
  const floorNeeds: FloorNeed[] = [];
  for (const item of attention) {
    const step = attentionNextStep({ dealId: item.dealId, issue: item.issue, portalId });
    const queueItem = queueByDealId.get(item.dealId);
    const deal = dealById.get(item.dealId);
    const lane = issueLane(item.issueKey);
    floorNeeds.push({
      key: `${item.dealId}-${item.issueKey}`,
      lane,
      rank: LANE_RANK[lane],
      shipBy: queueItem?.shipBy ?? "",
      name: item.dealName,
      problem: item.detail || item.issue,
      money: deal ? formatMoney(deal.amount) : "",
      href: step.href,
      pill: step.label,
      testId: `row-glance-${item.dealId}-${item.issueKey}`,
      dealId: item.dealId,
      issueKey: item.issueKey,
      icon: item.issueKey === "no_plates" ? FileUp : AlertTriangle,
    });
  }
  if (pendingReview > 0) {
    floorNeeds.push({
      key: "intake-review",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `${pendingReview} intake waiting`,
      problem: "Approve or cancel paid order forms",
      money: "",
      href: "/orders",
      pill: "Open Intake",
      testId: "row-glance-intake-review",
      icon: Link2,
    });
  }
  if (awaitingClient > 0) {
    floorNeeds.push({
      key: "awaiting-client",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `${awaitingClient} buyer link${awaitingClient === 1 ? "" : "s"} open`,
      problem: "Still awaiting client details",
      money: "",
      href: floorFocusMeta("buyer").workspaceHref,
      pill: "Open Intake",
      testId: "row-glance-awaiting-client",
      icon: Link2,
    });
  }
  if (buyNow.length > 0) {
    floorNeeds.push({
      key: "resin",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `Buy resin · ${buyNow.length}`,
      problem: `${buyNow[0]?.name}${buyNow.length > 1 ? ` +${buyNow.length - 1}` : ""}`,
      money: "",
      href: "/resin",
      pill: "Resin stock",
      testId: "row-glance-resin-buy",
      icon: Beaker,
    });
  }
  if (fepDue.length > 0) {
    floorNeeds.push({
      key: "fep",
      lane: "shop",
      rank: LANE_RANK.shop,
      shipBy: "",
      name: `FEP due · ${fepDue.length}`,
      problem: fepDue.map((printer) => printer.name).slice(0, 2).join(", "),
      money: "",
      href: "/printers",
      pill: "Printers",
      testId: "row-glance-fep-due",
      icon: Printer,
    });
  }
  const seenDeals = new Set(floorNeeds.map((need) => need.dealId).filter(Boolean));
  for (const item of queueItems) {
    if (item.needsReply && !seenDeals.has(item.dealId)) {
      floorNeeds.push({
        key: `${item.dealId}-reply`,
        lane: "warn",
        rank: LANE_RANK.warn,
        shipBy: item.shipBy,
        name: item.dealName,
        problem: "Waiting on a reply",
        money: formatMoney(item.amount),
        href: queueDealHref(item.dealId),
        pill: "Needs reply",
        testId: `row-floor-reply-${item.dealId}`,
        dealId: item.dealId,
        icon: AlertTriangle,
      });
      seenDeals.add(item.dealId);
    }
    const nearShip = item.bucket === "ship_ready" || item.readyToPack || item.fulfillment.readyPercent >= 80;
    const address = addressStatusPill(item.addressStatus);
    if (
      nearShip &&
      item.addressStatus !== "ready" &&
      item.addressStatus !== "pickup" &&
      address.tone !== "good" &&
      !floorNeeds.some((need) => need.dealId === item.dealId && need.key.endsWith("-address"))
    ) {
      floorNeeds.push({
        key: `${item.dealId}-address`,
        lane: "warn",
        rank: LANE_RANK.warn,
        shipBy: item.shipBy,
        name: item.dealName,
        problem: address.label,
        money: formatMoney(item.amount),
        href: queueDealHref(item.dealId),
        pill: address.label,
        testId: `row-floor-address-${item.dealId}`,
        dealId: item.dealId,
        chaseDraft: item.chaseDraft || undefined,
        icon: MapPin,
      });
    }
  }
  floorNeeds.sort((a, b) => {
    const aOver = a.shipBy && a.shipBy < today ? 0 : 1;
    const bOver = b.shipBy && b.shipBy < today ? 0 : 1;
    return aOver - bOver || a.rank - b.rank || (a.shipBy || "9999").localeCompare(b.shipBy || "9999") || a.name.localeCompare(b.name);
  });

  const shipPressure = shipAgenda.overdue.length + shipAgenda.dueToday.length;
  const clearFloor = floorNeeds.length === 0 && shipPressure === 0;

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

      <FloorNeeds
        needs={floorNeeds}
        portalId={portalId}
        dismissPending={dismissAttention.isPending}
        onDismiss={(dealId, issueKey) => dismissAttention.mutate({ dealId, issueKey })}
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

      {clearFloor ? (
        <p className="text-sm text-muted-foreground" data-testid="text-floor-clear">
          Floor is clear — when something needs you, it shows up in the list.
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
        subtitle=""
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
