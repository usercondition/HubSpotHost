import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileUp,
  Link2,
  PackageCheck,
  ShoppingBag,
  ShipWheel,
  SlidersHorizontal,
  Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, hubspotDealsListHref, printsDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { TrackerAssistantPanel } from "@/components/tracker-assistant";
import { MarketplaceFollowUpsPanel } from "@/components/marketplace-followups";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import type { HealthResponse, PerformanceResponse } from "@shared/schema";

const HUBSPOT_URL = "https://app.hubspot.com/";
const PIRATE_SHIP_URL = "https://ship.pirateship.com/";

function SystemStatus({ health }: { health: HealthResponse | undefined }) {
  const live = health?.safety.liveWriteReady === true;
  const signing = health?.webhook.verification === "configured";
  const storageWarn = health?.storage?.warning;

  if (!health) {
    return <Skeleton className="h-24 w-full rounded-lg" data-testid="skeleton-system-status" />;
  }

  return (
    <section
      className="rounded-lg border border-card-border bg-card p-5"
      aria-labelledby="system-status-title"
      data-testid="panel-system-status"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="rule-label">Connection status</p>
          <h2 id="system-status-title" className="mt-1 text-base font-semibold tracking-tight">
            Your order system is online
          </h2>
        </div>
        <StatusPill
          tone={live && signing && !storageWarn ? "good" : "warn"}
          icon={live && signing && !storageWarn ? CheckCircle2 : SlidersHorizontal}
          label={live && signing && !storageWarn ? "Ready for orders" : "Needs review"}
          testId="status-command-center"
        />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-muted/55 p-3">
          <p className="rule-label">HubSpot updates</p>
          <p className="mt-1 text-sm font-medium" data-testid="text-hubspot-write-status">
            {live ? "Live updates enabled" : "Safe test mode"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {live ? "Approved orders can create or update CRM records." : "No CRM records will be changed."}
          </p>
        </div>
        <div className="rounded-md bg-muted/55 p-3">
          <p className="rule-label">Profit automation</p>
          <p className="mt-1 text-sm font-medium" data-testid="text-webhook-status">
            {signing ? "Webhook secured" : "Webhook needs attention"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {signing ? "Cost updates are protected by HubSpot verification." : "Open System setup to verify the connection."}
          </p>
        </div>
      </div>
      {storageWarn ? (
        <div
          className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3"
          data-testid="panel-storage-warning"
        >
          <p className="text-sm font-medium">Production data may not persist</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{storageWarn}</p>
          <Link href="/setup" className="mt-2 inline-flex text-xs font-medium text-primary hover:underline">
            Review System setup
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function WorkflowStep({
  number,
  title,
  body,
  href,
  action,
  icon: Icon,
}: {
  number: string;
  title: string;
  body: string;
  href: string;
  action: string;
  icon: LucideIcon;
}) {
  return (
    <article className="relative border-t border-border pt-4 first:border-t-0 first:pt-0 md:border-l md:border-t-0 md:pl-5 md:first:pl-0">
      <div className="flex items-center gap-2 text-primary">
        <Icon className="h-4 w-4" />
        <span className="rule-label">Step {number}</span>
      </div>
      <h3 className="mt-2 text-sm font-semibold tracking-tight">{title}</h3>
      <p className="mt-1 max-w-[30ch] text-xs leading-5 text-muted-foreground">{body}</p>
      <Link
        href={href}
        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        data-testid={`link-workflow-${number}`}
      >
        {action}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </article>
  );
}

function TodaysWork() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlockMutation = useOwnerUnlock({
    successTitle: "Daily work unlocked",
    successDescription: "Intake, Manual, Orders, Print files, Supplies, and Performance share this session.",
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
        title="Unlock today’s work"
        description="See pending reviews and orders that need plates or costs — then jump straight to the next action."
        buttonLabel="Unlock today’s work"
        testIdPrefix="dashboard"
        pending={unlockMutation.isPending}
        onUnlock={(code) => unlockMutation.mutate(code)}
      />
    );
  }

  if (performance.isLoading) {
    return <Skeleton className="h-48 rounded-lg" data-testid="skeleton-todays-work" />;
  }

  if (performance.isError || !performance.data) {
    return (
      <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-todays-work-error">
        <p className="text-sm font-medium">Today’s work could not be loaded</p>
        <Button className="mt-3" size="sm" onClick={() => performance.refetch()}>
          Try again
        </Button>
      </section>
    );
  }

  const snapshot = performance.data;
  const activeDeals = snapshot.activeDeals ?? [];
  const portalId = snapshot.hubspotPortalId;
  const money = (value: number) =>
    value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  return (
    <section
      className="rounded-lg border border-card-border bg-card"
      aria-labelledby="todays-work-title"
      data-testid="panel-todays-work"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <p className="rule-label">Today’s work</p>
          <h2 id="todays-work-title" className="mt-1 text-base font-semibold tracking-tight">
            What needs you right now
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Order alerts live in the bell next to Print Operations — skip any step that doesn’t apply.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" data-testid="button-todays-work-hubspot">
            <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              HubSpot deals
            </a>
          </Button>
          <Button asChild size="sm" variant="outline" data-testid="button-todays-work-performance">
            <Link href="/performance">
              <BarChart3 className="mr-2 h-3.5 w-3.5" />
              Full performance
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-3">
        <Link
          href="/orders"
          className="rounded-md border border-border bg-muted/35 p-3 transition-colors hover:bg-muted/60"
          data-testid="card-todays-pending-review"
        >
          <p className="rule-label">Pending review</p>
          <p className="mt-1 text-2xl font-semibold numeric">{snapshot.intake.pendingReview}</p>
          <p className="mt-1 text-xs text-muted-foreground">Buyer forms waiting for your approval</p>
        </Link>
        <Link
          href="/orders"
          className="rounded-md border border-border bg-muted/35 p-3 transition-colors hover:bg-muted/60"
          data-testid="card-todays-awaiting-client"
        >
          <p className="rule-label">Awaiting client</p>
          <p className="mt-1 text-2xl font-semibold numeric">{snapshot.intake.awaitingClient}</p>
          <p className="mt-1 text-xs text-muted-foreground">Links still open for buyer details</p>
        </Link>
        <div className="rounded-md border border-border bg-muted/35 p-3" data-testid="card-todays-attention">
          <p className="rule-label">Open alerts</p>
          <p className="mt-1 text-2xl font-semibold numeric">{snapshot.summary.attentionCount}</p>
          <p className="mt-1 text-xs text-muted-foreground">Check the bell icon to review or skip reminders</p>
        </div>
      </div>

      {activeDeals.length > 0 ? (
        <div className="border-t border-border px-5 py-4" data-testid="panel-todays-active-deals">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <p className="rule-label">Active Print Orders</p>
            <div className="flex items-center gap-3">
              <p className="text-xs text-muted-foreground numeric">
                {snapshot.summary.activeOrders} open
                {snapshot.summary.activeOrders > activeDeals.length
                  ? ` · showing ${activeDeals.length}`
                  : ""}
              </p>
              <Link href="/deals" className="text-xs font-medium text-primary hover:underline" data-testid="link-todays-all-deals">
                Board
              </Link>
            </div>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {activeDeals.map((deal) => (
              <li
                key={deal.dealId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                data-testid={`row-todays-active-deal-${deal.dealId}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{deal.dealName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {deal.stage}
                    {deal.amount > 0 ? ` · ${formatMoney(deal.amount)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  {deal.promptAttachPlates ? (
                    <Link
                      href={printsDealHref(deal.dealId)}
                      className="text-xs font-medium text-primary hover:underline"
                      data-testid={`link-todays-attach-${deal.dealId}`}
                    >
                      Attach plates
                    </Link>
                  ) : null}
                  <a
                    href={hubspotDealHref(deal.dealId, portalId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
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

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Command center"
        subtitle="Run paid orders from buyer details to shipping without losing the thread."
      />

      <div className="page-stack">
        <TodaysWork />
        {isUnlocked ? <TrackerAssistantPanel headers={{ "x-paid-order-access-code": ownerCode }} /> : null}
        {isUnlocked ? <MarketplaceFollowUpsPanel headers={{ "x-paid-order-access-code": ownerCode }} /> : null}

        <section
          className="overflow-hidden rounded-lg border border-card-border bg-card"
          aria-labelledby="start-order-title"
          data-testid="panel-start-order"
        >
          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)] lg:items-end lg:p-6">
            <div>
              <p className="rule-label text-primary">Your next move</p>
              <h2 id="start-order-title" className="mt-2 text-xl font-semibold tracking-tight">
                Paid? Send the buyer their order form.
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Create a one-time link, let the buyer confirm delivery details, then approve the clean order into HubSpot.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button asChild data-testid="button-start-paid-order">
                  <Link href="/orders">
                    <Link2 className="mr-2 h-4 w-4" />
                    Start paid order
                  </Link>
                </Button>
                <Button asChild variant="outline" data-testid="button-manual-order">
                  <Link href="/paid-orders">
                    <ClipboardCheck className="mr-2 h-4 w-4" />
                    Enter one manually
                  </Link>
                </Button>
              </div>
            </div>
            <div className="border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
              <p className="rule-label">Simple rule</p>
              <p className="mt-2 text-sm font-medium leading-6">
                Buyer submits details. You verify payment. Only then does HubSpot receive the order.
              </p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                This protects your CRM from incomplete addresses and unconfirmed sales.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="workflow-title" data-testid="panel-daily-workflow">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <p className="rule-label">Daily workflow</p>
              <h2 id="workflow-title" className="mt-1 text-base font-semibold tracking-tight">
                One sale, one clear path
              </h2>
            </div>
            <span className="hidden text-xs text-muted-foreground sm:block">Repeat for every paid order</span>
          </div>
          <div className="grid gap-5 rounded-lg border border-card-border bg-card p-5 md:grid-cols-3 md:gap-0">
            <WorkflowStep
              number="01"
              title="Collect buyer details"
              body="Create the secure intake link once payment is received."
              href="/orders"
              action="Open paid order intake"
              icon={Link2}
            />
            <WorkflowStep
              number="02"
              title="Attach production data"
              body="After approval, attach each Chitubox plate so time and resin estimates land on the deal."
              href="/prints"
              action="Open Print files"
              icon={FileUp}
            />
            <WorkflowStep
              number="03"
              title="Buy and record shipping"
              body="Create a label in Pirate Ship, then enter the actual shipping cost on the deal."
              href="/operations"
              action="See cost fields"
              icon={ShipWheel}
            />
          </div>
        </section>

        <section
          className="overflow-hidden rounded-lg border border-card-border bg-card"
          aria-labelledby="control-loop-title"
          data-testid="panel-control-loop"
        >
          <div className="border-b border-border px-5 py-4">
            <p className="rule-label">Control loop</p>
            <h2 id="control-loop-title" className="mt-1 text-base font-semibold tracking-tight">
              Keep the whole business visible
            </h2>
          </div>
          <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
            <Link
              href="/prints"
              data-testid="link-control-loop-prints"
              className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
            >
              <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  Attach sliced plate data <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Turn each Chitubox CTB plate into time, resin, cost, and exposure totals on the right Print Order.
                </span>
              </span>
            </Link>
            <Link
              href="/supplies"
              data-testid="link-control-loop-supplies"
              className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
            >
              <ShoppingBag className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  Log supply purchases <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Copy Amazon receipt totals into a clean materials, consumables, and packaging ledger.
                </span>
              </span>
            </Link>
            <Link
              href="/performance"
              data-testid="link-control-loop-performance"
              className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
            >
              <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  Review performance <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  See pipeline workload, recent revenue, margins, supply spend, and orders that need attention.
                </span>
              </span>
            </Link>
            <Link
              href="/operations"
              data-testid="link-control-loop-operations"
              className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
            >
              <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  Profit automation <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  Confirm webhook health when HubSpot cost fields change.
                </span>
              </span>
            </Link>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
          <SystemStatus health={health.data} />

          <section
            className="rounded-lg border border-card-border bg-card p-5"
            aria-labelledby="tools-title"
            data-testid="panel-business-tools"
          >
            <p className="rule-label">Business tools</p>
            <h2 id="tools-title" className="mt-1 text-base font-semibold tracking-tight">
              Open the systems you use
            </h2>
            <div className="mt-4 space-y-2">
              <a
                href={HUBSPOT_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-command-center-hubspot"
                className="flex items-center justify-between rounded-md border border-border px-3 py-3 text-sm transition-colors hover:bg-muted/60"
              >
                <span className="flex items-center gap-2.5">
                  <Store className="h-4 w-4 text-primary" />
                  <span>
                    <span className="block font-medium">HubSpot CRM</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Orders, customers, costs, and pipeline</span>
                  </span>
                </span>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>
              <a
                href={PIRATE_SHIP_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-command-center-pirateship"
                className="flex items-center justify-between rounded-md border border-border px-3 py-3 text-sm transition-colors hover:bg-muted/60"
              >
                <span className="flex items-center gap-2.5">
                  <ShipWheel className="h-4 w-4 text-primary" />
                  <span>
                    <span className="block font-medium">Pirate Ship</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Shipping labels and actual postage</span>
                  </span>
                </span>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}
