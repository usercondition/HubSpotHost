import { useMutation, useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Link2,
  ListOrdered,
  Printer,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { attentionNextStep, floorFocusMeta, hubspotDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  HealthResponse,
  PerformanceResponse,
  PrinterFleetSnapshot,
  ResinReorderResponse,
} from "@shared/schema";

/** Keep Floor above the fold — rest of open jobs live on Queue. */
const FLOOR_ACTIVE_DEAL_CAP = 8;
/** Glance rows budget (intake/resin/FEP + deal alerts). */
const FLOOR_NEXT_BUDGET = 5;

function SystemStatusPill({ health }: { health: HealthResponse | undefined }) {
  if (!health) return null;
  const live = health.safety.liveWriteReady === true;
  const signing = health.webhook.verification === "configured";
  const storageWarn = health.storage?.warning;
  const ok = live && signing && !storageWarn;
  if (ok) return null;

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

function countByIssueKey(attention: PerformanceResponse["attention"], key: string): number {
  return attention.filter((item) => item.issueKey === key).length;
}

function PressureChip({
  label,
  value,
  tone,
  href,
  testId,
}: {
  label: string;
  value: number;
  tone: "neutral" | "good" | "warn" | "bad";
  href: string;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-tone={tone === "neutral" ? undefined : tone}
      title={`Open ${label}`}
      className={cn(
        "inline-flex min-w-[3.75rem] flex-1 flex-col rounded-md border px-2 py-1 text-left transition-colors hover:border-primary/50 hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-[4.25rem] sm:flex-none",
        tone === "warn" && "border-chart-4/40 bg-chart-4/10",
        tone === "bad" && "border-destructive/40 bg-destructive/10",
        tone === "good" && "border-accent/35 bg-accent/10",
        tone === "neutral" && "border-border bg-muted/40",
      )}
    >
      <span className="rule-label">{label}</span>
      <span
        className={cn(
          "mt-0.5 text-base font-semibold numeric tracking-tight sm:text-lg",
          tone === "warn" && "text-chart-4",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-accent",
        )}
      >
        {value}
      </span>
    </Link>
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
    return <Skeleton className="h-full min-h-[12rem] rounded-lg" data-testid="skeleton-todays-work" />;
  }

  if (performance.isError || !performance.data) {
    return (
      <div className="rounded-md border border-border bg-card p-4" data-testid="panel-todays-work-error">
        <p className="text-sm font-medium">Floor board could not be loaded</p>
        <Button className="mt-3" size="sm" onClick={() => performance.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const snapshot = performance.data;
  const attention = snapshot.attention ?? [];
  const activeDeals = (snapshot.activeDeals ?? []).filter((deal) => deal.requiresPlates);
  const visibleDeals = activeDeals.slice(0, FLOOR_ACTIVE_DEAL_CAP);
  const hiddenDealCount = Math.max(0, activeDeals.length - visibleDeals.length);
  const portalId = snapshot.hubspotPortalId;

  const platesNeeded = countByIssueKey(attention, "no_plates");
  const costsNeeded = countByIssueKey(attention, "costs_incomplete");
  const staleJobs = countByIssueKey(attention, "stale");
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

  const shopRows =
    (pendingReview > 0 ? 1 : 0) + (buyNow.length > 0 ? 1 : 0) + (fepDue.length > 0 ? 1 : 0);
  const nextItems = attention.slice(0, Math.max(0, FLOOR_NEXT_BUDGET - shopRows));
  const clearFloor = platesNeeded + costsNeeded + staleJobs + pendingReview + awaitingClient === 0
    && buyNow.length === 0
    && fepDue.length === 0
    && nextItems.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5" data-testid="panel-todays-work">
      {/* Pressure chips — always visible */}
      <div
        className="flex shrink-0 flex-wrap gap-1.5"
        aria-label="Today’s attention metrics"
        data-testid="panel-todays-metrics"
      >
        <PressureChip
          label="Plates"
          value={platesNeeded}
          tone={platesNeeded > 0 ? "warn" : "good"}
          href={floorFocusMeta("plates").workspaceHref}
          testId="card-todays-plates"
        />
        <PressureChip
          label="Costs"
          value={costsNeeded}
          tone={costsNeeded > 0 ? "warn" : "good"}
          href={floorFocusMeta("costs").workspaceHref}
          testId="card-todays-costs"
        />
        <PressureChip
          label="Stale"
          value={staleJobs}
          tone={staleJobs > 0 ? "bad" : "good"}
          href={floorFocusMeta("stale").workspaceHref}
          testId="card-todays-stale"
        />
        <PressureChip
          label="Intake"
          value={pendingReview}
          tone={pendingReview > 0 ? "warn" : "neutral"}
          href={floorFocusMeta("intake").workspaceHref}
          testId="card-todays-pending-review"
        />
        <PressureChip
          label="Buyer"
          value={awaitingClient}
          tone={awaitingClient > 0 ? "warn" : "neutral"}
          href={floorFocusMeta("buyer").workspaceHref}
          testId="card-todays-awaiting-client"
        />
        {clearFloor ? (
          <StatusPill tone="good" icon={CheckCircle2} label="Clear" testId="status-floor-clear" />
        ) : (
          <StatusPill
            tone="warn"
            icon={AlertTriangle}
            label={`${attention.length + pendingReview} open`}
            testId="status-floor-pressure"
          />
        )}
      </div>

      {/* Two-pane command center — fills remaining viewport */}
      <div className="grid min-h-0 flex-1 gap-2.5 md:grid-cols-2">
        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card"
          data-testid="panel-floor-glance"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <p className="text-sm font-semibold tracking-tight">{clearFloor ? "Clear" : "Do this next"}</p>
              <p className="text-[0.6875rem] text-muted-foreground">
                {clearFloor ? "Nothing blocking right now." : "Act here — don’t hunt other tabs."}
              </p>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {clearFloor ? (
              <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="text-floor-clear">
                When something needs plates, costs, or review, it shows up here first.
              </p>
            ) : (
              <div className="space-y-1.5" data-testid="list-floor-next">
                {pendingReview > 0 ? (
                  <GlanceRow
                    tone="warn"
                    testId="row-glance-intake-review"
                    title={`${pendingReview} intake form${pendingReview === 1 ? "" : "s"} waiting`}
                    detail="Approve or cancel paid order intake"
                    action={
                      <Button asChild size="sm" data-testid="button-glance-open-intake">
                        <Link href="/orders">
                          <Link2 className="mr-1.5 h-3.5 w-3.5" />
                          Intake
                        </Link>
                      </Button>
                    }
                  />
                ) : null}

                {buyNow.length > 0 ? (
                  <GlanceRow
                    tone="warn"
                    testId="row-glance-resin-buy"
                    title={`Buy resin · ${buyNow.length}`}
                    detail={`${buyNow[0]?.name}${buyNow.length > 1 ? ` +${buyNow.length - 1}` : ""}`}
                    action={
                      <Button asChild size="sm" variant="outline" data-testid="button-glance-open-resin">
                        <Link href="/resin">
                          <Beaker className="mr-1.5 h-3.5 w-3.5" />
                          Resin
                        </Link>
                      </Button>
                    }
                  />
                ) : null}

                {fepDue.length > 0 ? (
                  <GlanceRow
                    tone="warn"
                    testId="row-glance-fep-due"
                    title={`FEP due · ${fepDue.length}`}
                    detail={fepDue
                      .map((p) => p.name)
                      .slice(0, 2)
                      .join(", ")}
                    action={
                      <Button asChild size="sm" variant="outline" data-testid="button-glance-open-printers">
                        <Link href="/printers">
                          <Printer className="mr-1.5 h-3.5 w-3.5" />
                          Printers
                        </Link>
                      </Button>
                    }
                  />
                ) : null}

                {nextItems.map((item, index) => {
                  const step = attentionNextStep({
                    dealId: item.dealId,
                    issue: item.issue,
                    portalId,
                  });
                  const tone = item.severity === "bad" ? "bad" : "warn";
                  return (
                    <GlanceRow
                      key={`${item.dealId}-${item.issueKey}`}
                      tone={tone}
                      testId={`row-glance-${item.dealId}-${item.issueKey}`}
                      title={item.dealName}
                      detail={`${item.issue} · ${item.stage}`}
                      style={{ animationDelay: `${(index + 1) * 30}ms` }}
                      action={
                        <div className="flex shrink-0 items-center gap-1">
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
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={dismissAttention.isPending}
                            onClick={() =>
                              dismissAttention.mutate({ dealId: item.dealId, issueKey: item.issueKey })
                            }
                            data-testid={`button-glance-skip-${item.dealId}-${item.issueKey}`}
                          >
                            Skip
                          </Button>
                        </div>
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section
          className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card"
          data-testid="panel-todays-active-deals"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div>
              <p className="text-sm font-semibold tracking-tight">Jobs in flight</p>
              <p className="text-[0.6875rem] text-muted-foreground">
                {activeDeals.length > 0
                  ? `${activeDeals.length} open print job${activeDeals.length === 1 ? "" : "s"}`
                  : "No open print jobs"}
              </p>
            </div>
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs" data-testid="link-floor-open-queue">
              <Link href="/queue">Queue</Link>
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {visibleDeals.length > 0 ? (
              <ul className="space-y-1">
                {visibleDeals.map((deal) => {
                  const needsPlates = deal.promptAttachPlates;
                  const dealAlerts = attention.filter((item) => item.dealId === deal.dealId);
                  const needsCosts = dealAlerts.some((item) => item.issueKey === "costs_incomplete");
                  const isStale = dealAlerts.some((item) => item.issueKey === "stale");
                  const tone = isStale ? "bad" : needsPlates || needsCosts ? "warn" : "good";
                  const badge = needsPlates
                    ? "Plates"
                    : needsCosts
                      ? "Costs"
                      : isStale
                        ? "Stale"
                        : "OK";

                  return (
                    <li
                      key={deal.dealId}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-border/80 px-2 py-1.5",
                        tone === "warn" && "border-chart-4/35 bg-chart-4/5",
                        tone === "bad" && "border-destructive/35 bg-destructive/5",
                      )}
                      data-testid={`row-todays-active-deal-${deal.dealId}`}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{deal.dealName}</p>
                        <p className="truncate text-[0.6875rem] text-muted-foreground">
                          {deal.stage}
                          {deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}
                          {" · "}
                          <span className={cn(tone === "bad" && "text-destructive", tone === "warn" && "text-chart-4")}>
                            {badge}
                          </span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5 text-xs">
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
                          className="text-muted-foreground hover:text-foreground"
                          data-testid={`link-todays-hubspot-${deal.dealId}`}
                          aria-label="Open in HubSpot"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="empty-todays-active-deals">
                New print deals land here once they’re in the pipeline.
              </p>
            )}
            {hiddenDealCount > 0 ? (
              <p className="mt-2 px-1 text-[0.6875rem] text-muted-foreground" data-testid="text-floor-more-deals">
                +{hiddenDealCount} more on{" "}
                <Link href="/queue" className="font-medium text-primary hover:underline">
                  Queue
                </Link>
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function GlanceRow({
  title,
  detail,
  action,
  tone,
  testId,
  style,
}: {
  title: string;
  detail: string;
  action: ReactNode;
  tone: "warn" | "bad" | "good";
  testId: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "glance-item glance-in !py-1.5",
        tone === "warn" && "border-chart-4/35",
        tone === "bad" && "border-destructive/35",
      )}
      data-tone={tone}
      data-testid={testId}
      style={style}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

export default function Dashboard() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col overflow-hidden" data-testid="page-floor">
      <PageHeader
        title="Floor"
        subtitle="At a glance — next actions and jobs in flight."
        actions={<SystemStatusPill health={health.data} />}
      />

      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2 md:px-5">
        <TodaysWork />
      </div>
    </div>
  );
}
