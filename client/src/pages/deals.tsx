import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Calendar,
  CircleDollarSign,
  ExternalLink,
  FileUp,
  Loader2,
  Package,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { hubspotDealHref, hubspotDealsListHref, labelsDealHref, printsDealHref, queueDealHref } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsDrawer } from "@/components/deal-ops-panel";
import {
  OrderPartsDialog,
  formatPartsBadge,
  type OrderPartSummary,
} from "@/components/order-parts-dialog";
import { Panel } from "@/components/primitives";
import { formatMoney, formatLocalDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";

type BoardDeal = PerformanceResponse["activeDeals"][number] & {
  needsCosts: boolean;
  needsPlates: boolean;
  alerts: PerformanceResponse["attention"];
};

type BoardColumn = PerformanceResponse["pipeline"][number] & {
  deals: BoardDeal[];
  totalAmount: number;
};

type OptimisticMove = { stageId: string; stageLabel: string };

const DRAG_MIME = "application/x-print-ops-deal";

/**
 * Orders board — HubSpot Print Orders stages with drag-to-move write-back.
 * Day-to-day production still lives on Queue; this mirrors CRM stages both ways.
 */
export default function DealsPage() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Orders unlocked",
    successDescription: "Live HubSpot stages and open print jobs, without leaving Print Operations.",
  });
  const [showClosedStages, setShowClosedStages] = useState(false);
  const [showEmptyStages, setShowEmptyStages] = useState(false);
  const [opsDealId, setOpsDealId] = useState<string | null>(null);
  const [partsDeal, setPartsDeal] = useState<{ dealId: string; dealName: string } | null>(null);
  const [optimisticMoves, setOptimisticMoves] = useState<Record<string, OptimisticMove>>({});
  const [draggingDealId, setDraggingDealId] = useState<string | null>(null);
  const [dropStageId, setDropStageId] = useState<string | null>(null);

  const performance = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/performance", undefined, { headers });
      return (await response.json()) as PerformanceResponse;
    },
  });

  const partSummaries = useQuery<{ ok: true; summaries: OrderPartSummary[] }>({
    queryKey: ["/api/order-parts/summaries", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/order-parts/summaries", undefined, { headers });
      return (await response.json()) as { ok: true; summaries: OrderPartSummary[] };
    },
  });

  const moveStage = useMutation({
    mutationFn: async (input: { dealId: string; stageId: string; stageLabel: string; dealName: string }) => {
      const response = await apiRequest(
        "POST",
        `/api/deal-ops/${encodeURIComponent(input.dealId)}/stage`,
        { stageId: input.stageId, liveWrite: true },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        dryRun?: boolean;
        stageId: string;
        stageLabel: string;
        gate?: string;
      };
    },
    onMutate: (input) => {
      setOptimisticMoves((prev) => ({
        ...prev,
        [input.dealId]: { stageId: input.stageId, stageLabel: input.stageLabel },
      }));
    },
    onSuccess: (data, input) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      if (data.dryRun) {
        setOptimisticMoves((prev) => {
          const next = { ...prev };
          delete next[input.dealId];
          return next;
        });
        toast({
          title: "Dry-run only — HubSpot not updated",
          description: `${input.dealName} stayed put. Enable live HubSpot writes to move stages.`,
          variant: "destructive",
        });
        return;
      }
      toast({
        title: `Moved to ${data.stageLabel || input.stageLabel}`,
        description: `${input.dealName} updated in HubSpot.`,
      });
    },
    onError: (error: Error, input) => {
      setOptimisticMoves((prev) => {
        const next = { ...prev };
        delete next[input.dealId];
        return next;
      });
      toast({
        title: "Could not move that order",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  // Drop optimistic overrides once the server snapshot catches up.
  useEffect(() => {
    const snapshot = performance.data;
    if (!snapshot || Object.keys(optimisticMoves).length === 0) return;
    const all = [...snapshot.activeDeals, ...(snapshot.closedDeals ?? [])];
    setOptimisticMoves((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [dealId, move] of Object.entries(prev)) {
        const deal = all.find((row) => row.dealId === dealId);
        if (deal && (deal.stageId === move.stageId || deal.stage === move.stageLabel)) {
          delete next[dealId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [performance.data, optimisticMoves]);

  const summaryByDeal = useMemo(() => {
    const map = new Map<string, OrderPartSummary>();
    for (const row of partSummaries.data?.summaries ?? []) {
      map.set(row.hubspotDealId, row);
    }
    return map;
  }, [partSummaries.data?.summaries]);

  const snapshot = performance.data;
  const portalId = snapshot?.hubspotPortalId ?? null;

  const { columns, openValue, closedColumnCount, emptyColumnCount } = useMemo(() => {
    if (!snapshot) {
      return { columns: [] as BoardColumn[], openValue: 0, closedColumnCount: 0, emptyColumnCount: 0 };
    }

    const alertsByDeal = new Map<string, PerformanceResponse["attention"]>();
    for (const item of snapshot.attention) {
      const list = alertsByDeal.get(item.dealId) ?? [];
      list.push(item);
      alertsByDeal.set(item.dealId, list);
    }

    const byStage = new Map<string, BoardDeal[]>();
    let openValue = 0;
    const closedIds = new Set((snapshot.closedDeals ?? []).map((deal) => deal.dealId));
    const boardSource = showClosedStages
      ? [...snapshot.activeDeals, ...(snapshot.closedDeals ?? [])]
      : snapshot.activeDeals;
    for (const deal of boardSource) {
      // Shipping / fee HubSpot deals are charges, not print jobs — keep them off the board.
      if (!deal.requiresPlates) continue;
      if (!closedIds.has(deal.dealId)) openValue += deal.amount;
      const alerts = alertsByDeal.get(deal.dealId) ?? [];
      const optimistic = optimisticMoves[deal.dealId];
      const stageId = optimistic?.stageId || deal.stageId || deal.stage;
      const stage = optimistic?.stageLabel || deal.stage;
      const list = byStage.get(stageId) ?? [];
      list.push({
        ...deal,
        stageId,
        stage,
        needsCosts: alerts.some((item) => item.issueKey === "costs_incomplete"),
        needsPlates: deal.promptAttachPlates,
        alerts,
      });
      byStage.set(stageId, list);
    }

    const allColumns: BoardColumn[] = snapshot.pipeline.map((stage) => {
      const deals = byStage.get(stage.id) ?? [];
      const totalAmount = deals.reduce((sum, deal) => sum + deal.amount, 0);
      return { ...stage, deals, totalAmount };
    });

    const closedColumnCount = allColumns.filter((column) => column.closed).length;
    const visible = showClosedStages ? allColumns : allColumns.filter((column) => !column.closed);
    const emptyColumnCount = visible.filter((column) => column.deals.length === 0).length;
    // Keep empty drop targets visible while dragging so you can land on an empty stage.
    const columns =
      showEmptyStages || draggingDealId
        ? visible
        : visible.filter((column) => column.deals.length > 0);

    return { columns, openValue, closedColumnCount, emptyColumnCount };
  }, [snapshot, showClosedStages, showEmptyStages, optimisticMoves, draggingDealId]);

  const requestMove = (deal: BoardDeal, column: BoardColumn) => {
    const currentId = deal.stageId || deal.stage;
    if (currentId === column.id || moveStage.isPending) return;
    if (column.closed) {
      const ok = window.confirm(
        `Move “${deal.dealName}” to ${column.label}?\n\nThat is a closed HubSpot stage (completed/lost).`,
      );
      if (!ok) return;
    }
    moveStage.mutate({
      dealId: deal.dealId,
      stageId: column.id,
      stageLabel: column.label,
      dealName: deal.dealName,
    });
  };

  const boardReady = isUnlocked && !performance.isLoading && !performance.isError && Boolean(snapshot);

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-[100rem] flex-col overflow-hidden">
      <PageHeader
        title="Orders"
        subtitle="Drag cards between stages to update HubSpot. Print jobs only — day-to-day work still lives on Queue."
        actions={
          <>
            {isUnlocked ? (
              <>
                <Button asChild size="sm" variant="ghost" data-testid="button-open-hubspot-deals">
                  <a href={hubspotDealsListHref(portalId)} target="_blank" rel="noopener noreferrer">
                    HubSpot
                    <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => performance.refetch()}
                  disabled={performance.isFetching}
                  data-testid="button-refresh-deals"
                >
                  {performance.isFetching ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  )}
                  Refresh
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          boardReady ? "px-4 pb-4 pt-3 md:px-6" : "page-stack overflow-y-auto",
        )}
      >
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the Orders board"
            description="Same owner code as Daily Work. Live HubSpot stages and open print jobs, without leaving Print Operations."
            buttonLabel="Unlock Orders"
            testIdPrefix="deals"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <BoardSkeleton />
        ) : performance.isError || !snapshot ? (
          <Panel title="Orders could not be loaded" testId="panel-deals-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Check the HubSpot connection, then refresh.
                </p>
                <Button className="mt-4" size="sm" onClick={() => performance.refetch()} data-testid="button-retry-deals">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <section
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-card-border bg-card"
            data-testid="panel-deals-board"
            aria-label="Print Orders pipeline board"
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 md:px-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-tight">Print Orders</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Drag a card onto a stage · HubSpot updates live · Ops still handles costs
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  aria-label="Orders summary"
                  data-testid="panel-deals-summary"
                >
                  <span
                    className="rounded border border-border bg-muted/60 px-2 py-1 text-xs tabular-nums text-muted-foreground"
                    data-testid="metric-orders-open"
                  >
                    <span className="font-semibold text-foreground">{snapshot.summary.activeOrders}</span> open
                  </span>
                  <span
                    className="rounded border border-border bg-muted/60 px-2 py-1 text-xs tabular-nums text-muted-foreground"
                    data-testid="metric-orders-value"
                  >
                    <span className="font-semibold text-foreground numeric">{formatMoney(openValue)}</span>
                  </span>
                  <span
                    className={cn(
                      "rounded border px-2 py-1 text-xs tabular-nums",
                      snapshot.summary.attentionCount > 0
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-muted/60 text-muted-foreground",
                    )}
                    data-testid="metric-orders-alerts"
                  >
                    <span className="font-semibold">{snapshot.summary.attentionCount}</span> attention
                  </span>
                </div>
                {emptyColumnCount > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    onClick={() => setShowEmptyStages((value) => !value)}
                    data-testid="button-toggle-empty-stages"
                  >
                    {showEmptyStages ? "Hide empty stages" : `Show empty (${emptyColumnCount})`}
                  </Button>
                ) : null}
                {closedColumnCount > 0 || (snapshot.closedDeals?.length ?? 0) > 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs"
                    onClick={() => setShowClosedStages((value) => !value)}
                    data-testid="button-toggle-closed-stages"
                  >
                    {showClosedStages ? "Hide completed & lost" : "Show completed & lost"}
                  </Button>
                ) : null}
              </div>
            </div>

            {snapshot.summary.activeOrders === 0 ? (
              <p className="shrink-0 border-b border-border px-4 py-2.5 text-sm text-muted-foreground" data-testid="empty-deals">
                No open Print Orders right now.{" "}
                <Link href="/orders" className="hs-link font-medium" data-testid="link-deals-to-intake">
                  Start one in Paid Order Intake
                </Link>
              </p>
            ) : null}

            <div className="min-h-0 flex-1 overflow-x-auto overscroll-contain bg-muted/40 p-3 md:p-4">
              {columns.length === 0 ? (
                <div className="flex h-full min-h-[12rem] items-center justify-center rounded-md border border-dashed border-border bg-card/40 px-4">
                  <p className="text-center text-sm text-muted-foreground">
                    {emptyColumnCount > 0
                      ? "All visible stages are empty — show empty stages to see the full pipeline."
                      : "No stages to show for this pipeline view."}
                  </p>
                </div>
              ) : (
                <div className="flex h-full min-w-full items-stretch gap-3">
                  {columns.map((column) => (
                    <div
                      key={column.id}
                      className={cn(
                        "queue-lane flex h-full min-h-0 min-w-[15.5rem] flex-1 flex-col transition-colors",
                        dropStageId === column.id && "ring-2 ring-primary/50 ring-offset-1 ring-offset-background",
                      )}
                      data-testid={`column-deal-stage-${column.id}`}
                      onDragOver={(event) => {
                        if (!draggingDealId) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropStageId(column.id);
                      }}
                      onDragLeave={() => {
                        setDropStageId((current) => (current === column.id ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDropStageId(null);
                        setDraggingDealId(null);
                        const raw =
                          event.dataTransfer.getData(DRAG_MIME) ||
                          event.dataTransfer.getData("text/plain");
                        if (!raw) return;
                        let payload: { dealId: string } | null = null;
                        try {
                          payload = JSON.parse(raw) as { dealId: string };
                        } catch {
                          payload = { dealId: raw };
                        }
                        const dealId = String(payload?.dealId ?? "").trim();
                        if (!dealId) return;
                        const deal = columns.flatMap((col) => col.deals).find((row) => row.dealId === dealId);
                        if (!deal) return;
                        requestMove(deal, column);
                      }}
                    >
                      <div
                        className={cn(
                          "queue-lane-header",
                          column.closed && /lost/i.test(column.label) && "bg-destructive/10",
                          column.closed && !/lost/i.test(column.label) && "bg-chart-4/10",
                        )}
                      >
                        <div className="flex w-full items-start justify-between gap-2">
                          <p
                            className={cn(
                              "min-w-0 truncate text-sm font-semibold text-foreground",
                              column.closed && /lost/i.test(column.label) && "text-destructive",
                              column.closed && !/lost/i.test(column.label) && "text-chart-4",
                            )}
                          >
                            {column.label}
                          </p>
                          <span className="numeric shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-muted-foreground">
                            {column.deals.length}
                          </span>
                        </div>
                        {column.totalAmount > 0 ? (
                          <p className="mt-1 text-[0.6875rem] text-muted-foreground numeric">
                            {formatMoney(column.totalAmount)}
                          </p>
                        ) : null}
                      </div>

                      <div className="queue-lane-body overflow-y-auto overscroll-contain">
                        {column.deals.length === 0 ? (
                          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-2 py-6">
                            <p className="text-center text-xs text-muted-foreground">
                              {draggingDealId ? "Drop here" : "No orders"}
                            </p>
                          </div>
                        ) : (
                          column.deals.map((deal) => (
                            <DealCard
                              key={deal.dealId}
                              deal={deal}
                              portalId={portalId}
                              partsSummary={summaryByDeal.get(deal.dealId) ?? null}
                              dragging={draggingDealId === deal.dealId}
                              moving={moveStage.isPending && moveStage.variables?.dealId === deal.dealId}
                              onOpenOps={() => setOpsDealId(deal.dealId)}
                              onOpenParts={() =>
                                setPartsDeal({ dealId: deal.dealId, dealName: deal.dealName })
                              }
                              onDragStart={() => setDraggingDealId(deal.dealId)}
                              onDragEnd={() => {
                                setDraggingDealId(null);
                                setDropStageId(null);
                              }}
                            />
                          ))
                        )}
                      </div>

                      <div className="shrink-0 border-t border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <span>Total</span>
                          <span className="numeric font-semibold text-foreground">{formatMoney(column.totalAmount)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      <DealOpsDrawer dealId={opsDealId} headers={headers} onClose={() => setOpsDealId(null)} />

      <OrderPartsDialog
        dealId={partsDeal?.dealId ?? null}
        dealName={partsDeal?.dealName ?? ""}
        open={Boolean(partsDeal)}
        onOpenChange={(next) => {
          if (!next) setPartsDeal(null);
        }}
        headers={headers}
      />
    </div>
  );
}

function DealCard({
  deal,
  portalId,
  partsSummary,
  dragging,
  moving,
  onOpenOps,
  onOpenParts,
  onDragStart,
  onDragEnd,
}: {
  deal: BoardDeal;
  portalId: string | null;
  partsSummary: OrderPartSummary | null;
  dragging: boolean;
  moving: boolean;
  onOpenOps: () => void;
  onOpenParts: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const closeLabel = formatLocalDate(deal.closeDate);
  const href = hubspotDealHref(deal.dealId, portalId);
  const isStale = deal.alerts.some((item) => item.issueKey === "stale");
  const tone = isStale
    ? "bad"
    : deal.needsPlates
      ? "plates"
      : deal.needsCosts
        ? "warn"
        : "good";

  return (
    <article
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ dealId: deal.dealId }));
        event.dataTransfer.setData("text/plain", deal.dealId);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        "workspace-node group shrink-0 cursor-grab p-2.5 active:cursor-grabbing",
        dragging && "opacity-60",
        moving && "pointer-events-none opacity-70",
      )}
      data-tone={tone}
      data-testid={`card-deal-${deal.dealId}`}
      title="Drag to another stage to update HubSpot"
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="hs-link block text-sm font-semibold leading-snug"
        data-testid={`link-deal-title-${deal.dealId}`}
      >
        {deal.dealName}
      </a>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-semibold text-foreground numeric">
          <CircleDollarSign className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {formatMoney(deal.amount)}
        </span>
        {deal.contactName ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 truncate">
            <UserRound className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className="truncate">{deal.contactName}</span>
          </span>
        ) : null}
        {closeLabel ? (
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5 shrink-0 opacity-70" />
            {closeLabel}
          </span>
        ) : null}
      </div>

      {(deal.needsPlates || deal.needsCosts || isStale || partsSummary) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {deal.needsPlates ? (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary">
              Needs plates
            </span>
          ) : null}
          {deal.needsCosts ? (
            <span className="rounded border border-chart-4/35 bg-chart-4/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-chart-4">
              Needs costs
            </span>
          ) : null}
          {isStale ? (
            <span className="rounded border border-destructive/35 bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-destructive">
              Stale
            </span>
          ) : null}
          {partsSummary && partsSummary.total > 0 ? (
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide",
                partsSummary.remaining === 0
                  ? "border-chart-4/30 bg-chart-4/10 text-chart-4"
                  : "border-border bg-muted text-muted-foreground",
              )}
              data-testid={`badge-deal-parts-${deal.dealId}`}
            >
              {formatPartsBadge(partsSummary)}
            </span>
          ) : null}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-1.5">
        <button
          type="button"
          onClick={onOpenOps}
          className="hs-link inline-flex items-center gap-1 text-xs font-medium"
          data-testid={`button-deal-ops-${deal.dealId}`}
        >
          Ops / stage
        </button>
        <button
          type="button"
          onClick={onOpenParts}
          className="hs-link inline-flex items-center gap-1 text-xs font-medium"
          data-testid={`button-deal-parts-${deal.dealId}`}
        >
          <Package className="h-3 w-3" />
          Parts
        </button>
        {deal.needsPlates ? (
          <Link
            href={printsDealHref(deal.dealId)}
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-attach-${deal.dealId}`}
          >
            <FileUp className="h-3 w-3" />
            Attach plates
          </Link>
        ) : null}
        {deal.needsCosts ? (
          <Link
            href={queueDealHref(deal.dealId)}
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-costs-${deal.dealId}`}
          >
            Enter costs
          </Link>
        ) : null}
        {!deal.needsPlates ? (
          <Link
            href={labelsDealHref(deal.dealId)}
            className="hs-link inline-flex items-center gap-1 text-xs font-medium"
            data-testid={`link-deal-labels-${deal.dealId}`}
          >
            Labels
          </Link>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
          data-testid={`link-deal-hubspot-${deal.dealId}`}
        >
          HubSpot
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </article>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="skeleton-deals">
      <Skeleton className="h-10 w-full shrink-0 rounded-md" />
      <Skeleton className="min-h-0 flex-1 rounded-lg" />
    </div>
  );
}
