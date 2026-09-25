/**
 * Shared deal ops drawer: costs, stage, ship checklist, packing slip,
 * plate→printer assignment, and failure log.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Loader2,
  Package,
  Printer,
  Ship,
  FileUp,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hubspotDealHref, labelsDealHref, printsDealHref } from "@/lib/workflow";
import { StatusPill, WorkspaceSection } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { drawerPanelVariants, drawerScrimVariants } from "@/lib/motion";
import { Link } from "wouter";
import {
  FULFILLMENT_CHECKLIST_KEYS,
  FULFILLMENT_CHECKLIST_LABELS,
  PRODUCTION_FAILURE_LABELS,
  PRODUCTION_FAILURE_TYPES,
  type DealOpsDetail,
  type FulfillmentChecklistKey,
  type ProductionFailureType,
} from "@shared/schema";
import { defaultDealCostFields } from "@shared/deal-costs";

type DealOpsResponse = DealOpsDetail & { ok: true };

function invalidateOps(dealId?: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
  queryClient.invalidateQueries({ queryKey: ["/api/priority-stack"] });
  queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
  queryClient.invalidateQueries({ queryKey: ["/api/printers"] });
  if (dealId) {
    queryClient.invalidateQueries({ queryKey: ["/api/deal-ops", dealId] });
    queryClient.invalidateQueries({ queryKey: ["/api/fulfillment", dealId] });
  }
}

/**
 * Right-side ops drawer — overlays the board so columns don’t jump.
 * Desktop: board stays clickable (switch orders without closing).
 * Mobile: light scrim to dismiss.
 */
