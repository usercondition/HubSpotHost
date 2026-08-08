import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  CircleDollarSign,
  FilePlus2,
  FileUp,
  FolderOpen,
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
import {
  buildSliceLogUploadFromLinkedFolder,
  getLinkedBlueprintLogsStatus,
  importBlueprintLogsFromFileList,
  unlinkBlueprintLogsDirectory,
  type BlueprintLogsStatus,
} from "@/lib/blueprint-slice-log";
import { readHashQueryParam } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { PlateBitsPanel, type PlateBitSummary } from "@/components/plate-bits-panel";
import type {
  PrintFileCandidateDeal,
  PrintFileMetrics,
  PrintFileOrderSummary,
  PrintFileRecord,
  PrintPlateBit,
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

type PrintFileRecordWithBits = PrintFileRecord & {
  bits: PrintPlateBit[];
  bitSummary: PlateBitSummary;
};

interface PrintsResponse {
  ok: true;
  candidates: PrintFileCandidateDeal[];
  records: PrintFileRecordWithBits[];
  includeAttached: boolean;
  resin?: ResinProfileResponse;
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

const SLICE_LOG_MEMORY_KEY = "hubspot-print-slice-log-v1";
const SLICE_LOG_MEMORY_MAX_CHARS = 2 * 1024 * 1024;

function isSliceLogFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name === "slice.log" || /^slice(?:-.*)?\.log$/.test(name);
}

function isPlateFile(file: File): boolean {
  return /\.(ctb|ultx)$/i.test(file.name);
}

function readRememberedSliceLog(): { name: string; text: string } | null {
  try {
    const raw = sessionStorage.getItem(SLICE_LOG_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { name?: string; text?: string };
    if (!parsed?.text || !parsed?.name) return null;
    return { name: parsed.name, text: parsed.text };
  } catch {
    return null;
  }
}

function rememberSliceLog(name: string, text: string): void {
  const clipped =
    text.length > SLICE_LOG_MEMORY_MAX_CHARS ? text.slice(text.length - SLICE_LOG_MEMORY_MAX_CHARS) : text;
  sessionStorage.setItem(SLICE_LOG_MEMORY_KEY, JSON.stringify({ name, text: clipped, savedAt: Date.now() }));
}

export default function Prints() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sliceLogInputRef = useRef<HTMLInputElement>(null);
  const logsFolderInputRef = useRef<HTMLInputElement>(null);
  /** ULTX waiting while the user re-picks Blueprint logs (AppData cannot auto-refresh). */
  const pendingUltxRef = useRef<File | null>(null);
  const awaitingLogsRefreshRef = useRef(false);
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Print files unlocked',
    successDescription: 'Attach CTB plates and seed cost estimates on open Print Orders.',
  });
  const [includeAttached, setIncludeAttached] = useState(true);
  const [staged, setStaged] = useState<StagedPrintFile | null>(null);
  const [dealId, setDealId] = useState(() => readHashQueryParam("dealId") ?? "");
  const [dragging, setDragging] = useState(false);
  const [sliceLogName, setSliceLogName] = useState<string | null>(() => readRememberedSliceLog()?.name ?? null);
  const [logsLink, setLogsLink] = useState<BlueprintLogsStatus>({ supported: true, ready: false });
  const [linkingLogs, setLinkingLogs] = useState(false);
  const [awaitingLogsRefresh, setAwaitingLogsRefresh] = useState(false);
  const [resinName, setResinName] = useState("ELEGOO ABS-Like 3.0 Space Grey");
  const [resinAsin, setResinAsin] = useState("B0D6Y6JV42");
  const [resinMassG, setResinMassG] = useState("1000");
  const [resinPrice, setResinPrice] = useState("");

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

  useEffect(() => {
    let cancelled = false;
    void getLinkedBlueprintLogsStatus().then((status) => {
      if (!cancelled) setLogsLink(status);
    });
    return () => {
      cancelled = true;
    };
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


  const analyze = useMutation({
    mutationFn: async ({ file, sliceLog }: { file: File; sliceLog?: File | null }) => {
      const form = new FormData();
      form.append("file", file);
      let appliedLog: File | null = sliceLog ?? null;
      if (!appliedLog && /\.ultx$/i.test(file.name)) {
        appliedLog = await buildSliceLogUploadFromLinkedFolder(file.name);
        if (!appliedLog) {
          const remembered = readRememberedSliceLog();
          if (remembered) {
            appliedLog = new File([remembered.text], remembered.name || "Slice.log", {
              type: "text/plain",
            });
          }
        } else {
          // Keep a session copy so re-analyzes work even if folder permission lapses mid-session.
          void appliedLog.text().then((text) => {
            rememberSliceLog(appliedLog!.name, text);
            setSliceLogName(appliedLog!.name);
          });
        }
      }
      if (appliedLog) form.append("sliceLog", appliedLog);
      const response = await apiRequest("POST", "/api/prints/analyze", form, { headers });
      return (await response.json()) as { ok: true; sliceLogApplied?: boolean } & StagedPrintFile;
    },
    onSuccess: ({ analysisId, metrics, expiresAt, sliceLogApplied }) => {
      setStaged({ analysisId, metrics, expiresAt });
      const fromLog = /estimates from slice\.log/i.test(metrics.formatRevision || "");
      toast({
        title: fromLog || sliceLogApplied ? "Plate data extracted from Slice.log" : "Plate data extracted",
        description: fromLog
          ? "Time and resin came from the Blueprint Slice.log. Choose the matching Print Order, then attach."
          : "Choose the matching Print Order, then attach the production plan.",
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

  const finishPendingUltxAnalyze = () => {
    const pending = pendingUltxRef.current;
    pendingUltxRef.current = null;
    awaitingLogsRefreshRef.current = false;
    setAwaitingLogsRefresh(false);
    if (pending) {
      setStaged(null);
      analyze.mutate({ file: pending, sliceLog: null });
    }
  };

  const importLogsFolder = async (fileList: ArrayLike<File> | null) => {
    if (!fileList || fileList.length === 0) return;
    const hadPendingUltx = Boolean(pendingUltxRef.current && awaitingLogsRefreshRef.current);
    // Claim the pending ULTX immediately so the cancel/focus timeout cannot race.
    if (hadPendingUltx) {
      awaitingLogsRefreshRef.current = false;
      setAwaitingLogsRefresh(false);
    }
    setLinkingLogs(true);
    try {
      const cache = await importBlueprintLogsFromFileList(fileList);
      setLogsLink({
        supported: true,
        ready: true,
        source: "import",
        name: cache.rootLabel,
        fileCount: cache.candidates.length,
        importedAt: cache.importedAt,
      });
      if (hadPendingUltx) {
        toast({
          title: "Logs refreshed",
          description: `Cached ${cache.candidates.length} Slice.log file(s). Analyzing the plate…`,
        });
        finishPendingUltxAnalyze();
      } else {
        toast({
          title: "Blueprint logs refreshed",
          description: `Cached ${cache.candidates.length} Slice.log file(s) from “${cache.rootLabel}”. Drop a .ultx when ready.`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Logs were not imported";
      toast({
        title: "Could not refresh Blueprint logs",
        description: message.slice(0, 240),
        variant: "destructive",
      });
      // Still analyze the waiting plate with whatever cache we already have.
      if (hadPendingUltx) finishPendingUltxAnalyze();
    } finally {
      setLinkingLogs(false);
    }
  };

  /** AppData imports are snapshots — ask for a fresh folder pick before each .ultx when possible. */
  const promptLogsRefreshThenAnalyze = (plate: File, sliceLog: File | null) => {
    if (sliceLog || !/\.ultx$/i.test(plate.name)) {
      setStaged(null);
      analyze.mutate({ file: plate, sliceLog });
      return;
    }
    // Live directory handles re-read on analyze; no picker needed.
    if (logsLink.ready && logsLink.source === "directory") {
      setStaged(null);
      analyze.mutate({ file: plate, sliceLog: null });
      return;
    }

    const input = logsFolderInputRef.current;
    if (!input) {
      setStaged(null);
      analyze.mutate({ file: plate, sliceLog: null });
      return;
    }

    pendingUltxRef.current = plate;
    awaitingLogsRefreshRef.current = true;
    setAwaitingLogsRefresh(true);
    toast({
      title: "Refresh Blueprint logs",
      description: "Select Blueprint Studio\\logs again for the latest Slice.log. Cancel to use the last import.",
    });

    const onWindowFocus = () => {
      window.removeEventListener("focus", onWindowFocus);
      window.setTimeout(() => {
        if (!awaitingLogsRefreshRef.current) return;
        // Folder picker was cancelled — continue with the existing cache.
        finishPendingUltxAnalyze();
      }, 400);
    };
    window.addEventListener("focus", onWindowFocus);
    input.click();
  };

  const openLogsRefreshPicker = () => {
    logsFolderInputRef.current?.click();
  };

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
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
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

  const saveSliceLogFile = async (file: File) => {
    const text = await file.text();
    if (!text.trim()) {
      toast({
        title: "Slice.log was empty",
        description: "Pick the Blueprint project Slice.log that contains Output lines for this plate.",
        variant: "destructive",
      });
      return;
    }
    rememberSliceLog(file.name, text);
    setSliceLogName(file.name);
    // Also merge into the import cache so later plates can match other logs.
    try {
      const cache = await importBlueprintLogsFromFileList([file], { merge: true });
      setLogsLink({
        supported: true,
        ready: true,
        source: "import",
        name: cache.rootLabel,
        fileCount: cache.candidates.length,
        importedAt: cache.importedAt,
      });
    } catch {
      /* session memory still works */
    }
    toast({
      title: "Slice.log ready",
      description: "It will be applied automatically the next time you analyze a .ultx plate.",
    });
  };

  const acceptFiles = async (incoming: FileList | File[] | null | undefined) => {
    const files = incoming ? Array.from(incoming) : [];
    if (!files.length) return;

    const plate = files.find(isPlateFile);
    const sliceLogs = files.filter(isSliceLogFile);
    const folderDrop = files.some((file) => (file.webkitRelativePath || "").includes("/"));

    // Explorer drag of Blueprint logs (or a multi-log drop) — Chrome allows this even for AppData.
    if (!plate && (folderDrop || sliceLogs.length > 1)) {
      await importLogsFolder(files as unknown as FileList);
      return;
    }

    if (sliceLogs[0]) {
      await saveSliceLogFile(sliceLogs[0]);
    }

    if (!plate) {
      if (!sliceLogs.length) {
        toast({
          title: "Unrecognized file",
          description: "Drop a .ctb / .ultx plate, a Blueprint Slice.log, or the whole logs folder from Explorer.",
          variant: "destructive",
        });
      }
      return;
    }

    promptLogsRefreshThenAnalyze(plate, sliceLogs[0] ?? null);
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
                    Attach each `.ctb` or `.ultx` plate to the same Print Order. Print Operations keeps a plate-by-plate history, while HubSpot shows running totals for plate count, time, resin volume, resin mass, and slicer resin cost. Machine names also feed the Printer fleet page.
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
              <Panel
                title="1. Analyze one sliced plate"
                description="Drop a .ctb/.ultx plate. For HeyGears: drag Blueprint Studio\\logs from File Explorer onto this page (Chrome blocks AppData folder pickers)."
              >
                <input
                  ref={fileInputRef}
                  id="print-file-input"
                  type="file"
                  multiple
                  accept=".ctb,.ultx,.log,application/octet-stream,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    void acceptFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  data-testid="input-print-file"
                />
                <input
                  ref={sliceLogInputRef}
                  id="slice-log-input"
                  type="file"
                  multiple
                  accept=".log,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    const picked = event.target.files;
                    if (!picked?.length) return;
                    if (picked.length === 1) {
                      void saveSliceLogFile(picked[0]!);
                    } else {
                      void importLogsFolder(picked);
                    }
                    event.currentTarget.value = "";
                  }}
                  data-testid="input-slice-log"
                />
                <input
                  ref={(element) => {
                    logsFolderInputRef.current = element;
                    if (element) {
                      element.setAttribute("webkitdirectory", "");
                      element.setAttribute("directory", "");
                    }
                  }}
                  id="blueprint-logs-folder-input"
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    void importLogsFolder(event.target.files);
                    event.currentTarget.value = "";
                  }}
                  data-testid="input-blueprint-logs-folder"
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
                    void acceptFiles(event.dataTransfer.files);
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
                    {awaitingLogsRefresh || linkingLogs
                      ? "Refreshing Blueprint logs…"
                      : analyze.isPending
                        ? "Reading slice data…"
                        : logsLink.ready
                          ? "Drop a .ultx plate — you’ll be asked to refresh logs first"
                          : "Drop a .ctb / .ultx plate, or drag the Blueprint logs folder here"}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    Layer count comes from the ULTX archive. Time and resin come from Slice.log. Dropping a .ultx
                    prompts a logs refresh (Chrome can’t watch AppData). Or drag{" "}
                    <span className="font-medium text-foreground">Blueprint Studio\logs</span> from Explorer anytime.
                  </span>
                </button>
                <div
                  className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                  data-testid="status-blueprint-logs-link"
                >
                  <span className="text-muted-foreground">
                    {logsLink.ready && logsLink.source === "import" ? (
                      <>
                        Imported logs:{" "}
                        <span className="font-medium text-foreground">{logsLink.name}</span>
                        {" · "}
                        {logsLink.fileCount} Slice.log
                        {" · "}
                        {new Date(logsLink.importedAt).toLocaleString()}
                      </>
                    ) : logsLink.ready && logsLink.source === "directory" ? (
                      <>
                        Linked logs folder:{" "}
                        <span className="font-medium text-foreground">{logsLink.name}</span>
                        {" · live on each analyze"}
                      </>
                    ) : (
                      <>
                        Drag <span className="font-medium text-foreground">%APPDATA%\Blueprint Studio\logs</span> from
                        Explorer onto the drop zone (or use Refresh logs).
                      </>
                    )}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      disabled={linkingLogs || analyze.isPending}
                      onClick={() => openLogsRefreshPicker()}
                      data-testid="button-import-blueprint-logs"
                    >
                      {linkingLogs ? "Refreshing…" : logsLink.ready ? "Refresh logs" : "Import logs"}
                    </button>
                    {logsLink.ready ? (
                      <button
                        type="button"
                        className="text-muted-foreground underline-offset-2 hover:underline"
                        disabled={linkingLogs || analyze.isPending}
                        onClick={() => {
                          void unlinkBlueprintLogsDirectory().then(() => {
                            setLogsLink({ supported: true, ready: false });
                            toast({
                              title: "Blueprint logs cleared",
                              description: "ULTX analyzes will need a fresh import or a manual Slice.log.",
                            });
                          });
                        }}
                        data-testid="button-unlink-blueprint-logs"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </div>
                {sliceLogName ? (
                  <div
                    className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                    data-testid="status-slice-log-ready"
                  >
                    <span className="text-muted-foreground">
                      Slice.log ready: <span className="font-medium text-foreground">{sliceLogName}</span> (auto-applied to .ultx)
                    </span>
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => {
                        sessionStorage.removeItem(SLICE_LOG_MEMORY_KEY);
                        setSliceLogName(null);
                      }}
                      data-testid="button-clear-slice-log"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={analyze.isPending}
                    data-testid="button-browse-print-file"
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Browse for a plate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openLogsRefreshPicker()}
                    disabled={analyze.isPending || linkingLogs}
                    data-testid="button-import-blueprint-logs-outline"
                  >
                    <FolderOpen className="mr-2 h-4 w-4" />
                    {linkingLogs ? "Refreshing…" : logsLink.ready ? "Refresh logs" : "Import logs"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => sliceLogInputRef.current?.click()}
                    disabled={analyze.isPending}
                    data-testid="button-browse-slice-log"
                  >
                    <FileUp className="mr-2 h-4 w-4" />
                    {sliceLogName ? "Replace Slice.log" : "Add Slice.log"}
                  </Button>
                </div>
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
                  <StatusPill
                    tone="good"
                    icon={CheckCircle2}
                    label={staged.metrics.format === "ULTX" ? "ULTX analyzed" : "CTB analyzed"}
                    testId="status-ctb-analyzed"
                  />
                </div>
                {staged.metrics.formatRevision.toLowerCase().includes("encrypted") ||
                staged.metrics.formatRevision.toLowerCase().includes("decrypted") ||
                staged.metrics.formatRevision.toLowerCase().includes("sealed") ||
                staged.metrics.formatRevision.toLowerCase().includes("slice.log") ? (
                  <p className="text-xs leading-5 text-muted-foreground" data-testid="text-encrypted-ctb-note">
                    {staged.metrics.formatRevision.toLowerCase().includes("estimates from slice.log")
                      ? `Filled time/resin from Blueprint Slice.log (${staged.metrics.formatRevision}).`
                      : staged.metrics.formatRevision.toLowerCase().includes("sealed")
                        ? `HeyGears metadata is still sealed in this ULTX (${staged.metrics.formatRevision}). Drop the matching Blueprint Slice.log above (or with the plate) — it is remembered for later .ultx uploads in this session.`
                        : `Encrypted slice settings were handled in memory for this plate (${staged.metrics.formatRevision}).`}
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

            <Panel
              title="Recent plate history"
              description="Each attached CTB is a plate. Drop the .stl parts that were on that plate to track good vs reprint."
            >
              {prints.data.records.length ? (
                <div className="space-y-3" data-testid="list-print-records">
                  {prints.data.records.map((record) => (
                    <article
                      key={record.id}
                      className="rounded-md border border-card-border bg-card p-4"
                      data-testid={`row-print-record-${record.id}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold tracking-tight">{record.hubspotDealName}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{record.dealStage}</p>
                          <p className="mt-2 truncate text-sm font-medium" title={record.fileName}>
                            {record.fileName}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {fileSize(record.fileSizeBytes)} · {record.printerProfile || "No printer profile"}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                          <div>
                            <p className="text-muted-foreground">Time</p>
                            <p className="numeric font-medium">{formatHours(record.printTimeSeconds)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Resin</p>
                            <p className="numeric font-medium">
                              {formatNumber(record.resinVolumeMl, " ml")} · {formatNumber(record.resinMassG, " g")}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Slicer cost</p>
                            <p className="numeric font-medium">{formatMoney(record.resinCost)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Synced</p>
                            <p className="font-medium text-chart-4">{localDate(record.hubspotSyncedAt)}</p>
                          </div>
                        </div>
                      </div>
                      <PlateBitsPanel
                        recordId={record.id}
                        bits={record.bits ?? []}
                        bitSummary={
                          record.bitSummary ?? { total: 0, onPlate: 0, good: 0, reprint: 0 }
                        }
                        headers={headers}
                        onChanged={() => {
                          queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
                          queryClient.invalidateQueries({ queryKey: ["/api/order-parts/summaries"] });
                        }}
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="py-7 text-center">
                  <Layers3 className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">No plates attached yet</p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    Attach a CTB first. Then drop the .stl parts that were on that plate to track QC.
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
