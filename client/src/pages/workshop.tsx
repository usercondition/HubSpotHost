import { Component, lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReducedMotion } from "framer-motion";
import { useTheme } from "@/components/shell";
import { useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import { readHashQueryParam, stripDealIdFromLocation } from "@/lib/workflow";
import { detectWebGL } from "@/lib/workshop-webgl";
import { emptyWorkshopQueue, sampleWorkshopQueue } from "@/lib/workshop-sample";
import { writeWorkspaceView } from "@/lib/workspace-view";
import { workshopIntegrationTags } from "@/lib/workshop-integrations";
import {
  collectWorkshopOrders,
  countDueThisWeek,
  groupOrdersByStation,
  printerStatusLabel,
  printersAreRunning,
  WORKSHOP_STATIONS,
} from "@/lib/workshop-stations";
import { WorkshopFallback } from "@/components/workshop/workshop-fallback";
import { WorkshopOrderPanel } from "@/components/workshop/workshop-panel";
import { isDarkTheme } from "@/lib/theme";
import { shipByCalendarDate } from "@shared/ship-by";
import type { HealthResponse, ProductionQueueResponse } from "@shared/schema";
import type { WorkshopHover } from "@/lib/workshop-types";

const WorkshopCanvas = lazy(() => import("@/components/workshop/workshop-canvas"));

type QueueResponse = ProductionQueueResponse & { ok?: true };
type DriveStatus = { configured?: boolean; connected?: boolean; reconnect?: boolean };

function replaceWorkshopHash(dealId: string | null, sample: boolean) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  if (dealId) params.set("dealId", dealId);
  if (sample) params.set("sample", "1");
  const query = params.toString();
  const nextHash = query ? `#/workshop?${query}` : "#/workshop";
  const next = `${window.location.pathname}${window.location.search}${nextHash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (current !== next) window.history.replaceState(null, "", next);
}

class CanvasErrorBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFail();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export default function WorkshopPage() {
  const { ownerCode, isUnlocked, headers, codeDraft, setCodeDraft } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Workshop unlocked",
    successDescription: "Live orders on the shop floor. This view does not write to HubSpot.",
  });
  const { theme } = useTheme();
  const reduceMotion = useReducedMotion() === true;
  const [webgl, setWebgl] = useState(true);
  const [webglFailed, setWebglFailed] = useState(false);
  const [sample, setSample] = useState(() => readHashQueryParam("sample") === "1");
  const [selectedDealId, setSelectedDealId] = useState<string | null>(() => readHashQueryParam("dealId"));
  const [hover, setHover] = useState<WorkshopHover | null>(null);

  useEffect(() => {
    setWebgl(detectWebGL());
    stripDealIdFromLocation();
    writeWorkspaceView("workshop");
  }, []);

  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

  const queue = useQuery<QueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked && !sample,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return (await response.json()) as QueueResponse;
    },
  });

  const drive = useQuery<DriveStatus>({
    queryKey: ["/api/google/drive", ownerCode],
    enabled: isUnlocked && !sample,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/google/drive", undefined, { headers });
      return (await response.json()) as DriveStatus;
    },
  });

  const library = useQuery<{ total: number }>({
    queryKey: ["/api/plate-files", "count", ownerCode],
    enabled: isUnlocked && !sample,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/plate-files?summary=1", undefined, { headers });
      const body = (await response.json()) as { total?: number; files?: unknown[] };
      const total = typeof body.total === "number" ? body.total : Array.isArray(body.files) ? body.files.length : 0;
      return { total };
    },
  });

  const liveQueue = queue.data ?? null;
  const usingSample = sample || !isUnlocked;
  const displayQueue = usingSample ? sampleWorkshopQueue() : liveQueue ?? emptyWorkshopQueue();
  const orders = useMemo(() => collectWorkshopOrders(displayQueue), [displayQueue]);
  const grouped = useMemo(() => groupOrdersByStation(orders), [orders]);
  const today = shipByCalendarDate();
  const printing = printersAreRunning(orders);
  const dueThisWeek = countDueThisWeek(orders, today);
  const selected = orders.find((order) => order.dealId === selectedDealId) ?? null;

  const tags = useMemo(
    () =>
      usingSample
        ? workshopIntegrationTags({
            hubspotSync: health.data?.hubspotSync ?? {
              status: "ok",
              counts: {
                missingInOps: 0,
                orphans: 0,
                tracking: 0,
                shipNotes: 0,
                shipBy: 0,
                costs: 0,
                amount: 0,
                doneStillOpen: 0,
                closedNotDone: 0,
                failedWrites: 0,
                failedRecalcs: 0,
                webhook: 0,
                token: 0,
              },
              issueCount: 0,
              lastSuccessfulReadAt: null,
              lastSuccessfulWriteAt: null,
              lastCheckedAt: null,
              writes: { pending: 0, failed: 0 },
              webhook: { configured: true, arriving: true, lastDeliveryAt: null, note: "" },
            },
            storage: health.data?.storage ?? {
              configured: true,
              ephemeral: false,
              durableVolumeLikely: true,
              warning: null,
            },
            drive: { configured: true, connected: true, reconnect: false },
            libraryCount: 12,
          })
        : workshopIntegrationTags({
            hubspotSync: health.data?.hubspotSync,
            storage: health.data?.storage,
            drive: drive.data,
            libraryCount: library.data?.total ?? 0,
          }),
    [usingSample, health.data, drive.data, library.data],
  );

  useEffect(() => {
    replaceWorkshopHash(selectedDealId, sample);
  }, [selectedDealId, sample]);

  const showCanvas = webgl && !webglFailed;

  return (
    <div className="workshop-page" data-testid="page-workshop" data-sample={usingSample ? "true" : "false"}>
      <div className="workshop-strip" data-testid="status-workshop-strip">
        {usingSample ? (
          <span className="workshop-sample-flag" data-testid="status-workshop-sample">
            Sample shop data
          </span>
        ) : null}
        {isUnlocked && liveQueue ? (
          <button
            type="button"
            className="workshop-chip"
            data-testid="button-workshop-sample-toggle"
            onClick={() => {
              setSample((value) => !value);
              setSelectedDealId(null);
            }}
          >
            {sample ? "Show live orders" : "Preview sample shop"}
          </button>
        ) : null}
        {!isUnlocked ? (
          <form
            className="workshop-unlock-float"
            data-testid="panel-workshop-unlock"
            onSubmit={(event) => {
              event.preventDefault();
              const code = codeDraft.trim();
              if (code) unlock.mutate(code);
            }}
          >
            <input
              type="password"
              autoComplete="off"
              value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              placeholder="Owner code"
              aria-label="Owner access code"
              data-testid="input-workshop-owner-code"
            />
            <button type="submit" data-testid="button-unlock-workshop" disabled={unlock.isPending || !codeDraft.trim()}>
              Unlock live
            </button>
          </form>
        ) : null}
        {WORKSHOP_STATIONS.map((station) => (
          <span key={station.id} className="workshop-strip-item">
            {station.label}
            <strong className="numeric">{grouped[station.id].length}</strong>
          </span>
        ))}
        <span className="workshop-strip-item">
          Due this week
          <strong className="numeric">{dueThisWeek}</strong>
        </span>
        <span className="workshop-strip-item">
          Printers
          <strong>{printerStatusLabel({ printers: displayQueue.printers, printing })}</strong>
        </span>
      </div>

      <div className="sr-only" data-testid="list-workshop-tokens">
        {orders.map((order) => (
          <button
            key={order.dealId}
            type="button"
            data-testid={`button-workshop-token-${order.dealId}`}
            onClick={() => setSelectedDealId(order.dealId)}
          >
            {order.dealName}
          </button>
        ))}
      </div>

      <div className="workshop-stage">
        {showCanvas ? (
          <Suspense fallback={<div className="workshop-loading">Loading workshop…</div>}>
            <CanvasErrorBoundary onFail={() => setWebglFailed(true)}>
              <WorkshopCanvas
                orders={orders}
                tags={tags}
                selectedDealId={selectedDealId}
                printing={printing}
                dark={isDarkTheme(theme)}
                reduceMotion={reduceMotion}
                onHover={setHover}
                onSelect={setSelectedDealId}
              />
            </CanvasErrorBoundary>
          </Suspense>
        ) : (
          <WorkshopFallback
            orders={orders}
            selectedDealId={selectedDealId}
            onHover={setHover}
            onSelect={setSelectedDealId}
          />
        )}

        {hover && hover.dealId !== selectedDealId ? (
          <div className="workshop-tooltip" data-testid="tooltip-workshop-order">
            <p className="truncate font-medium">{hover.name}</p>
            <p className="truncate text-[hsl(var(--text-3))]">{hover.shipBy}</p>
          </div>
        ) : null}

        {selected ? (
          <WorkshopOrderPanel
            order={selected}
            headers={headers}
            sample={usingSample}
            onClose={() => setSelectedDealId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
