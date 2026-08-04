import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  FilePlus2,
  FileUp,
  Layers3,
  Loader2,
  PackageCheck,
  RefreshCw,
  Ruler,
  Scale,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readHashQueryParam } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession } from "@/hooks/use-owner-session";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import type {
  PrintFileCandidateDeal,
  PrintFileMetrics,
  PrintFileOrderSummary,
  PrintFileRecord,
  ResinProfile,
} from "@shared/schema";

interface ResinRateView {
  source: "amazon" | "supplies" | "manual";
  bottlePriceUsd: number;
  bottleMassG: number;
  bottleVolumeMl: number | null;
  label: string;
  usdPerGram: number | null;
  usdPerMl: number | null;
}

interface ResinProfileResponse {
  profile: ResinProfile;
  rate: ResinRateView | null;
  suppliesRate: ResinRateView | null;
  amazonUrl: string;
  canRefreshAmazon: boolean;
}

interface PrintsResponse {
  ok: true;
  candidates: PrintFileCandidateDeal[];
  records: PrintFileRecord[];
  includeAttached: boolean;
  resin?: ResinProfileResponse;
}

interface StagedPrintFile {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
}

interface CostFieldProposal {
  field: "material" | "labor" | "packaging" | "shipping";
  property: string;
  label: string;
  proposed: number | null;
  current: number | null;
  source: string;
  willWrite: boolean;
  skipReason: string | null;
}

