import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  FilePlus2,
  FileUp,
  KeyRound,
  Layers3,
  Loader2,
  PackageCheck,
  RefreshCw,
  Ruler,
  Scale,
  ShieldCheck,
  Timer,
  Unlock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import type {
  PrintFileCandidateDeal,
  PrintFileMetrics,
  PrintFileOrderSummary,
  PrintFileRecord,
} from "@shared/schema";

interface PrintsResponse {
  ok: true;
  candidates: PrintFileCandidateDeal[];
  records: PrintFileRecord[];
  includeAttached: boolean;
}

interface StagedPrintFile {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
}

function formatHours(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "Not reported";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function formatNumber(value: number | string | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || value === "") return "Not reported";
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numeric) ? `${numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}` : "Not reported";
}

function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Not reported";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "Not reported";
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Unknown time";
}

function UnlockPrints({
  codeDraft,
  setCodeDraft,
  onUnlock,
  pending,
}: {
  codeDraft: string;
  setCodeDraft: (value: string) => void;
  onUnlock: () => void;
  pending: boolean;
}) {
  return (
    <section
      className="mx-auto max-w-lg rounded-lg border border-card-border bg-card p-5 md:p-6"
      aria-labelledby="prints-unlock-title"
      data-testid="panel-prints-unlock"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
        <KeyRound className="h-4 w-4" />
      </div>
      <p className="mt-4 rule-label">Owner access</p>
      <h2 id="prints-unlock-title" className="mt-1 text-lg font-semibold tracking-tight">
        Unlock print-file tracking
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Analyze a Chitubox slice file, attach its production data to a Print Order, and keep your owner code only in this open page.
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onUnlock();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="prints-owner-code">Owner access code</Label>
          <Input
            id="prints-owner-code"
            type="password"
            autoComplete="off"
            value={codeDraft}
            onChange={(event) => setCodeDraft(event.target.value)}
            placeholder="Enter your code"
            data-testid="input-prints-owner-code"
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending || codeDraft.trim().length === 0} data-testid="button-unlock-prints">
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
          Unlock print files
        </Button>
      </form>
    </section>
  );
}

function FileMetrics({ metrics }: { metrics: PrintFileMetrics }) {
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Extracted CTB metrics">
        <StatCard label="Estimated plate time" value={formatHours(metrics.printTimeSeconds)} hint="Whole build plate" icon={Clock3} testId="metric-print-time" />
        <StatCard label="Resin volume" value={formatNumber(metrics.resinVolumeMl, " ml")} hint="Whole build plate" icon={Scale} testId="metric-resin-volume" />
        <StatCard label="Resin mass" value={formatNumber(metrics.resinMassG, " g")} hint={metrics.resinDensityGPerMl ? `${formatNumber(metrics.resinDensityGPerMl)} g/ml density` : "Whole build plate"} icon={PackageCheck} testId="metric-resin-mass" />
        <StatCard
          label="Estimated resin cost"
          value={formatMoney(metrics.resinCost)}
          hint="From Chitubox resin price setting — not actual deal cost"
          icon={CircleDollarSign}
          testId="metric-resin-cost"
        />
        <StatCard
          label="Layers"
          value={formatNumber(metrics.layerCount)}
          hint={`${formatNumber(metrics.layerHeightMm, " mm")} layer · ${formatNumber(metrics.bottomLayerCount)} bottom`}
          icon={Layers3}
          testId="metric-layer-count"
        />
        <StatCard
          label="Build profile"
          value={metrics.printerProfile || "Not reported"}
          hint={
            metrics.resolutionX && metrics.resolutionY
              ? `${metrics.resolutionX} × ${metrics.resolutionY} px`
              : "Resolution not reported"
          }
          icon={Ruler}
          testId="metric-printer-profile"
        />
      </section>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Slice exposure and motion settings"
        data-testid="panel-ctb-settings"
      >
        <StatCard
          label="Normal exposure"
          value={formatNumber(metrics.exposureSeconds, " s")}
          hint={`Light-off ${formatNumber(metrics.lightOffSeconds, " s")}`}
          icon={Timer}
          testId="metric-exposure"
        />
        <StatCard
          label="Bottom exposure"
          value={formatNumber(metrics.bottomExposureSeconds, " s")}
          hint={`Bottom light-off ${formatNumber(metrics.bottomLightOffSeconds, " s")}`}
          icon={Timer}
          testId="metric-bottom-exposure"
        />
        <StatCard
          label="Lift / retract"
          value={
            metrics.liftDistanceMm !== null
              ? `${formatNumber(metrics.liftDistanceMm, " mm")} · ${formatNumber(metrics.liftSpeedMmPerMin, " mm/min")}`
              : "Not reported"
          }
          hint={`Retract ${formatNumber(metrics.retractSpeedMmPerMin, " mm/min")}`}
          icon={Ruler}
          testId="metric-lift"
        />
        <StatCard
          label="Model / file"
          value={metrics.modelHeightMm !== null ? formatNumber(metrics.modelHeightMm, " mm high") : fileSize(metrics.fileSizeBytes)}
          hint={`${fileSize(metrics.fileSizeBytes)} · ${metrics.fileName}`}
          icon={FileUp}
          testId="metric-print-file"
        />
      </section>
    </div>
  );
}

