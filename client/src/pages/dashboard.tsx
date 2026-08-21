import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  PackageCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { TrackerAssistantPanel } from "@/components/tracker-assistant";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import type { HealthResponse, PerformanceResponse } from "@shared/schema";

function SystemStatus({ health }: { health: HealthResponse | undefined }) {
  const live = health?.safety.liveWriteReady === true;
  const signing = health?.webhook.verification === "configured";
  const storageWarn = health?.storage?.warning;

  if (!health) {
    return <Skeleton className="h-16 w-full rounded-md" data-testid="skeleton-system-status" />;
  }

  return (
    <section
      className="rounded-md border border-card-border bg-card/90 p-3"
      aria-labelledby="system-status-title"
      data-testid="panel-system-status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="rule-label">Office</p>
          <h2 id="system-status-title" className="text-sm font-semibold tracking-tight">
            {live && signing && !storageWarn ? "HubSpot + ops ready" : "Needs a quick check"}
          </h2>
        </div>
        <StatusPill
          tone={live && signing && !storageWarn ? "good" : "warn"}
          icon={live && signing && !storageWarn ? CheckCircle2 : SlidersHorizontal}
          label={live && signing && !storageWarn ? "Live" : "Review"}
          testId="status-command-center"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
        <span data-testid="text-hubspot-write-status">
          HubSpot: {live ? "live writes" : "safe test mode"}
        </span>
        <span data-testid="text-webhook-status">
          Webhook: {signing ? "secured" : "needs setup"}
        </span>
        {!signing || storageWarn ? (
          <Link href="/setup" className="font-medium text-primary hover:underline">
            Open Setup
          </Link>
        ) : null}
      </div>
      {storageWarn ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="panel-storage-warning">
          {storageWarn}
        </p>
      ) : null}
    </section>
  );
}

function TodaysWork() {
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
    return <Skeleton className="h-48 rounded-md" data-testid="skeleton-todays-work" />;
  }

  if (performance.isError || !performance.data) {
    return (
      <section className="rounded-md border border-destructive/35 bg-card p-4" data-testid="panel-todays-work-error">
        <p className="text-sm font-medium">Floor board could not be loaded</p>
        <Button className="mt-3" size="sm" onClick={() => performance.refetch()}>
          Try again
        </Button>
      </section>
    );
  }

  const snapshot = performance.data;
  const activeDeals = snapshot.activeDeals ?? [];
  const portalId = snapshot.hubspotPortalId;

  return (
    <section
      className="rounded-md border border-card-border bg-card/95 shadow-sm"
      aria-labelledby="todays-work-title"
      data-testid="panel-todays-work"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div>
          <p className="rule-label">Run</p>
          <h2 id="todays-work-title" className="text-sm font-semibold tracking-tight">
            What needs you
          </h2>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button asChild size="sm" data-testid="button-todays-work-queue">
            <Link href="/queue">
              <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
              Open Queue
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline" data-testid="button-todays-work-performance">
            <Link href="/performance">
              <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
              Stats
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-2 p-3 sm:grid-cols-3">
        <Link
          href="/orders"
          className="rounded-md border border-border bg-muted/50 p-2.5 transition-colors hover:border-primary/35 hover:bg-muted/80"
          data-testid="card-todays-pending-review"
        >
          <p className="rule-label">Pending review</p>
          <p className="mt-1 text-xl font-semibold tracking-tight numeric">{snapshot.intake.pendingReview}</p>
        </Link>
        <Link
          href="/orders"
          className="rounded-md border border-border bg-muted/50 p-2.5 transition-colors hover:border-primary/35 hover:bg-muted/80"
          data-testid="card-todays-awaiting-client"
        >
          <p className="rule-label">Awaiting client</p>
          <p className="mt-1 text-xl font-semibold tracking-tight numeric">{snapshot.intake.awaitingClient}</p>
        </Link>
        <div className="rounded-md border border-border bg-muted/50 p-2.5" data-testid="card-todays-attention">
          <p className="rule-label">Open alerts</p>
          <p className="mt-1 text-xl font-semibold tracking-tight numeric">{snapshot.summary.attentionCount}</p>
        </div>
      </div>

      <div className="grid gap-1.5 border-t border-border px-3 py-2.5 sm:grid-cols-3" data-testid="panel-floor-shortcuts">
        <Link
          href="/queue"
          className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-muted/60"
        >
          <ListOrdered className="h-3.5 w-3.5 text-primary" />
          Queue — print & ship
        </Link>
        <Link
          href="/prints"
          className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-muted/60"
        >
          <FileUp className="h-3.5 w-3.5 text-primary" />
          Prints — attach plates
        </Link>
        <Link
          href="/orders"
          className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs font-medium transition-colors hover:border-primary/40 hover:bg-muted/60"
        >
          <Link2 className="h-3.5 w-3.5 text-primary" />
          Intake — buyer forms
        </Link>
      </div>

      {activeDeals.length > 0 ? (
        <div className="border-t border-border px-3 py-2.5" data-testid="panel-todays-active-deals">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="rule-label">Active orders</p>
            <div className="flex items-center gap-2 text-xs">
              <Link href="/deals" className="font-medium text-primary hover:underline" data-testid="link-todays-all-deals">
                Board
              </Link>
              <Link href="/queue" className="font-medium text-primary hover:underline" data-testid="link-todays-queue">
                Queue
              </Link>
            </div>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {activeDeals.map((deal) => (
              <li
                key={deal.dealId}
                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2"
                data-testid={`row-todays-active-deal-${deal.dealId}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{deal.dealName}</p>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                    {deal.stage}
                    {deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2.5 text-xs">
                  <Link
                    href={queueDealHref(deal.dealId)}
                    className="font-medium text-primary hover:underline"
                    data-testid={`link-todays-ops-${deal.dealId}`}
                  >
                    Ops
                  </Link>
                  {deal.promptAttachPlates ? (
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
                    className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
                    data-testid={`link-todays-hubspot-${deal.dealId}`}
                  >
                    HubSpot
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const { isUnlocked, ownerCode } = useOwnerSession();
  const live = health.data?.safety.liveWriteReady === true;
  const signing = health.data?.webhook.verification === "configured";
  const showSystem = !health.data || !live || !signing || Boolean(health.data.storage?.warning);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Floor"
        subtitle="Today’s board — Queue carries the work; HubSpot holds the CRM."
      />

      <div className="page-stack">
        <TodaysWork />
        {isUnlocked ? <TrackerAssistantPanel headers={{ "x-paid-order-access-code": ownerCode }} /> : null}

        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-card-border bg-card/90 p-3"
          aria-labelledby="start-order-title"
          data-testid="panel-start-order"
        >
          <div className="min-w-0">
            <p className="rule-label">Take</p>
            <h2 id="start-order-title" className="text-sm font-semibold tracking-tight">
              New paid order
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Send an intake link or enter manually — both land in HubSpot.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button asChild size="sm" data-testid="button-start-paid-order">
              <Link href="/orders">
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                Intake
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" data-testid="button-manual-order">
              <Link href="/paid-orders">
                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
                Manual
              </Link>
            </Button>
          </div>
        </section>

        {showSystem ? <SystemStatus health={health.data} /> : null}
      </div>
    </div>
  );
}