interface CostDefaultsPreview {
  dealId: string;
  dealName: string;
  plateCount: number;
  totalPrintHours: number | null;
  totalResinCost: number | null;
  laborRatePerHour: number;
  packagingAmount: number;
  fields: CostFieldProposal[];
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

function resinCostHint(metrics: PrintFileMetrics): string {
  if (metrics.resinCostLabel) return metrics.resinCostLabel;
  if (metrics.resinCostSource === "ctb") return "From Chitubox resin price setting — not actual deal cost";
  return "No resin price in the CTB and no active bottle rate yet";
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
          hint={resinCostHint(metrics)}
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
  const { ownerCode, isUnlocked, headers, unlock: setSessionUnlocked } = useOwnerSession();
  const [includeAttached, setIncludeAttached] = useState(true);
  const [staged, setStaged] = useState<StagedPrintFile | null>(null);
  const [dealId, setDealId] = useState(() => readHashQueryParam("dealId") ?? "");
  const [dragging, setDragging] = useState(false);
  const [resinName, setResinName] = useState("ELEGOO ABS-Like 3.0 Space Grey");
  const [resinAsin, setResinAsin] = useState("B0D6Y6JV42");
  const [resinMassG, setResinMassG] = useState("1000");
  const [resinPrice, setResinPrice] = useState("");
  const [includeMaterial, setIncludeMaterial] = useState(true);
  const [includeLabor, setIncludeLabor] = useState(false);
  const [includePackaging, setIncludePackaging] = useState(true);
  const [includeShipping, setIncludeShipping] = useState(false);
  const [overwriteCosts, setOverwriteCosts] = useState(false);
  const [laborRate, setLaborRate] = useState("25");
  const [packagingAmount, setPackagingAmount] = useState("5");
  const [shippingAmount, setShippingAmount] = useState("");
  const [costPreview, setCostPreview] = useState<CostDefaultsPreview | null>(null);

  useEffect(() => {
    const fromHash = readHashQueryParam("dealId");
    if (fromHash) {
      setDealId(fromHash);
      setIncludeAttached(true);
    }
    const onHash = () => {
      const next = readHashQueryParam("dealId");
      if (next) {
        setDealId(next);
        setIncludeAttached(true);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const prints = useQuery<PrintsResponse>({
    queryKey: ["/api/prints", ownerCode, includeAttached],
    enabled: isUnlocked,
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

  const resin = prints.data?.resin;
  useEffect(() => {
    if (!resin?.profile) return;
    setResinName(resin.profile.name);
    setResinAsin(resin.profile.amazonAsin || "B0D6Y6JV42");
    setResinMassG(resin.profile.bottleMassG || "1000");
    setResinPrice(resin.profile.bottlePriceUsd === "0" ? "" : resin.profile.bottlePriceUsd);
  }, [resin?.profile?.id, resin?.profile?.updatedAt, resin?.profile?.bottlePriceUsd, resin?.profile?.name, resin?.profile?.amazonAsin, resin?.profile?.bottleMassG]);

  const saveResin = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "PUT",
        "/api/resin-profile",
        {
          name: resinName,
          amazonAsin: resinAsin,
          amazonUrl: resinAsin ? `https://www.amazon.com/dp/${resinAsin.trim()}` : "",
          bottleMassG: Number(resinMassG) || 1000,
          bottleVolumeMl: null,
          bottlePriceUsd: resinPrice || "0",
          notes: "",
        },
        { headers },
      );
      return (await response.json()) as { ok: true } & ResinProfileResponse;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      toast({ title: "Resin profile saved", description: "New plate estimates will use this bottle rate when the CTB has no slicer price." });
    },
    onError: (error: Error) => {
      toast({
        title: "Resin profile was not saved",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const refreshAmazon = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/resin-profile/refresh-amazon", {}, { headers });
      return (await response.json()) as { ok: true; cached: boolean; price: number } & ResinProfileResponse;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      setResinPrice(String(data.price));
      toast({
        title: data.cached ? "Using recent Amazon price" : "Amazon price refreshed",
        description: `Bottle price set to $${Number(data.price).toFixed(2)}. Live Amazon prices can change or fail; verify before relying on them.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Amazon price could not be refreshed",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const unlock = useMutation({
    mutationFn: async (code: string) => {
      const response = await apiRequest("GET", "/api/prints?includeAttached=true", undefined, {
        headers: { "x-paid-order-access-code": code },
      });
      return { code, data: (await response.json()) as PrintsResponse };
    },
    onSuccess: ({ code, data }) => {
      setSessionUnlocked(code);
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
      setCostPreview(null);
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

  const costDefaultsBody = () => ({
    dealId,
    laborRatePerHour: laborRate || null,
    packagingAmount: packagingAmount || null,
    shippingAmount: includeShipping ? shippingAmount || null : null,
    includeMaterial,
    includeLabor,
    includePackaging,
    includeShipping,
    overwriteExisting: overwriteCosts,
  });

  const previewCosts = useMutation({
    mutationFn: async () => {
      if (!dealId) throw new Error("Choose a Print Order first");
      const response = await apiRequest(
        "POST",
        "/api/prints/cost-defaults/preview",
        costDefaultsBody(),
        { headers },
      );
      return (await response.json()) as { ok: true; preview: CostDefaultsPreview };
    },
    onSuccess: ({ preview }) => {
      setCostPreview(preview);
      setLaborRate(String(preview.laborRatePerHour));
      setPackagingAmount(String(preview.packagingAmount));
    },
    onError: (error: Error) => {
      setCostPreview(null);
      toast({
        title: "Could not preview cost defaults",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 240),
        variant: "destructive",
      });
    },
  });

  const applyCosts = useMutation({
    mutationFn: async () => {
      if (!dealId) throw new Error("Choose a Print Order first");
      const response = await apiRequest(
        "POST",
        "/api/prints/cost-defaults/apply",
        { ...costDefaultsBody(), confirm: true },
        { headers },
      );
      return (await response.json()) as {
        ok: true;
        preview: CostDefaultsPreview;
        written: Array<{ property: string; value: number }>;
        recalculated: boolean;
        message: string;
      };
    },
    onSuccess: ({ preview, message }) => {
      setCostPreview(preview);
      toast({ title: "Cost defaults written", description: message });
    },
    onError: (error: Error) => {
      toast({
        title: "Cost defaults were not written",
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
  const selectedHasPlates =
    Boolean(selected?.hasPrintFile) ||
    (prints.data?.records ?? []).some((record) => record.hubspotDealId === dealId);
  const writableCostCount = costPreview?.fields.filter((field) => field.willWrite).length ?? 0;

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

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock print-file tracking"
            description="Analyze a Chitubox slice file, attach its production data to a Print Order, and keep your owner code only in this open tab."
            buttonLabel="Unlock print files"
            testIdPrefix="prints"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
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

            <Panel
              title="Default resin rate"
              description="Used only when a CTB has no Chitubox resin price. Prefers your bottle profile, then recent Supplies resin purchases."
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="resin-name">Resin</Label>
                  <Input id="resin-name" value={resinName} onChange={(event) => setResinName(event.target.value)} data-testid="input-resin-name" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resin-asin">Amazon ASIN</Label>
                  <Input id="resin-asin" value={resinAsin} onChange={(event) => setResinAsin(event.target.value)} data-testid="input-resin-asin" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resin-mass">Bottle mass (g)</Label>
                  <Input id="resin-mass" inputMode="decimal" value={resinMassG} onChange={(event) => setResinMassG(event.target.value)} data-testid="input-resin-mass" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resin-price">Bottle price (USD)</Label>
                  <Input id="resin-price" inputMode="decimal" value={resinPrice} onChange={(event) => setResinPrice(event.target.value)} placeholder="35.99" data-testid="input-resin-price" />
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button type="button" onClick={() => saveResin.mutate()} disabled={saveResin.isPending} data-testid="button-save-resin-profile">
                  {saveResin.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDollarSign className="mr-2 h-4 w-4" />}
                  Save resin rate
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => refreshAmazon.mutate()}
                  disabled={refreshAmazon.isPending || !resinAsin.trim()}
                  data-testid="button-refresh-amazon-resin"
                >
                  {refreshAmazon.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Refresh Amazon price
                </Button>
                {resin?.amazonUrl ? (
                  <a
                    href={resin.amazonUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    data-testid="link-amazon-resin"
                  >
                    Open Amazon listing
                  </a>
                ) : null}
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground" data-testid="text-resin-rate-status">
                {resin?.rate
                  ? `Active estimate rate: ${resin.rate.label}`
                  : resin?.suppliesRate
                    ? `No bottle price yet. Supplies fallback ready: ${resin.suppliesRate.label}`
                    : "Save a bottle price or refresh Amazon to estimate plate cost when Chitubox leaves resin cost blank."}
                {" "}
                Amazon live price is best-effort and may be blocked; manual price always works.
              </p>
            </Panel>

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
                    Extracts time, resin use, cost estimate, exposure, and printer settings. Mega 8K plates can be large; only header data is read.
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
                      onChange={(event) => {
                        setDealId(event.target.value);
                        setCostPreview(null);
                      }}
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

            {dealId ? (
              <Panel
                title="3. Apply cost defaults"
                description="Revenue is the quoted order amount. Fill blank cash-cost fields (material, packaging, shipping). Labor stays out by default because it is usually already in your quote."
              >
                <div className="space-y-4" data-testid="panel-cost-defaults">
                  {!selectedHasPlates ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Attach at least one CTB plate to this order first so material can be estimated from plate resin data.
                    </p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="cost-packaging">Packaging default ($)</Label>
                      <Input
                        id="cost-packaging"
                        inputMode="decimal"
                        value={packagingAmount}
                        onChange={(event) => {
                          setPackagingAmount(event.target.value);
                          setCostPreview(null);
                        }}
                        data-testid="input-cost-packaging"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="cost-shipping">Shipping postage ($)</Label>
                      <Input
                        id="cost-shipping"
                        inputMode="decimal"
                        value={shippingAmount}
                        placeholder="Paste from Pirate Ship"
                        disabled={!includeShipping}
                        onChange={(event) => {
                          setShippingAmount(event.target.value);
                          setCostPreview(null);
                        }}
                        data-testid="input-cost-shipping"
                      />
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["material", includeMaterial, setIncludeMaterial, "Material from plate resin estimates"],
                        ["packaging", includePackaging, setIncludePackaging, "Packaging flat default"],
                        ["shipping", includeShipping, setIncludeShipping, "Shipping (paste postage)"],
                        ["labor", includeLabor, setIncludeLabor, "Optional: labor as hours × rate (off — usually in quote)"],
                      ] as const
                    ).map(([key, checked, setChecked, label]) => (
                      <label key={key} className="flex items-start gap-2.5 rounded-md bg-muted/45 p-3 text-xs leading-5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setChecked(event.target.checked);
                            setCostPreview(null);
                          }}
                          className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                          data-testid={`checkbox-cost-${key}`}
                        />
                        <span className="text-muted-foreground">{label}</span>
                      </label>
                    ))}
                  </div>
                  {includeLabor ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="cost-labor-rate">Labor rate ($/hr) — only if you want labor as a separate cost</Label>
                      <Input
                        id="cost-labor-rate"
                        inputMode="decimal"
                        value={laborRate}
                        onChange={(event) => {
                          setLaborRate(event.target.value);
                          setCostPreview(null);
                        }}
                        data-testid="input-cost-labor-rate"
                      />
                    </div>
                  ) : null}
                  <label className="flex items-start gap-2.5 rounded-md bg-muted/45 p-3 text-xs leading-5">
                    <input
                      type="checkbox"
                      checked={overwriteCosts}
                      onChange={(event) => {
                        setOverwriteCosts(event.target.checked);
                        setCostPreview(null);
                      }}
                      className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                      data-testid="checkbox-cost-overwrite"
                    />
                    <span className="text-muted-foreground">
                      Overwrite fields that already have a value in HubSpot. Leave unchecked to fill blanks only.
                    </span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => previewCosts.mutate()}
                      disabled={!dealId || previewCosts.isPending}
                      data-testid="button-preview-cost-defaults"
                    >
                      {previewCosts.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDollarSign className="mr-2 h-4 w-4" />}
                      Preview proposals
                    </Button>
                    <Button
                      type="button"
                      onClick={() => applyCosts.mutate()}
                      disabled={!dealId || !costPreview || writableCostCount === 0 || applyCosts.isPending}
                      data-testid="button-apply-cost-defaults"
                    >
                      {applyCosts.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                      Confirm write to HubSpot
                    </Button>
                  </div>
                  {costPreview ? (
                    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3" data-testid="panel-cost-preview">
                      <p className="text-sm font-medium">
                        {costPreview.dealName}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {costPreview.plateCount} plate{costPreview.plateCount === 1 ? "" : "s"}
                          {costPreview.totalPrintHours != null ? ` · ${costPreview.totalPrintHours}h print time` : ""}
                        </span>
                      </p>
                      <ul className="space-y-2">
                        {costPreview.fields.map((field) => (
                          <li
                            key={field.field}
                            className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2 text-xs last:border-b-0 last:pb-0"
                            data-testid={`row-cost-proposal-${field.field}`}
                          >
                            <div>
                              <p className="font-medium">{field.label}</p>
                              <p className="mt-0.5 text-muted-foreground">{field.source}</p>
                            </div>
                            <div className="text-right">
                              <p className="numeric font-medium">
                                {field.proposed != null ? `$${field.proposed.toFixed(2)}` : "—"}
                              </p>
                              <p className={field.willWrite ? "text-chart-4" : "text-muted-foreground"}>
                                {field.willWrite
                                  ? field.current != null
                                    ? `Will replace $${field.current.toFixed(2)}`
                                    : "Will write"
                                  : field.skipReason || "Skipped"}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {writableCostCount === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Nothing will be written with the current selections. Attach plates, paste shipping, or enable overwrite.
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Confirm writes {writableCostCount} field{writableCostCount === 1 ? "" : "s"} and recalculates profit. Slicer estimates are not actual material cost until you confirm.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              </Panel>
            ) : null}

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
