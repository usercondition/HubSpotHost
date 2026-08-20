/**
 * Shared deal ops drawer: costs, stage, ship checklist, packing slip,
 * plate→printer assignment, and failure log.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Loader2,
  Package,
  Printer,
  Ship,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { hubspotDealHref } from "@/lib/workflow";
import { StatusPill } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  FULFILLMENT_CHECKLIST_KEYS,
  FULFILLMENT_CHECKLIST_LABELS,
  PRODUCTION_FAILURE_LABELS,
  PRODUCTION_FAILURE_TYPES,
  type DealOpsDetail,
  type FulfillmentChecklistKey,
  type ProductionFailureType,
} from "@shared/schema";

const PIRATE_SHIP_URL = "https://ship.pirateship.com/";

type DealOpsResponse = DealOpsDetail & { ok: true };

function invalidateOps(dealId?: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
  queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
  queryClient.invalidateQueries({ queryKey: ["/api/printers"] });
  if (dealId) {
    queryClient.invalidateQueries({ queryKey: ["/api/deal-ops", dealId] });
    queryClient.invalidateQueries({ queryKey: ["/api/fulfillment", dealId] });
  }
}

export function DealOpsPanel({
  dealId,
  headers,
  onClose,
}: {
  dealId: string;
  headers: Record<string, string>;
  onClose?: () => void;
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

  const [costs, setCosts] = useState({ material: "", labor: "", packaging: "", shipping: "" });
  const [stageId, setStageId] = useState("");
  const [tracking, setTracking] = useState("");
  const [failureType, setFailureType] = useState<ProductionFailureType>("qc_reject");
  const [failureNotes, setFailureNotes] = useState("");
  const [failureResin, setFailureResin] = useState("");

  useEffect(() => {
    if (!detail.data) return;
    setCosts({
      material: detail.data.costs.material,
      labor: detail.data.costs.labor,
      packaging: detail.data.costs.packaging,
      shipping: detail.data.costs.shipping,
    });
    setStageId(detail.data.stageId);
    setTracking(detail.data.checklist.trackingNumber);
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
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading deal ops…
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="rounded-lg border border-destructive/35 bg-card p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
          <div>
            <p className="font-semibold">Could not load deal ops</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {(detail.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Try refreshing."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const data = detail.data;
  const slip = data.packingSlip;

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-3 md:p-3.5" data-testid="panel-deal-ops">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="rule-label">Deal ops</p>
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
            <a href={PIRATE_SHIP_URL} target="_blank" rel="noopener noreferrer">
              <Ship className="mr-2 h-3.5 w-3.5" />
              Pirate Ship
            </a>
          </Button>
          {onClose ? (
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
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["material", "Material"],
                ["labor", "Labor"],
                ["packaging", "Packaging"],
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
                  placeholder="0.00"
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
        </div>
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
                Kit QC: {slip.kitSummary.good}/{slip.kitSummary.total} good
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
