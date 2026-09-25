import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildFloorNeeds, fepDuePrinters } from "@/lib/floor-needs";
import { apiRequest } from "@/lib/queryClient";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { shipByCalendarDate } from "@shared/ship-by";
import type { HealthResponse, PerformanceResponse, PrinterFleetSnapshot, ProductionQueueResponse, ResinReorderResponse } from "@shared/schema";

/**
 * Shared shop counts. The bell, the Floor tab, and Needs you all read `needsYou`.
 */
export function useShopCounts() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();

  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

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

  const productionQueue = useQuery<ProductionQueueResponse>({
    queryKey: ["/api/production-queue", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/production-queue", undefined, { headers });
      return (await response.json()) as ProductionQueueResponse;
    },
    staleTime: 30_000,
  });

  const stack = useQuery<{ rows: unknown[]; generatedAt?: string }>({
    queryKey: ["/api/priority-stack", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/priority-stack", undefined, { headers });
      return response.json();
    },
  });

  const needs = useMemo(() => {
    if (!performance.data) return [];
    const queue = productionQueue.data
      ? [
          ...productionQueue.data.nextPrint,
          ...productionQueue.data.inProduction,
          ...productionQueue.data.blocked,
          ...productionQueue.data.shipReady,
        ]
      : [];
    return buildFloorNeeds({
      today: shipByCalendarDate(),
      portalId: performance.data.hubspotPortalId,
      attention: performance.data.attention ?? [],
      deals: performance.data.activeDeals ?? [],
      queue,
      pendingReview: performance.data.intake.pendingReview,
      awaitingClient: performance.data.intake.awaitingClient,
      resinBuyNow: resinReorder.data?.buyNow ?? [],
      fepDue: fepDuePrinters(printers.data?.printers ?? []),
    });
  }, [performance.data, productionQueue.data, resinReorder.data, printers.data]);

  const pulledAt = [health.dataUpdatedAt, performance.dataUpdatedAt, productionQueue.dataUpdatedAt, stack.dataUpdatedAt]
    .filter((value) => value > 0)
    .reduce((latest, value) => Math.max(latest, value), 0);

  return {
    needs,
    needsYou: performance.data ? needs.length : null,
    stackCount: stack.data ? stack.data.rows.length : null,
    queueCount: productionQueue.data
      ? productionQueue.data.nextPrint.length + productionQueue.data.inProduction.length
      : null,
    pulledAt: pulledAt > 0 ? new Date(pulledAt).toISOString() : null,
    health: health.data,
  };
}