export default function Prints() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [ownerCode, setOwnerCode] = useState("");
  const [includeAttached, setIncludeAttached] = useState(false);
  const [staged, setStaged] = useState<StagedPrintFile | null>(null);
  const [dealId, setDealId] = useState("");
  const [dragging, setDragging] = useState(false);
  const headers = useMemo(() => ({ "x-paid-order-access-code": ownerCode }), [ownerCode]);

  const prints = useQuery<PrintsResponse>({
    queryKey: ["/api/prints", ownerCode, includeAttached],
    enabled: ownerCode.length > 0,
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/prints?includeAttached=${includeAttached ? "true" : "false"}`,
        undefined,
        { headers },
      );
      return (await response.json()) as PrintsResponse;
    },
  });

  const unlock = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("GET", "/api/prints?includeAttached=false", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return { code, data: (await response.json()) as PrintsResponse };
    },
    onSuccess: ({ code, data }) => {
      setOwnerCode(code);
      setCodeDraft("");
      toast({
        title: "Print files unlocked",
        description: `${data.candidates.length} active order${data.candidates.length === 1 ? "" : "s"} can receive plate data.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "That owner code was not accepted",
        description: error.message.startsWith("401")
          ? "Check the code and try again. Nothing was unlocked."
          : "The Print Orders pipeline could not be reached. Try again shortly.",
        variant: "destructive",
      });
    },
  });

  const analyze = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const response = await apiRequest("POST", "/api/prints/analyze", form, { headers });
      return (await response.json()) as { ok: true } & StagedPrintFile;
    },
    onSuccess: ({ analysisId, metrics, expiresAt }) => {
      setStaged({ analysisId, metrics, expiresAt });
      toast({
        title: "Plate data extracted",
        description: "Choose the matching Print Order, then attach the production plan.",
      });
    },
    onError: (error: Error) => {
      setStaged(null);
      toast({
        title: "That slice file could not be analyzed",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const attach = useMutation({
    mutationFn: async () => {
      if (!staged) throw new Error("Analyze a CTB file before attaching it");
      const response = await apiRequest(
        "POST",
        "/api/prints/attach",
        { analysisId: staged.analysisId, dealId },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        record: PrintFileRecord;
        summary: PrintFileOrderSummary;
        message: string;
      };
    },
    onSuccess: ({ summary, message }) => {
      setStaged(null);
      setIncludeAttached(true);
      queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      toast({
        title: `Plate ${summary.plateCount} attached`,
        description: `${message} Running time: ${formatHours(summary.totalPrintTimeSeconds)}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "The plate was not attached",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 240),
        variant: "destructive",
      });
    },
  });

  const acceptFile = (file: File | undefined) => {
    if (!file) return;
    setStaged(null);
    analyze.mutate(file);
  };

  const candidates = prints.data?.candidates ?? [];
  const selected = candidates.find((candidate) => candidate.dealId === dealId);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Print information"
        subtitle="Turn a sliced Chitubox plate into production metrics on the correct Print Order."
        actions={
          <>
            {ownerCode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => prints.refetch()}
                disabled={prints.isFetching}
                data-testid="button-refresh-prints"
              >
                {prints.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
            <ThemeToggle />
          </>
        }
      />

      <div className="space-y-5 px-4 py-5 md:px-6">
        {!ownerCode ? (
          <UnlockPrints
            codeDraft={codeDraft}
            setCodeDraft={setCodeDraft}
            onUnlock={() => unlock.mutate(codeDraft.trim())}
            pending={unlock.isPending}
          />
        ) : prints.isLoading ? (
          <div className="space-y-5" data-testid="skeleton-prints">
            <Skeleton className="h-44 rounded-lg" />
            <Skeleton className="h-80 rounded-lg" />
          </div>
        ) : prints.isError || !prints.data ? (
          <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-prints-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <h2 className="text-base font-semibold tracking-tight">Print-file tracking is not available right now</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  The command center could not read your active Print Orders. Refresh after checking your HubSpot connection and owner code.
                </p>
                <Button className="mt-4" size="sm" onClick={() => prints.refetch()} data-testid="button-retry-prints">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="rounded-lg border border-primary/25 bg-primary/5 p-4" aria-label="Multi-plate workflow" data-testid="panel-multi-plate-guidance">
              <div className="flex items-start gap-3">
                <Layers3 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-semibold tracking-tight">Multi-plate jobs stay under one order</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Attach each `.ctb` plate to the same Print Order. Print Operations keeps a plate-by-plate history, while HubSpot shows running totals for plate count, time, resin volume, resin mass, and slicer resin cost.
                  </p>
                </div>
              </div>
            </section>

            <section className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
              <Panel title="1. Analyze one sliced plate" description="Drag in a Chitubox .ctb file. The raw file is read in memory and then discarded.">
                <input
                  ref={fileInputRef}
                  id="print-file-input"
                  type="file"
                  accept=".ctb,application/octet-stream"
                  className="sr-only"
                  onChange={(event) => {
                    acceptFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                  data-testid="input-print-file"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    acceptFile(event.dataTransfer.files?.[0]);
                  }}
                  className={`flex min-h-40 w-full flex-col items-center justify-center rounded-md border border-dashed px-5 text-center transition-colors ${
                    dragging ? "border-primary bg-primary/10" : "border-border bg-muted/35 hover:bg-muted/60"
                  }`}
                  data-testid="dropzone-print-file"
                >
                  {analyze.isPending ? (
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  ) : (
                    <FileUp className="h-5 w-5 text-primary" />
                  )}
                  <span className="mt-3 text-sm font-medium">
                    {analyze.isPending ? "Reading slice data…" : "Drop a .ctb file here"}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    Extracts time, resin use, cost estimate, exposure, and printer settings. Larger files may take a moment.
                  </span>
                </button>
                <Button
                  className="mt-3"
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={analyze.isPending}
                  data-testid="button-browse-print-file"
                >
                  <FilePlus2 className="mr-2 h-4 w-4" />
                  Browse for a CTB file
                </Button>
              </Panel>

              <Panel title="2. Choose the Print Order" description="Only active orders without a local plate record are listed by default.">
                <div className="space-y-4">
                  <div className="flex items-start gap-2.5 rounded-md bg-muted/45 p-3">
                    <input
                      id="include-attached-orders"
                      type="checkbox"
                      checked={includeAttached}
                      onChange={(event) => setIncludeAttached(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                      data-testid="checkbox-include-attached"
                    />
                    <Label htmlFor="include-attached-orders" className="cursor-pointer text-xs leading-5 text-muted-foreground">
                      Include orders that already have plate data. Use this for plate 2, plate 3, re-slices, or a revision.
                    </Label>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="print-order-select">Active Print Order</Label>
                    <select
                      id="print-order-select"
                      value={dealId}
                      onChange={(event) => setDealId(event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="select-print-order"
                    >
                      <option value="">{candidates.length ? "Choose an outstanding order" : "No matching active orders"}</option>
                      {candidates.map((candidate) => (
                        <option key={candidate.dealId} value={candidate.dealId}>
                          {candidate.dealName} · {candidate.stage}{candidate.hasPrintFile ? " · has plates" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selected ? (
                    <div className="rounded-md border border-border bg-muted/30 p-3" data-testid="text-selected-print-order">
                      <p className="text-sm font-medium">{selected.dealName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{selected.stage}{selected.hasPrintFile ? " · previous plates will be retained and totals will increase" : " · first attached plate"}</p>
                    </div>
                  ) : null}
                  <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    Only the explicit attach action writes to HubSpot. Analysis alone changes nothing. Slicer resin cost never overwrites actual material cost.
                  </div>
                </div>
              </Panel>
            </section>

            {staged ? (
              <section className="space-y-4" data-testid="panel-staged-print-file">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="rule-label">2. Review extracted plate data</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Analysis expires at {localDate(staged.expiresAt)}. Verify the plate belongs to the selected order before attaching it.
                    </p>
                  </div>
                  <StatusPill tone="good" icon={CheckCircle2} label="CTB analyzed" testId="status-ctb-analyzed" />
                </div>
                {staged.metrics.formatRevision.toLowerCase().includes("encrypted") ? (
                  <p className="text-xs leading-5 text-muted-foreground" data-testid="text-encrypted-ctb-note">
                    Encrypted Chitubox settings were decrypted in memory for this plate ({staged.metrics.formatRevision}).
                  </p>
                ) : null}
                <FileMetrics metrics={staged.metrics} />
                <div className="flex flex-col justify-between gap-3 rounded-lg border border-card-border bg-card p-4 sm:flex-row sm:items-center">
                  <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
                    These figures describe the complete build plate. Do not use them as the order’s actual material cost when a plate contains more than one customer’s work.
                  </p>
                  <Button
                    onClick={() => attach.mutate()}
                    disabled={!dealId || attach.isPending}
                    data-testid="button-attach-print-file"
                  >
                    {attach.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />}
                    Attach to selected order
                  </Button>
                </div>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed border-border bg-muted/20 p-5 text-center" data-testid="panel-print-analysis-empty">
                <FileUp className="mx-auto h-5 w-5 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">Analyze a plate to continue</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  The file’s estimated time, resin use, slicer cost, exposure, layers, and printer profile will appear here before you attach anything.
                </p>
              </section>
            )}

            <Panel title="Recent plate history" description="A local record of each attached plate. HubSpot receives the matching rolling totals for every order.">
              {prints.data.records.length ? (
                <div className="overflow-x-auto">
                  <table className="min-w-[54rem] text-left text-xs">
                    <thead className="border-b border-border text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2 font-medium">Print Order</th>
                        <th className="px-2 py-2 font-medium">Plate file</th>
                        <th className="px-2 py-2 font-medium">Time</th>
                        <th className="px-2 py-2 font-medium">Resin</th>
                        <th className="px-2 py-2 font-medium">Slicer cost</th>
                        <th className="px-2 py-2 font-medium">Exposure</th>
                        <th className="px-2 py-2 font-medium">Synced</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prints.data.records.map((record) => (
                        <tr key={record.id} className="border-b border-border/70 last:border-b-0" data-testid={`row-print-record-${record.id}`}>
                          <td className="px-2 py-3">
                            <p className="font-medium">{record.hubspotDealName}</p>
                            <p className="mt-0.5 text-muted-foreground">{record.dealStage}</p>
                          </td>
                          <td className="max-w-56 px-2 py-3">
                            <p className="truncate font-medium" title={record.fileName}>{record.fileName}</p>
                            <p className="mt-0.5 text-muted-foreground">{fileSize(record.fileSizeBytes)} · {record.printerProfile || "No printer profile"}</p>
                          </td>
                          <td className="px-2 py-3 numeric">{formatHours(record.printTimeSeconds)}</td>
                          <td className="px-2 py-3 numeric">{formatNumber(record.resinVolumeMl, " ml")} · {formatNumber(record.resinMassG, " g")}</td>
                          <td className="px-2 py-3 numeric">{formatMoney(record.resinCost)}</td>
                          <td className="px-2 py-3 numeric">
                            {formatNumber(record.exposureSeconds, " s")}
                            {record.bottomExposureSeconds ? ` / ${formatNumber(record.bottomExposureSeconds, " s bot")}` : ""}
                          </td>
                          <td className="px-2 py-3">
                            <p className="font-medium text-chart-4">HubSpot synced</p>
                            <p className="mt-0.5 text-muted-foreground">{localDate(record.hubspotSyncedAt)}</p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="py-7 text-center">
                  <Layers3 className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">No plates attached yet</p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    Your first completed attachment will create the plate history and running totals for that Print Order.
                  </p>
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
