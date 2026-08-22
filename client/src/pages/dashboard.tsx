import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { attentionNextStep, hubspotDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
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

function countByIssueKey(attention: PerformanceResponse["attention"], key: string): number {
  return attention.filter((item) => item.issueKey === key).length;
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
  const attention = snapshot.attention ?? [];
  const activeDeals = (snapshot.activeDeals ?? []).filter((deal) => deal.requiresPlates);
  const portalId = snapshot.hubspotPortalId;

  const platesNeeded = countByIssueKey(attention, "no_plates");
  const costsNeeded = countByIssueKey(attention, "costs_incomplete");
  const staleJobs = countByIssueKey(attention, "stale");
  const pendingReview = snapshot.intake.pendingReview;
  const awaitingClient = snapshot.intake.awaitingClient;
  const totalPressure =
    platesNeeded + costsNeeded + staleJobs + pendingReview + (awaitingClient > 0 ? 1 : 0);

  const nextItems = attention.slice(0, 5);
  const clearFloor = totalPressure === 0 && nextItems.length === 0;

  return (
    <div className="space-y-3" data-testid="panel-todays-work">
      <WorkspaceSection
        eyebrow="Glance"
        title={clearFloor ? "Floor is clear" : "Do this next"}
        description={
          clearFloor
            ? "No missing plates, costs, stale jobs, or intake waiting on you."
            : "One list for what’s blocking you — act here, don’t hunt other tabs."
        }
        actions={
          clearFloor ? (
            <StatusPill tone="good" icon={CheckCircle2} label="Clear" testId="status-floor-clear" />
          ) : (
            <StatusPill
              tone="warn"
              icon={AlertTriangle}
              label={`${attention.length + pendingReview} open`}
              testId="status-floor-pressure"
            />
          )
        }
        testId="panel-floor-glance"
      >
        {clearFloor ? (
          <p className="text-sm text-muted-foreground" data-testid="text-floor-clear">
            When something needs plates, costs, or review, it shows up here first.
          </p>
        ) : (
          <div className="glance-list" data-testid="list-floor-next">
            {pendingReview > 0 ? (
              <div className="glance-item glance-in" data-tone="warn" data-testid="row-glance-intake-review">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {pendingReview} intake form{pendingReview === 1 ? "" : "s"} waiting for review
                  </p>
                  <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                    Approve or reject paid order intake
                  </p>
                </div>
                <Button asChild size="sm" data-testid="button-glance-open-intake">
                  <Link href="/orders">
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    Open Intake
                  </Link>
                </Button>
              </div>
            ) : null}

            {nextItems.map((item, index) => {
              const step = attentionNextStep({
                dealId: item.dealId,
                issue: item.issue,
                portalId,
              });
              const tone = item.severity === "bad" ? "bad" : "warn";
              return (
                <div
                  key={`${item.dealId}-${item.issueKey}`}
                  className="glance-item glance-in"
                  data-tone={tone}
                  style={{ animationDelay: `${(index + 1) * 40}ms` }}
                  data-testid={`row-glance-${item.dealId}-${item.issueKey}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{item.dealName}</p>
                      <StatusPill tone={tone} label={item.issue} />
                    </div>
                    <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                      {item.stage} · {item.detail}
                    </p>
                  </div>
                  <Button asChild size="sm" variant={tone === "bad" ? "destructive" : "default"}>
                    <Link href={step.href} data-testid={`link-glance-action-${item.dealId}`}>
                      {item.issueKey === "no_plates" ? (
                        <FileUp className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <ListOrdered className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {step.label}
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </WorkspaceSection>

      <WorkspaceSection
        eyebrow="Counts"
        title="At a glance"
        description="Broken out so you can see pressure without opening every page."
        testId="panel-todays-metrics"
      >
        <div className="metric-strip" aria-label="Today’s attention metrics">
          <MetricTile
            label="Need plates"
            value={String(platesNeeded)}
            hint="Attach CTB / slice files"
            tone={platesNeeded > 0 ? "warn" : "good"}
            testId="card-todays-plates"
          />
          <MetricTile
            label="Need costs"
            value={String(costsNeeded)}
            hint="Material / labor / ship"
            tone={costsNeeded > 0 ? "warn" : "good"}
            testId="card-todays-costs"
          />
          <MetricTile
            label="Stale"
            value={String(staleJobs)}
            hint="No HubSpot update lately"
            tone={staleJobs > 0 ? "bad" : "good"}
            testId="card-todays-stale"
          />
          <MetricTile
            label="Intake review"
            value={String(pendingReview)}
            hint="Waiting on you"
            tone={pendingReview > 0 ? "warn" : "neutral"}
            testId="card-todays-pending-review"
          />
          <MetricTile
            label="Awaiting buyer"
            value={String(awaitingClient)}
            hint="Form not finished"
            tone={awaitingClient > 0 ? "warn" : "neutral"}
            testId="card-todays-awaiting-client"
          />
        </div>
      </WorkspaceSection>

      <WorkspaceSection
        eyebrow="Active"
        title="Print jobs in flight"
        description={
          activeDeals.length > 0
            ? `${activeDeals.length} open print job${activeDeals.length === 1 ? "" : "s"} — badges show what each still needs.`
            : "No open print jobs right now."
        }
        dense
        testId="panel-todays-active-deals"
      >
        {activeDeals.length > 0 ? (
          <DataList>
            {activeDeals.map((deal) => {
              const needsPlates = deal.promptAttachPlates;
              const dealAlerts = attention.filter((item) => item.dealId === deal.dealId);
              const needsCosts = dealAlerts.some((item) => item.issueKey === "costs_incomplete");
              const isStale = dealAlerts.some((item) => item.issueKey === "stale");
              const tone = isStale ? "bad" : needsPlates || needsCosts ? "warn" : "good";
              const badge = needsPlates
                ? "Needs plates"
                : needsCosts
                  ? "Needs costs"
                  : isStale
                    ? "Stale"
                    : "On track";

              return (
                <DataRow
                  key={deal.dealId}
                  title={deal.dealName}
                  meta={`${deal.stage}${deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}`}
                  tone={tone}
                  badge={badge}
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
                        className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
                        data-testid={`link-todays-hubspot-${deal.dealId}`}
                      >
                        HubSpot
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  }
                />
              );
            })}
          </DataList>
        ) : (
          <p className="px-1 py-2 text-sm text-muted-foreground" data-testid="empty-todays-active-deals">
            New print deals will land here once they’re in the pipeline.
          </p>
        )}
      </WorkspaceSection>
    </div>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const { isUnlocked, headers } = useOwnerSession();
  const live = health.data?.safety.liveWriteReady === true;
  const signing = health.data?.webhook.verification === "configured";
  const showSystem = !health.data || !live || !signing || Boolean(health.data.storage?.warning);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Floor"
        subtitle="At-a-glance shop board — next actions, pressure counts, then jobs in flight."
      />

      <div className="page-stack">
        <TodaysWork />
        {isUnlocked ? <TrackerAssistantPanel headers={headers} /> : null}
        {showSystem ? <SystemStatus health={health.data} /> : null}
      </div>
    </div>
  );
}
