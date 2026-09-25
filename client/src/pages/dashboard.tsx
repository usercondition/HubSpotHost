import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ListChecks, ListOrdered, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FloorBoard } from "@/components/floor-board";
import { HubspotSyncChip } from "@/components/hubspot-sync-chip";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import type { StackView } from "@/components/priority-stack-list";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { buildFloorNeeds, fepDuePrinters } from "@/lib/floor-needs";
import { floorGreeting, pacificDayLabel } from "@/lib/stage-chip";
import { shipByCalendarDate } from "@shared/ship-by";
import type {
  HealthResponse,
  PerformanceResponse,
  PrinterFleetSnapshot,
  ProductionQueueResponse,
  ResinReorderResponse,
} from "@shared/schema";

type QueueResponse = ProductionQueueResponse & { ok: true };


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

  const stack = useQuery<StackView>({
    queryKey: ["/api/priority-stack", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/priority-stack", undefined, { headers });
      return (await response.json()) as StackView;
    },
  });

  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

  if (!isUnlocked) {
    return (
      <div className="space-y-4">
        <HubspotSyncChip />
        <OwnerUnlockPanel
          title="Unlock the floor"
          description="See what needs plates, costs, or review — then jump into Queue."
          buttonLabel="Unlock the floor"
          testIdPrefix="dashboard"
          pending={unlockMutation.isPending}
          onUnlock={(code) => unlockMutation.mutate(code)}
        />
      </div>
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
  const today = shipByCalendarDate();
  const pendingReview = snapshot.intake.pendingReview;
  const awaitingClient = snapshot.intake.awaitingClient;
  const buyNow = resinReorder.data?.buyNow ?? [];
  const fepDue = fepDuePrinters(printers.data?.printers ?? []);

  const floorNeeds = buildFloorNeeds({
    today,
    portalId,
    attention,
    deals: snapshot.activeDeals ?? [],
    queue: queueItems,
    pendingReview,
    awaitingClient,
    resinBuyNow: buyNow,
    fepDue,
  });

  const plateSeconds = (productionQueue.data?.inProduction ?? []).reduce(
    (sum, item) => sum + (item.totalPrintTimeSeconds ?? 0),
    0,
  );
  const suggestions = resinReorder.data?.suggestions ?? [];
  const resin = suggestions.find((item) => item.urgency === "ok") ?? suggestions[0] ?? null;

  return (
    <FloorBoard
      needs={floorNeeds}
      today={today}
      stack={stack.data}
      inProduction={productionQueue.data?.summary.inProduction ?? 0}
      waitingToPrint={productionQueue.data?.summary.nextPrint ?? 0}
      plateHours={Math.round(plateSeconds / 3600)}
      printers={(printers.data?.printers ?? []).filter((printer) => printer.status === "active")}
      resin={resin}
      intakeWaiting={pendingReview}
      buyerLinks={awaitingClient}
      replies={productionQueue.data?.summary.needsReply ?? 0}
      syncIssues={health.data?.hubspotSync?.issueCount ?? 0}
      onCopyChase={async (draft) => {
        try {
          await navigator.clipboard.writeText(draft);
          toast({ title: "Chase draft copied", description: "Paste into Messenger or email — nothing was sent." });
        } catch {
          toast({ title: "Could not copy", description: draft.slice(0, 120), variant: "destructive" });
        }
      }}
    />
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
    <div className="mx-auto flex w-full max-w-[1208px] flex-col" data-testid="page-floor">
      <PageHeader
        title={floorGreeting()}
        subtitle={`What needs you right now · ${pacificDayLabel()}`}
        hideActionsOnPhone
        actions={
          <>
            <SystemStatusPill health={health.data} />
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link href="/stack">
                <ListChecks className="h-3.5 w-3.5" />
                Open Stack
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-8" data-testid="link-floor-open-queue">
              <Link href="/queue">
                <ListOrdered className="h-3.5 w-3.5" />
                Queue
              </Link>
            </Button>
          </>
        }
      />

      <div className="page-stack">
        <TodaysWork />
      </div>
    </div>
  );
}