export function DealOpsDrawer({
  dealId,
  headers,
  onClose,
}: {
  dealId: string | null;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  const open = Boolean(dealId);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && dealId ? (
        <motion.div
          key="deal-ops-drawer"
          className="pointer-events-none fixed inset-0 z-40"
          data-testid="drawer-deal-ops-root"
          initial="initial"
          animate="enter"
          exit="exit"
        >
          <motion.button
            type="button"
            aria-label="Dismiss deal ops"
            className="pointer-events-auto absolute inset-0 bg-black/40 md:bg-black/25"
            onClick={onClose}
            data-testid="button-deal-ops-scrim"
            variants={reduceMotion ? undefined : drawerScrimVariants}
            initial={reduceMotion ? false : "initial"}
            animate={reduceMotion ? undefined : "enter"}
            exit={reduceMotion ? undefined : "exit"}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Deal ops"
            className="pointer-events-auto absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-border bg-background shadow-2xl md:max-w-2xl"
            data-testid="drawer-deal-ops"
            onClick={(event) => event.stopPropagation()}
            variants={reduceMotion ? undefined : drawerPanelVariants}
            initial={reduceMotion ? false : "initial"}
            animate={reduceMotion ? undefined : "enter"}
            exit={reduceMotion ? undefined : "exit"}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <p className="rule-label">Deal ops</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0"
                onClick={onClose}
                data-testid="button-close-deal-ops-drawer"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4">
              <DealOpsPanel dealId={dealId} headers={headers} onClose={onClose} flush />
            </div>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function DealOpsPanel({
  dealId,
  headers,
  onClose,
  flush = false,
}: {
  dealId: string;
  headers: Record<string, string>;
  onClose?: () => void;
  /** Drop outer card chrome when nested in the drawer. */
  flush?: boolean;
}) {
  const { toast } = useToast();
  const detail = useQuery<DealOpsResponse>({
    queryKey: ["/api/deal-ops", dealId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/deal-ops/${encodeURIComponent(dealId)}`, undefined, {
        headers,
      });
      return (await response.json()) as DealOpsResponse;
    },
  });

  const [costs, setCosts] = useState(defaultDealCostFields);
  const [stageId, setStageId] = useState("");
  const [tracking, setTracking] = useState("");
  const [shipBy, setShipBy] = useState("");
  const [shipPlanNote, setShipPlanNote] = useState("");
  const [failureType, setFailureType] = useState<ProductionFailureType>("qc_reject");
  const [pendingLabel, setPendingLabel] = useState<{
    trackingNumber: string;
    notes: string;
    postageUsd: string;
    companions: Array<{ dealId: string; dealName: string; score: number }>;
    selected: string[];
  } | null>(null);
  const [failureNotes, setFailureNotes] = useState("");
  const [failureResin, setFailureResin] = useState("");
  const labelFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!detail.data) return;
    setCosts({
      material: detail.data.costs.material,
      labor: detail.data.costs.labor || "0",
      packaging: detail.data.costs.packaging || "0",
      shipping: detail.data.costs.shipping,
    });
    setStageId(detail.data.stageId);
    setTracking(detail.data.checklist.trackingNumber);
    setShipBy(detail.data.shipByOverride ?? "");
    setShipPlanNote(detail.data.shipPlanNote ?? "");
  }, [detail.data]);

  const openStages = useMemo(
    () => (detail.data?.stages ?? []).filter((stage) => !stage.closed),
    [detail.data?.stages],
  );

  const saveCosts = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "PATCH",
        `/api/deal-ops/${encodeURIComponent(dealId)}/costs`,
        { ...costs, liveWrite: true },
        { headers },
      );
      return response.json();
    },
    onSuccess: (data: { dryRun?: boolean; gate?: string }) => {
      invalidateOps(dealId);
      toast({
        title: data.dryRun ? "Costs previewed (dry run)" : "Costs saved to HubSpot",
        description: data.dryRun
          ? `Write gate: ${data.gate || "dry-run"}. Enable ALLOW_HUBSPOT_WRITES for live updates.`
          : "Margin automation will refresh from the new inputs.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save costs",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const advanceStage = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        `/api/deal-ops/${encodeURIComponent(dealId)}/stage`,
        { stageId, liveWrite: true },
        { headers },
      );
      return response.json();
    },
    onSuccess: (data: { dryRun?: boolean; stageLabel?: string }) => {
      invalidateOps(dealId);
      toast({
        title: data.dryRun ? "Stage preview (dry run)" : "Stage updated in HubSpot",
        description: data.stageLabel || "Pipeline stage saved.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not advance stage",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const saveShipByPlan = useMutation({
    mutationFn: async (input: { shipBy: string; note: string }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/deal-ops/${encodeURIComponent(dealId)}/ship-by`,
        { ...input, liveWrite: true },
        { headers },
      );
      return response.json() as Promise<{ dryRun?: boolean; gate?: string; shipByOverride?: string | null }>;
    },
    onSuccess: (data) => {
      invalidateOps(dealId);
      toast({
        title: data.dryRun ? "Ship plan previewed (dry run)" : data.shipByOverride ? "Ship-by override saved" : "Ship-by override cleared",
        description: data.dryRun
          ? `Write gate: ${data.gate || "dry-run"}. Enable ALLOW_HUBSPOT_WRITES for live CRM sync.`
          : "Floor, Ask Ops, and synced ship events will use the updated plan.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save ship plan",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const toggleChecklist = useMutation({
    mutationFn: async (patch: Partial<Record<FulfillmentChecklistKey, boolean>> & { trackingNumber?: string; notes?: string }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/fulfillment/${encodeURIComponent(dealId)}`,
        { ...patch, liveWrite: true },
        { headers },
      );
      return response.json() as Promise<{
        ok: true;
        checklist: DealOpsDetail["checklist"];
        hubspot: { dryRun?: boolean; gate?: string; wrote?: boolean } | null;
      }>;
    },
    onSuccess: (data, variables) => {
      invalidateOps(dealId);
      if (variables.trackingNumber !== undefined || variables.notes !== undefined) {
        toast({
          title: data.hubspot?.dryRun
            ? "Tracking saved locally (HubSpot dry run)"
            : data.hubspot?.wrote
              ? "Tracking saved to HubSpot"
              : "Tracking saved",
          description: data.hubspot?.dryRun
            ? `Write gate: ${data.hubspot.gate || "dry-run"}. Enable ALLOW_HUBSPOT_WRITES for live CRM sync.`
            : "Checklist updated on this order.",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Checklist update failed",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const attachLabelPdf = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      body.append("anchorDealId", dealId);
      const parsedResponse = await apiRequest("POST", "/api/shipping-labels/parse", body, { headers });
      const parsed = (await parsedResponse.json()) as {
        ok: true;
        fields: {
          trackingNumber: string | null;
          service: string | null;
          carrier: string | null;
          postageUsd: string | null;
          recipientName: string | null;
        };
        suggestedNotes: string;
        matches: Array<{ dealId: string; contactName: string | null; dealName: string; score: number }>;
      };
      const trackingNumber = parsed.fields.trackingNumber?.trim() || "";
      if (trackingNumber.length < 6) {
        throw new Error("Could not read a tracking number from that PDF — confirm on Labels.");
      }
      // This deal always; plus any same-client companions (OCR fuzzy or HubSpot identity).
      const companions = parsed.matches
        .filter((row) => row.dealId !== dealId && row.score >= 70)
        .map((row) => ({ dealId: row.dealId, dealName: row.dealName, score: row.score }));
      if (companions.length > 0) {
        return {
          pending: true as const,
          trackingNumber,
          notes: parsed.suggestedNotes || "",
          postageUsd: parsed.fields.postageUsd || "",
          companions,
        };
      }
      const dealIds = [dealId];
      const attachResponse = await apiRequest(
        "POST",
        "/api/shipping-labels/attach",
        {
          dealIds,
          trackingNumber,
          notes: parsed.suggestedNotes || "",
          postageUsd: parsed.fields.postageUsd || "",
          packingDone: true,
          labelBought: true,
          markComplete: true,
          messageChannel: "marketplace",
          liveWrite: true,
        },
        { headers },
      );
      const attached = (await attachResponse.json()) as {
        ok: boolean;
        attachedDealIds?: string[];
        error?: string;
        buyerEmail?: {
          sent?: boolean;
          skipped?: boolean;
          to?: string | null;
          reason?: string | null;
          error?: string | null;
        } | null;
      };
      if (!attached.ok) {
        throw new Error(attached.error || "Could not attach tracking");
      }
      return {
        pending: false as const,
        trackingNumber,
        dealIds: attached.attachedDealIds?.length ? attached.attachedDealIds : dealIds,
        recipientName: parsed.fields.recipientName,
        buyerEmail: attached.buyerEmail ?? null,
      };
    },
    onSuccess: (data) => {
      if (data.pending) {
        setPendingLabel({
          trackingNumber: data.trackingNumber,
          notes: data.notes,
          postageUsd: data.postageUsd,
          companions: data.companions,
          selected: data.companions.map((row) => row.dealId),
        });
        return;
      }
      setPendingLabel(null);
      setTracking(data.trackingNumber);
      invalidateOps(dealId);
      queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      const emailBit = data.buyerEmail?.sent
        ? ` · emailed ${data.buyerEmail.to}`
        : data.buyerEmail?.error
          ? ` · email failed`
          : "";
      toast({
        title: data.dealIds.length > 1 ? `Tracking on ${data.dealIds.length} orders` : "Label attached",
        description:
          data.dealIds.length > 1
            ? `${data.trackingNumber} saved on this order plus same-client companions (shared box).${emailBit}`
            : `${data.trackingNumber} saved on this Print Order.${emailBit}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not attach label PDF",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 240),
        variant: "destructive",
      });
    },
  });

  const confirmPendingLabel = useMutation({
    mutationFn: async () => {
      if (!pendingLabel) throw new Error("Nothing to attach");
      const dealIds = [dealId, ...pendingLabel.selected];
      const attachResponse = await apiRequest(
        "POST",
        "/api/shipping-labels/attach",
        {
          dealIds,
          trackingNumber: pendingLabel.trackingNumber,
          notes: pendingLabel.notes,
          postageUsd: pendingLabel.postageUsd,
          packingDone: true,
          labelBought: true,
          markComplete: true,
          messageChannel: "marketplace",
          liveWrite: true,
        },
        { headers },
      );
      const attached = (await attachResponse.json()) as { ok: boolean; error?: string; attachedDealIds?: string[] };
      if (!attached.ok) throw new Error(attached.error || "Could not attach tracking");
      return { trackingNumber: pendingLabel.trackingNumber, count: attached.attachedDealIds?.length ?? dealIds.length };
    },
    onSuccess: (data) => {
      setPendingLabel(null);
      setTracking(data.trackingNumber);
      invalidateOps(dealId);
      toast({
        title: data.count > 1 ? `Tracking on ${data.count} orders` : "Label attached",
        description: `${data.trackingNumber} saved.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not attach label PDF", description: error.message.replace(/^\d+:\s*/, "").slice(0, 240), variant: "destructive" });
    },
  });

  const assignPrinter = useMutation({
    mutationFn: async (input: { recordId: number; printerId: number | null }) => {
      const response = await apiRequest("POST", "/api/plates/assign-printer", input, { headers });
      return response.json();
    },
    onSuccess: () => {
      invalidateOps(dealId);
      toast({ title: "Printer assignment saved" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not assign printer",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const logFailure = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        "/api/failures",
        {
          dealId,
          dealName: detail.data?.dealName || "",
          failureType,
          resinMassG: failureResin,
          notes: failureNotes,
        },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      setFailureNotes("");
      setFailureResin("");
      invalidateOps(dealId);
      toast({ title: "Failure logged" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not log failure",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  if (detail.isLoading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground",
          !flush && "rounded-lg border border-border bg-card p-6",
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading deal ops…
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    if (flush) {
      return (
        <div className="flex items-start gap-3" data-testid="panel-deal-ops-error">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
          <div>
            <p className="font-semibold">Could not load deal ops</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {(detail.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Try refreshing."}
            </p>
          </div>
        </div>
      );
    }
    return (
      <WorkspaceSection title="Could not load deal ops" testId="panel-deal-ops-error">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
          <p className="text-sm text-muted-foreground">
            {(detail.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Try refreshing."}
          </p>
        </div>
      </WorkspaceSection>
    );
  }

  const data = detail.data;
  const slip = data.packingSlip;

  return (
    <section
      className={cn(
        "space-y-3",
        !flush && "rounded-md border border-border bg-card p-3 md:p-3.5",
      )}
      data-testid="panel-deal-ops"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {!flush ? <p className="rule-label">Deal ops</p> : null}
          <h2 className="truncate text-lg font-semibold tracking-tight">{data.dealName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.stage} · {formatMoney(data.amount)}
            {data.writeGate.liveWriteReady ? "" : " · HubSpot writes in dry-run"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={hubspotDealHref(dealId, data.hubspotPortalId)} target="_blank" rel="noopener noreferrer">
              HubSpot
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={labelsDealHref(dealId)} data-testid="link-deal-ops-labels">
              <Ship className="mr-2 h-3.5 w-3.5" />
              Labels
            </Link>
          </Button>
          {data.plates.length === 0 ? (
            <Button asChild size="sm" variant="outline">
              <Link href={printsDealHref(dealId)} data-testid="link-deal-ops-prints">
                Attach plates
              </Link>
            </Button>
          ) : null}
          {onClose && !flush ? (
            <Button size="sm" variant="ghost" onClick={onClose} data-testid="button-close-deal-ops">
              Close
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-md border border-border/80 p-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Actual costs</h3>
            <StatusPill
              tone={data.costs.costsComplete ? "good" : "warn"}
              icon={data.costs.costsComplete ? CheckCircle2 : AlertTriangle}
              label={data.costs.costsComplete ? "Complete" : "Incomplete"}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Need material + shipping. Labor is absorbed ($0). Packaging is free USPS Large Flat Rate ($0).
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["material", "Material"],
                ["labor", "Labor (absorbed)"],
                ["packaging", "Packaging (free USPS)"],
                ["shipping", "Shipping"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label htmlFor={`cost-${key}`}>{label}</Label>
                <Input
                  id={`cost-${key}`}
                  inputMode="decimal"
                  value={costs[key]}
                  onChange={(event) => setCosts((current) => ({ ...current, [key]: event.target.value }))}
                  placeholder={key === "labor" || key === "packaging" ? "0" : "0.00"}
                />
              </div>
            ))}
          </div>
          {data.costs.grossProfit != null ? (
            <p className="text-xs text-muted-foreground">
              GP {formatMoney(data.costs.grossProfit)}
              {data.costs.marginPercentage != null ? ` · ${data.costs.marginPercentage.toFixed(1)}% margin` : ""}
            </p>
          ) : null}
          <Button size="sm" onClick={() => saveCosts.mutate()} disabled={saveCosts.isPending} data-testid="button-save-costs">
            {saveCosts.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Save costs
          </Button>
        </div>

        <div className="space-y-3 rounded-md border border-border/80 p-3">
          <h3 className="text-sm font-semibold">Advance stage</h3>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={stageId}
            onChange={(event) => setStageId(event.target.value)}
            data-testid="select-deal-stage"
          >
            {openStages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => advanceStage.mutate()}
            disabled={advanceStage.isPending || !stageId}
            data-testid="button-advance-stage"
          >
            {advanceStage.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Update stage
          </Button>
        </div>

        <div className="space-y-3 rounded-md border border-border/80 p-3">
          <div>
            <h3 className="text-sm font-semibold">Ship-by plan</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Set a manual HubSpot date for coordinated batches. Clear the date to return to the physical print-time plan.
            </p>
          </div>
          <div>
            <Label htmlFor="ship-by-override">Ship by</Label>
            <Input
              id="ship-by-override"
              type="date"
              value={shipBy}
              onChange={(event) => setShipBy(event.target.value)}
              data-testid="input-ship-by-override"
            />
          </div>
          <div>
            <Label htmlFor="ship-plan-note">Ship plan note</Label>
            <Textarea
              id="ship-plan-note"
              value={shipPlanNote}
              onChange={(event) => setShipPlanNote(event.target.value)}
              placeholder="Process Thu, ship with Rhinos weekend"
              data-testid="input-ship-plan-note"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => saveShipByPlan.mutate({ shipBy, note: shipPlanNote })}
              disabled={saveShipByPlan.isPending}
              data-testid="button-save-ship-by-override"
            >
              {saveShipByPlan.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Save ship plan
            </Button>
            {data.shipByOverride ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setShipBy("");
                  saveShipByPlan.mutate({ shipBy: "", note: shipPlanNote });
                }}
                disabled={saveShipByPlan.isPending}
                data-testid="button-clear-ship-by-override"
              >
                Clear override
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border/80 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Ship-ready checklist</h3>
          <StatusPill
            tone={data.checklist.shipReady ? "good" : "neutral"}
            icon={CheckCircle2}
            label={`${data.checklist.completedCount}/${data.checklist.totalCount} · ${data.checklist.readyPercent}%`}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {FULFILLMENT_CHECKLIST_KEYS.map((key) => {
            const checked = data.checklist[key];
            return (
              <label
                key={key}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                  checked ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => toggleChecklist.mutate({ [key]: event.target.checked })}
                  data-testid={`check-fulfillment-${key}`}
                />
                {FULFILLMENT_CHECKLIST_LABELS[key]}
              </label>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <Label htmlFor="tracking-number">Tracking number</Label>
            <Input
              id="tracking-number"
              value={tracking}
              onChange={(event) => setTracking(event.target.value)}
              placeholder="Paste after Pirate Ship"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toggleChecklist.mutate({
                trackingNumber: tracking,
                trackingPasted: tracking.trim().length > 0 ? true : data.checklist.trackingPasted,
              })
            }
          >
            Save tracking
          </Button>
          <input
            ref={labelFileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            data-testid="input-deal-ops-label-pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) attachLabelPdf.mutate(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={attachLabelPdf.isPending}
            onClick={() => labelFileRef.current?.click()}
            data-testid="button-deal-ops-upload-label"
          >
            {attachLabelPdf.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileUp className="mr-2 h-3.5 w-3.5" />
            )}
            Upload label PDF
          </Button>
          {pendingLabel ? (
            <div className="w-full space-y-1" data-testid="panel-label-companions">
              <p className="text-xs text-muted-foreground">Same-client orders auto-added. Untick any that are not in this box.</p>
              {pendingLabel.companions.map((row) => (
                <label key={row.dealId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={pendingLabel.selected.includes(row.dealId)}
                    data-testid={`checkbox-label-companion-${row.dealId}`}
                    onChange={() => {
                      setPendingLabel((current) => {
                        if (!current) return current;
                        const selected = current.selected.includes(row.dealId)
                          ? current.selected.filter((id) => id !== row.dealId)
                          : [...current.selected, row.dealId];
                        return { ...current, selected };
                      });
                    }}
                  />
                  <span className="min-w-0 truncate">{row.dealName}</span>
                  <span className="text-xs text-muted-foreground">score {row.score}</span>
                </label>
              ))}
              <Button type="button" size="sm" disabled={confirmPendingLabel.isPending} onClick={() => confirmPendingLabel.mutate()} data-testid="button-confirm-label-companions">
                Attach tracking
              </Button>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Upload reads the PDF (OCR if needed), saves tracking on this order, and onto every other open/recent order for the same HubSpot client when they share a box.
        </p>
      </div>

      <div className="space-y-3 rounded-md border border-border/80 p-3">
        <div className="flex items-center gap-2">
          <Printer className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Assign plates to printers</h3>
        </div>
        {data.plates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plates attached yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.plates.map((plate) => (
              <li key={plate.id} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{plate.fileName}</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={plate.assignedPrinterId ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    assignPrinter.mutate({
                      recordId: plate.id,
                      printerId: value ? Number(value) : null,
                    });
                  }}
                  data-testid={`select-plate-printer-${plate.id}`}
                >
                  <option value="">Unassigned</option>
                  {data.printers
                    .filter((printer) => printer.status === "active")
                    .map((printer) => (
                      <option key={printer.id} value={printer.id}>
                        {printer.name}
                      </option>
                    ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-md border border-border/80 p-3">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Packing slip</h3>
          </div>
          <div className="rounded-md bg-muted/45 p-3 text-sm" data-testid="panel-packing-slip">
            <p className="font-medium">{slip.contact.name || "Buyer"}</p>
            {slip.contact.addressLines.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
            {slip.contact.email ? <p className="mt-1 text-muted-foreground">{slip.contact.email}</p> : null}
            <ul className="mt-3 space-y-1 border-t border-border pt-2">
              {slip.lines.slice(0, 20).map((line, index) => (
                <li key={`${line.kind}-${index}`} className="flex justify-between gap-2">
                  <span className="truncate">{line.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{line.status || line.detail}</span>
                </li>
              ))}
            </ul>
            {slip.kitSummary ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Parts QC: {slip.kitSummary.good}/{slip.kitSummary.total} good
                {slip.kitSummary.reprint > 0 ? ` · ${slip.kitSummary.reprint} reprint` : ""}
              </p>
            ) : null}
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border/80 p-3">
          <h3 className="text-sm font-semibold">Log reprint / failure</h3>
          <div className="grid gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={failureType}
              onChange={(event) => setFailureType(event.target.value as ProductionFailureType)}
            >
              {PRODUCTION_FAILURE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {PRODUCTION_FAILURE_LABELS[type]}
                </option>
              ))}
            </select>
            <Input
              placeholder="Resin wasted (g)"
              value={failureResin}
              onChange={(event) => setFailureResin(event.target.value)}
            />
            <Textarea
              placeholder="What failed / what to reprint"
              value={failureNotes}
              onChange={(event) => setFailureNotes(event.target.value)}
              rows={3}
            />
            <Button size="sm" variant="outline" onClick={() => logFailure.mutate()} disabled={logFailure.isPending}>
              {logFailure.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Log failure
            </Button>
          </div>
          {data.failures.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {data.failures.slice(0, 5).map((failure) => (
                <li key={failure.id}>
                  {PRODUCTION_FAILURE_LABELS[failure.failureType]} · {new Date(failure.occurredAt).toLocaleDateString()}
                  {failure.notes ? ` — ${failure.notes}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
