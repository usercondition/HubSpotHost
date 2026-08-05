import { useMutation, useQuery } from "@tanstack/react-query";
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
  ShoppingBag,
  ShipWheel,
  SlidersHorizontal,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { hubspotDealHref, hubspotDealsListHref, printsDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession } from "@/hooks/use-owner-session";
import { TrackerAssistantPanel } from "@/components/tracker-assistant";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import type { HealthResponse, PerformanceResponse } from "@shared/schema";

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

function DailyPathLink({
  href,
  title,
  body,
  icon: Icon,
  testId,
}: {
  href: string;
  title: string;
  body: string;
  icon: LucideIcon;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="group flex items-start gap-3 rounded-md px-3 py-3 transition-colors hover:bg-muted/55"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span>
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {title}
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{body}</span>
      </span>
    </Link>
  );
}

function TodaysWork() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers, unlock } = useOwnerSession();

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const unlockMutation = useMutation({
    mutationFn: async (code: string) => {
      await apiRequest("GET", "/api/performance", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return code;
    },
    onSuccess: (code) => {
      unlock(code);
      toast({ title: "Daily work unlocked", description: "Order links, Print files, Supplies, and Performance share this session." });
    },
    onError: (error: Error) => {
      toast({
        title: "That owner code was not accepted",
        description: error.message.startsWith("401")
          ? "Check the code and try again."
          : "Could not reach the performance service.",
        variant: "destructive",
      });
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
            <p className="text-xs text-muted-foreground numeric">
              {snapshot.summary.activeOrders} open
              {snapshot.summary.activeOrders > activeDeals.length
                ? ` · showing ${activeDeals.length}`
                : ""}
            </p>
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
                    {deal.amount > 0 ? ` · ${money(deal.amount)}` : ""}
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
  const { isUnlocked, lock, ownerCode } = useOwnerSession();

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Command center"
        subtitle="Run paid orders from buyer details to shipping without losing the thread."
        actions={
          <>
            {isUnlocked ? (
              <Button size="sm" variant="ghost" onClick={lock} data-testid="button-lock-owner-session">
                <Unlock className="mr-2 h-3.5 w-3.5" />
                Lock session
              </Button>
            ) : null}
            <ThemeToggle />
          </>
        }
      />

      <div className="page-stack">
        <TodaysWork />
        {isUnlocked ? <TrackerAssistantPanel headers={{ "x-paid-order-access-code": ownerCode }} /> : null}

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

        <section
          className="overflow-hidden rounded-lg border border-card-border bg-card"
          aria-labelledby="daily-path-title"
          data-testid="panel-daily-workflow"
        >
          <div className="border-b border-border px-5 py-4">
            <p className="rule-label">Daily path</p>
            <h2 id="daily-path-title" className="mt-1 text-base font-semibold tracking-tight">
              One sale, one clear path
            </h2>
          </div>
          <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
            <DailyPathLink
              href="/orders"
              title="Collect buyer details"
              body="Create the secure intake link once payment is received."
              icon={Link2}
              testId="link-workflow-01"
            />
            <DailyPathLink
              href="/prints"
              title="Attach production plates"
              body="Drop each Chitubox plate so time and resin estimates land on the deal."
              icon={FileUp}
              testId="link-workflow-02"
            />
            <DailyPathLink
              href="/supplies"
              title="Log supply purchases"
              body="Receipt totals for resin, consumables, and packaging stay off the HubSpot deal."
              icon={ShoppingBag}
              testId="link-control-loop-supplies"
            />
            <DailyPathLink
              href="/operations"
              title="Record shipping cost"
              body="Buy the Pirate Ship label, then enter actual postage on the HubSpot deal."
              icon={ShipWheel}
              testId="link-workflow-03"
            />
          </div>
        </section>

        <SystemStatus health={health.data} />
      </div>
    </div>
  );
}
