import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Clock3,
  FileUp,
  Layers3,
  Loader2,
  Package,
  PackageCheck,
  RefreshCw,
  Ship,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { printsDealHref, queueDealHref, readHashQueryParam } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsPanel } from "@/components/deal-ops-panel";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProductionQueueItem, ProductionQueueResponse } from "@shared/schema";

type QueueResponse = ProductionQueueResponse & { ok: true };

function hoursLabel(seconds: number | null): string {
  if (seconds == null || !(seconds > 0)) return "—";
  const hours = seconds / 3_600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
}

function QueueCard({
  item,
  selected,
  onSelect,
}: {
  item: ProductionQueueItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`button-queue-deal-${item.dealId}`}
      className={cn(
        "w-full rounded-md border p-2.5 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-muted/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">{item.dealName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.stage}
            {item.contactName ? ` · ${item.contactName}` : ""}
          </p>
        </div>
        <p className="text-sm font-medium">{formatMoney(item.amount)}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.requiresPlates && !item.hasPlates ? (
          <StatusPill tone="warn" icon={FileUp} label="Needs plates" />
        ) : null}
        {!item.requiresPlates ? <StatusPill tone="neutral" icon={Package} label="No plates" /> : null}
        {item.plateCount > 0 ? (
          <StatusPill tone="neutral" icon={Clock3} label={`${item.plateCount} plate · ${hoursLabel(item.totalPrintTimeSeconds)}`} />
        ) : null}
        {item.assignedPrinterNames.length > 0 ? (
          <StatusPill tone="good" icon={PackageCheck} label={item.assignedPrinterNames.join(", ")} />
        ) : null}
        {item.unassignedPlateCount > 0 ? (
          <StatusPill tone="warn" icon={AlertTriangle} label={`${item.unassignedPlateCount} unassigned`} />
        ) : null}
        {item.kitReprint > 0 || item.kitNeeded > 0 ? (
          <StatusPill
            tone="warn"
            icon={Layers3}
            label={`Kit ${item.kitNeeded} needed${item.kitReprint ? ` · ${item.kitReprint} reprint` : ""}`}
          />
        ) : null}
        <StatusPill
          tone={item.fulfillment.shipReady ? "good" : "neutral"}
          icon={Ship}
          label={`Ship ${item.fulfillment.readyPercent}%`}
        />
      </div>
      {item.requiresPlates ? (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <Link href={printsDealHref(item.dealId)} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            Plates
          </Link>
        </div>
      ) : null}
    </button>
  );
}

function QueueColumn({
  title,
  subtitle,
  items,
  selectedId,
  onSelect,
  empty,
  testId,
}: {
  title: string;
  subtitle: string;
  items: ProductionQueueItem[];
  selectedId: string | null;
  onSelect: (dealId: string) => void;
  empty: string;
  testId: string;
}) {
  return (
    <section className="min-w-0" data-testid={testId}>
      <div className="mb-3">
        <h2 className="text-sm font-semibold tracking-tight">
          {title}{" "}
          <span className="text-muted-foreground">({items.length})</span>
        </h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <QueueCard
              key={item.dealId}
              item={item}
              selected={selectedId === item.dealId}
              onSelect={() => onSelect(item.dealId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function ProductionQueuePage() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Production queue unlocked",
    successDescription: "Next print, in-production jobs, and ship-ready checklists.",
  });
  const [selectedDealId, setSelectedDealId] = useState<string | null>(() => readHashQueryParam("dealId"));

  const queue = useQuery<QueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return (await response.json()) as QueueResponse;
    },
  });

  const data = queue.data;

  const selectedExists = useMemo(() => {
    if (!data || !selectedDealId) return false;
    return [...data.nextPrint, ...data.inProduction, ...data.shipReady, ...data.blocked].some(
      (item) => item.dealId === selectedDealId,
    );
  }, [data, selectedDealId]);

  return (
    <div className="mx-auto flex max-w-[100rem] flex-col">
      <PageHeader
        title="Queue"
        subtitle="Next print · in production · ship-ready. Select a deal for costs, stage, and packing."
        actions={
          isUnlocked ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => queue.refetch()}
              disabled={queue.isFetching}
              data-testid="button-refresh-queue"
            >
              {queue.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          ) : null
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the production queue"
            description="Same owner code as Daily Work. Live HubSpot orders plus local plates, kits, and ship checklists."
            buttonLabel="Unlock Queue"
            testIdPrefix="queue"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : queue.isLoading ? (
          <div className="grid gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : queue.isError || !data ? (
          <Panel title="Queue could not be loaded">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {(queue.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Check HubSpot connectivity."}
              </p>
            </div>
          </Panel>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label="Open orders" value={String(data.summary.openOrders)} hint="Active HubSpot deals" icon={PackageCheck} />
              <StatCard label="Next print" value={String(data.summary.nextPrint)} hint="Needs plates" icon={FileUp} />
              <StatCard label="In production" value={String(data.summary.inProduction)} hint="Plates attached" icon={Clock3} />
              <StatCard label="Blocked" value={String(data.summary.blocked)} hint="QC / unassigned" icon={AlertTriangle} tone="warn" />
              <StatCard label="Ship-ready" value={String(data.summary.shipReady)} hint="Checklist progressing" icon={Ship} tone="good" />
            </div>

            {selectedDealId ? (
              <DealOpsPanel
                dealId={selectedDealId}
                headers={headers}
                onClose={() => setSelectedDealId(null)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Select an order to enter costs, advance stage, assign printers, run the ship checklist, or print a packing slip.
                {selectedExists ? "" : ""}
              </p>
            )}

            <div className="grid gap-6 xl:grid-cols-4 lg:grid-cols-2">
              <QueueColumn
                title="Next print"
                subtitle="Open orders still missing plate data"
                items={data.nextPrint}
                selectedId={selectedDealId}
                onSelect={setSelectedDealId}
                empty="All open orders already have plates."
                testId="column-next-print"
              />
              <QueueColumn
                title="In production"
                subtitle="Plates on, progressing toward ship"
                items={data.inProduction}
                selectedId={selectedDealId}
                onSelect={setSelectedDealId}
                empty="Nothing mid-flight right now."
                testId="column-in-production"
              />
              <QueueColumn
                title="Blocked"
                subtitle="Needs kit QC or printer assignment"
                items={data.blocked}
                selectedId={selectedDealId}
                onSelect={setSelectedDealId}
                empty="No QC or assignment blockers."
                testId="column-blocked"
              />
              <QueueColumn
                title="Ship ready"
                subtitle="Checklist mostly done — buy label & pack"
                items={data.shipReady}
                selectedId={selectedDealId}
                onSelect={setSelectedDealId}
                empty="No orders near ship-ready yet."
                testId="column-ship-ready"
              />
            </div>

            {data.recentFailures.length > 0 ? (
              <Panel title="Recent failures / reprints">
                <ul className="space-y-2 text-sm">
                  {data.recentFailures.map((failure) => (
                    <li key={failure.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 last:border-0">
                      <button
                        type="button"
                        className="text-left font-medium text-primary hover:underline"
                        onClick={() => setSelectedDealId(failure.dealId)}
                      >
                        {failure.dealName}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {failure.failureType.replaceAll("_", " ")} · {new Date(failure.occurredAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <p className="text-xs text-muted-foreground">
              Deep-link any deal with{" "}
              <code className="rounded bg-muted px-1 py-0.5">{queueDealHref("DEAL_ID")}</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
