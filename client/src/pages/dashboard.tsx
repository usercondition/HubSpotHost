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
import {
  DataList,
  DataRow,
  MetricTile,
  StatusPill,
  WorkspaceSection,
} from "@/components/primitives";
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
    <WorkspaceSection
      eyebrow="Office"
      title={live && signing && !storageWarn ? "HubSpot + ops ready" : "Needs a quick check"}
      description="Writes, webhooks, and storage for the shop workspace."
      actions={
        <StatusPill
          tone={live && signing && !storageWarn ? "good" : "warn"}
          icon={live && signing && !storageWarn ? CheckCircle2 : SlidersHorizontal}
          label={live && signing && !storageWarn ? "Live" : "Review"}
          testId="status-command-center"
        />
      }
      dense
      testId="panel-system-status"
    >
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
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
    </WorkspaceSection>
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
      <WorkspaceSection title="Floor board could not be loaded" testId="panel-todays-work-error">
        <Button size="sm" onClick={() => performance.refetch()}>
          Try again
        </Button>
      </WorkspaceSection>
    );
  }

  const snapshot = performance.data;
  const activeDeals = (snapshot.activeDeals ?? []).filter((deal) => deal.requiresPlates);
  const portalId = snapshot.hubspotPortalId;
  const alertTone = snapshot.summary.attentionCount > 0 ? ("warn" as const) : ("good" as const);

  return (
    <div className="space-y-3" data-testid="panel-todays-work">
      <WorkspaceSection
        eyebrow="Run"
        title="What needs you"
        description="Glance metrics first — then open the work."
        actions={
          <>
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
          </>
        }
      >
        <div className="metric-strip" aria-label="Today’s attention metrics">
          <Link
            href="/orders"
            className="block transition-opacity hover:opacity-90"
            data-testid="card-todays-pending-review"
          >
            <MetricTile
              label="Pending review"
              value={String(snapshot.intake.pendingReview)}
              hint="Intake waiting on you"
              tone={snapshot.intake.pendingReview > 0 ? "warn" : "neutral"}
            />
          </Link>
          <Link
            href="/orders"
            className="block transition-opacity hover:opacity-90"
            data-testid="card-todays-awaiting-client"
          >
            <MetricTile
              label="Awaiting client"
              value={String(snapshot.intake.awaitingClient)}
              hint="Buyer form not finished"
            />
          </Link>
          <MetricTile
            label="Open alerts"
            value={String(snapshot.summary.attentionCount)}
            hint="Plates, costs, stale jobs"
            tone={alertTone}
            testId="card-todays-attention"
          />
        </div>

        <div className="shortcut-grid mt-3" data-testid="panel-floor-shortcuts">
          <Link href="/queue" className="shortcut-chip">
            <ListOrdered className="h-3.5 w-3.5 text-primary" />
            Queue — print & ship
          </Link>
          <Link href="/prints" className="shortcut-chip">
            <FileUp className="h-3.5 w-3.5 text-primary" />
            Prints — attach plates
          </Link>
          <Link href="/orders" className="shortcut-chip">
            <Link2 className="h-3.5 w-3.5 text-primary" />
            Intake — buyer forms
          </Link>
        </div>
      </WorkspaceSection>

      {activeDeals.length > 0 ? (
        <WorkspaceSection
          eyebrow="Active"
          title="Print jobs in flight"
          description="Charge-only shipping/fee deals stay out of this list."
          dense
          actions={
            <div className="flex items-center gap-2 text-xs">
              <Link
                href="/deals"
                className="font-medium text-primary hover:underline"
                data-testid="link-todays-all-deals"
              >
                Board
              </Link>
              <Link
                href="/queue"
                className="font-medium text-primary hover:underline"
                data-testid="link-todays-queue"
              >
                Queue
              </Link>
            </div>
          }
          testId="panel-todays-active-deals"
        >
          <DataList>
            {activeDeals.map((deal) => (
              <DataRow
                key={deal.dealId}
                title={deal.dealName}
                meta={`${deal.stage}${deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}`}
                testId={`row-todays-active-deal-${deal.dealId}`}
                actions={
                  <>
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
                  </>
                }
              />
            ))}
          </DataList>
        </WorkspaceSection>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const { isUnlocked, ownerCode, headers } = useOwnerSession();
  const live = health.data?.safety.liveWriteReady === true;
  const signing = health.data?.webhook.verification === "configured";
  const showSystem = !health.data || !live || !signing || Boolean(health.data.storage?.warning);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Floor"
        subtitle="Grouped shop workspace — metrics, active jobs, then intake. HubSpot stays the CRM."
      />

      <div className="page-stack">
        <TodaysWork />
        {isUnlocked ? <TrackerAssistantPanel headers={headers} /> : null}

        <WorkspaceSection
          eyebrow="Take"
          title="New paid order"
          description="Send an intake link or enter manually — both land in HubSpot."
          dense
          actions={
            <>
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
            </>
          }
          testId="panel-start-order"
        >
          <p className="text-xs text-muted-foreground">
            Use Intake for buyer forms; Manual when you already have the address and amount.
          </p>
        </WorkspaceSection>

        {showSystem ? <SystemStatus health={health.data} /> : null}
      </div>
    </div>
  );
}
