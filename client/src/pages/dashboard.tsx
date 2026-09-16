import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  Loader2,
  Printer,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { attentionNextStep, floorFocusMeta, hubspotDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  HealthResponse,
  PerformanceResponse,
  PrinterFleetSnapshot,
  ResinReorderResponse,
} from "@shared/schema";

type AttentionItem = PerformanceResponse["attention"][number];
type ActiveDeal = PerformanceResponse["activeDeals"][number];

/** Cap in-flight strip so Floor stays scannable; full board is Queue. */
const FLOOR_ACTIVE_DEAL_CAP = 8;

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
      className="inline-flex items-center gap-1.5 rounded-md border border-chart-4/40 bg-chart-4/10 px-2 py-1 text-[0.6875rem] font-medium text-chart-4 hover:bg-chart-4/15"
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
      className="workspace-node w-full p-3 text-left"
      data-tone={tone}
      data-testid={`row-glance-${item.dealId}-${item.issueKey}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">{item.dealName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.stage} · {item.detail}
          </p>
        </div>
        <StatusPill tone={tone} label={item.issue} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Link
          href={step.href}
          className="font-medium text-primary hover:underline"
          data-testid={`link-glance-action-${item.dealId}`}
        >
          {item.issueKey === "no_plates" ? (
            <span className="inline-flex items-center gap-1">
              <FileUp className="h-3 w-3" />
              {step.label}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <ListOrdered className="h-3 w-3" />
              {step.label}
            </span>
          )}
        </Link>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          disabled={dismissPending}
          onClick={onDismiss}
          data-testid={`button-glance-skip-${item.dealId}-${item.issueKey}`}
        >
          Skip
        </button>
        <a
          href={hubspotDealHref(item.dealId, portalId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          HubSpot
          <ExternalLink className="h-3 w-3" />
        </a>
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
    <article className="workspace-node w-full p-3 text-left" data-tone={tone} data-testid={testId}>
      <p className="truncate text-sm font-semibold tracking-tight">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      <div className="mt-2">
        <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          <Icon className="h-3 w-3" />
          {label}
        </Link>
      </div>
    </article>
  );
}

function FlightCard({
  deal,
  attention,
  portalId,
}: {
  deal: ActiveDeal;
  attention: AttentionItem[];
  portalId: string | null | undefined;
}) {
  const needsPlates = deal.promptAttachPlates;
  const dealAlerts = attention.filter((item) => item.dealId === deal.dealId);
  const needsCosts = dealAlerts.some((item) => item.issueKey === "costs_incomplete");
  const isStale = dealAlerts.some((item) => item.issueKey === "stale");
  const tone = isStale ? "bad" : needsPlates || needsCosts ? "warn" : "good";

  return (
    <article
      className="workspace-node w-full p-3 text-left"
      data-tone={tone === "good" ? undefined : tone}
      data-testid={`row-todays-active-deal-${deal.dealId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">{deal.dealName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {deal.stage}
            {deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}
          </p>
        </div>
        <p className="text-sm font-medium">{formatMoney(deal.amount)}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {needsPlates ? <StatusPill tone="warn" icon={FileUp} label="Needs plates" /> : null}
        {needsCosts ? <StatusPill tone="warn" icon={AlertTriangle} label="Needs costs" /> : null}
        {isStale ? <StatusPill tone="bad" icon={AlertTriangle} label="Stale" /> : null}
        {!needsPlates && !needsCosts && !isStale ? (
          <StatusPill tone="good" icon={CheckCircle2} label="On track" />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Link
          href={queueDealHref(deal.dealId)}
          className="font-medium text-primary hover:underline"
          data-testid={`link-todays-ops-${deal.dealId}`}
        >
          Ops
        </Link>
        {needsPlates ? (
          <Link
            href={printsDealHref(deal.dealId)}
            className="font-medium text-primary hover:underline"
            data-testid={`link-todays-attach-${deal.dealId}`}
          >
            Plates
          </Link>
        ) : null}
        <a
          href={hubspotDealHref(deal.dealId, portalId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          data-testid={`link-todays-hubspot-${deal.dealId}`}
        >
          HubSpot
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </article>
  );
}

function FloorColumn({
  title,
  subtitle,
  count,
  empty,
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  empty: string;
  testId: string;
  children: React.ReactNode;
}) {
  const hasKids = Array.isArray(children) ? children.filter(Boolean).length > 0 : Boolean(children);
  return (
    <section className="queue-lane min-w-0" data-testid={testId}>
      <div className="queue-lane-header">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">
            {title}{" "}
            <span className="numeric text-muted-foreground">({count})</span>
          </h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <div className="queue-lane-body">
        {!hasKids || count === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        ) : (
          children
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

  const clearFloor =
    plates.length + costs.length + stale.length + shopCount === 0;

  return (
    <div className="space-y-4" data-testid="panel-todays-work">
      <div className="metric-strip" aria-label="Today’s attention metrics" data-testid="panel-todays-metrics">
        <StatCard
          label="Needs plates"
          value={String(plates.length)}
          hint="Open Print Orders missing CTB"
          icon={FileUp}
          tone={plates.length > 0 ? "warn" : "good"}
          testId="card-todays-plates"
        />
        <StatCard
          label="Needs costs"
          value={String(costs.length)}
          hint="Material / postage incomplete"
          icon={AlertTriangle}
          tone={costs.length > 0 ? "warn" : "good"}
          testId="card-todays-costs"
        />
        <StatCard
          label="Stale"
          value={String(stale.length)}
          hint="No HubSpot activity lately"
          icon={Clock3}
          tone={stale.length > 0 ? "bad" : "good"}
          testId="card-todays-stale"
        />
        <StatCard
          label="Intake"
          value={String(pendingReview)}
          hint="Awaiting your review"
          icon={Link2}
          tone={pendingReview > 0 ? "warn" : "neutral"}
          testId="card-todays-pending-review"
        />
        <StatCard
          label="Buyer"
          value={String(awaitingClient)}
          hint="Links still open"
          icon={Link2}
          tone={awaitingClient > 0 ? "warn" : "neutral"}
          testId="card-todays-awaiting-client"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {clearFloor ? (
          <StatusPill tone="good" icon={CheckCircle2} label="Floor clear" testId="status-floor-clear" />
        ) : (
          <StatusPill
            tone="warn"
            icon={AlertTriangle}
            label={`${attention.length + pendingReview} open`}
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

      <div className="grid gap-6 xl:grid-cols-4 lg:grid-cols-2" data-testid="panel-floor-glance">
        <FloorColumn
          title="Needs plates"
          subtitle="Attach CTB / slice files"
          count={plates.length}
          empty="All open print jobs have plates."
          testId="column-floor-plates"
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
            <h2 className="text-sm font-semibold tracking-tight">
              Jobs in flight{" "}
              <span className="numeric text-muted-foreground">({activeDeals.length})</span>
            </h2>
            <p className="text-xs text-muted-foreground">
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
                <FlightCard key={deal.dealId} deal={deal} attention={attention} portalId={portalId} />
              ))}
            </div>
          )}
          {hiddenDealCount > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="text-floor-more-deals">
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
