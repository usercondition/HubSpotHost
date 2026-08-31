import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Clock3,
  CircleDollarSign,
  ExternalLink,
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
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { parseApiError } from "@/lib/api-error";
import { describeCtbUploadPlan, isCtbFileName } from "@/lib/ctb-prefix";
import {
  BLUEPRINT_STUDIO_LOGS_ENV_PATH,
  BLUEPRINT_STUDIO_LOGS_EXAMPLE_PATH,
  getLinkedBlueprintLogsStatus,
  importBlueprintLogsFromFileList,
  unlinkBlueprintLogsDirectory,
  type BlueprintLogsStatus,
} from "@/lib/blueprint-slice-log";
import {
  analyzePrintPlate,
  attachPrintPlate,
  assertAttachPrinterReady,
  clearRememberedSliceLog,
  initialAttachPrinterId,
  isPlateFile,
  isSliceLogFile,
  readRememberedSliceLog,
  rememberSliceLog,
  type PrinterMatchInfo,
} from "@/lib/print-attach";
import { readHashQueryParam } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import { PlateBitsPanel, type PlateBitSummary } from "@/components/plate-bits-panel";
import type {
  PrintFileCandidateDeal,
  PrintFileDealBoard,
  PrintFileMetrics,
  PrintFileOrderSummary,
  PrintFileRecord,
  PrintPlateBit,
  ResinProfile,
} from "@shared/schema";

interface ResinRateView {
  source: "amazon" | "supplies" | "manual" | "inventory";
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
  inventoryRate?: ResinRateView | null;
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
  boards: PrintFileDealBoard[];
  includeAttached: boolean;
  lastAttachedDealId: string | null;
  attachPreview: PrintFileOrderSummary | null;
  resin?: ResinProfileResponse;
}

interface StagedPrintFile {
  analysisId: string;
  metrics: PrintFileMetrics;
  expiresAt: string;
  printerMatch?: PrinterMatchInfo;
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
  return "No resin price in the slice file and no active bottle / profile rate yet";
}

function FileMetrics({ metrics }: { metrics: PrintFileMetrics }) {
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Extracted plate metrics">
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
  const sliceLogInputRef = useRef<HTMLInputElement>(null);
  const logsFolderInputRef = useRef<HTMLInputElement>(null);
  /** ULTX waiting while the user re-picks Blueprint logs (AppData cannot auto-refresh). */
  const pendingUltxRef = useRef<File | null>(null);
  const awaitingLogsRefreshRef = useRef(false);
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Print files unlocked',
    successDescription: 'Attach slice plates and seed cost estimates on open Print Orders.',
  });
  const [includeAttached, setIncludeAttached] = useState(true);
  const [staged, setStaged] = useState<StagedPrintFile | null>(null);
  const [dealId, setDealId] = useState(() => readHashQueryParam("dealId") ?? "");
  const [dragging, setDragging] = useState(false);
  const [sliceLogName, setSliceLogName] = useState<string | null>(() => readRememberedSliceLog()?.name ?? null);
  const [logsLink, setLogsLink] = useState<BlueprintLogsStatus>({ supported: true, ready: false });
  const [linkingLogs, setLinkingLogs] = useState(false);
  const [awaitingLogsRefresh, setAwaitingLogsRefresh] = useState(false);
  const [attachPrinterId, setAttachPrinterId] = useState("");
  const [resinName, setResinName] = useState("ELEGOO ABS-Like 3.0 Space Grey");
  const [resinAsin, setResinAsin] = useState("B0D6Y6JV42");
  const [resinMassG, setResinMassG] = useState("1000");
  const [resinPrice, setResinPrice] = useState("");
  const [resinRateOpen, setResinRateOpen] = useState(false);
  const [showAllPlateHistory, setShowAllPlateHistory] = useState(false);
  const [logsPathCopied, setLogsPathCopied] = useState(false);
  const [includeMaterial, setIncludeMaterial] = useState(true);
  const [includeLabor, setIncludeLabor] = useState(false);
  const [includePackaging, setIncludePackaging] = useState(true);
  const [includeShipping, setIncludeShipping] = useState(false);
  const [overwriteCosts, setOverwriteCosts] = useState(false);
  const [laborRate, setLaborRate] = useState("0");
  const [packagingAmount, setPackagingAmount] = useState("0");
  const [shippingAmount, setShippingAmount] = useState("");
  const [costPreview, setCostPreview] = useState<CostDefaultsPreview | null>(null);
  const existingCostsSeeded = useRef(false);

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
    queryKey: ["/api/prints", ownerCode, includeAttached, dealId, staged?.analysisId],
    enabled: isUnlocked,
    queryFn: async () => {
      const query = new URLSearchParams({
        includeAttached: includeAttached ? "true" : "false",
      });
      if (dealId) query.set("previewDealId", dealId);
      if (staged?.analysisId) query.set("previewAnalysisId", staged.analysisId);
      const response = await apiRequest(
        "GET",
        `/api/prints?${query.toString()}`,
        undefined,
        { headers },
      );
      return (await response.json()) as PrintsResponse;
    },
  });

  const seedExistingCosts = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/prints/seed-costs", {}, { headers });
      return (await response.json()) as { ok: true; processed: number; seeded: number };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      if (result.seeded > 0) {
        toast({
          title: "Existing plate costs synced",
          description: `${result.seeded} Print Order${result.seeded === 1 ? "" : "s"} received missing cost defaults.`,
        });
      }
    },
  });

  useEffect(() => {
    if (!isUnlocked || !prints.data || existingCostsSeeded.current) return;
    existingCostsSeeded.current = true;
    seedExistingCosts.mutate();
  }, [isUnlocked, prints.data, seedExistingCosts]);

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
    mutationFn: async ({ file, sliceLog }: { file: File; sliceLog?: File | null }) =>
      analyzePrintPlate(file, {
        headers,
        sliceLog,
        onSliceLogApplied: (name) => setSliceLogName(name),
      }),
    onSuccess: ({ analysisId, metrics, expiresAt, sliceLogApplied, printerMatch }) => {
      setAnalyzeStatus("");
      setStaged({ analysisId, metrics, expiresAt, printerMatch });
      setAttachPrinterId(initialAttachPrinterId(printerMatch));
      const fromLog = /estimates from slice\.log/i.test(metrics.formatRevision || "");
      toast({
        title: fromLog || sliceLogApplied ? "Plate data extracted from Slice.log" : "Plate data extracted",
        description: printerMatch?.requiresPrinterChoice
          ? "Chitubox only reported a shared model name — choose which physical printer ran this plate before attaching."
          : fromLog
            ? "Time and resin came from the Blueprint Slice.log. Choose the matching Print Order, then attach."
            : "Choose the matching Print Order, then attach the production plan.",
      });
    },
    onError: (error: Error) => {
      setStaged(null);
      setAnalyzeStatus("");
      const { status, message } = parseApiError(error);
      const description =
        /upstream|bad gateway|gateway timeout|networkerror|failed to fetch/i.test(message) ||
        status === 502 ||
        status === 504
          ? "The host proxy timed out before the plate finished uploading. Retry — Mega 8K CTBs now send only a small header sample."
          : message.slice(0, 220);
      toast({
        title: "That slice file could not be analyzed",
        description,
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
      if (!staged) throw new Error("Analyze a plate before attaching it");
      assertAttachPrinterReady(staged.printerMatch, attachPrinterId);
      return attachPrintPlate({
        analysisId: staged.analysisId,
        dealId,
        printerId: attachPrinterId ? Number(attachPrinterId) : null,
        headers,
      });
    },
    onSuccess: ({ summary, message }) => {
      setStaged(null);
      setAttachPrinterId("");
      setIncludeAttached(true);
      setCostPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/printers"] });
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

  const detach = useMutation({
    mutationFn: async (recordId: number) => {
      const response = await apiRequest(
        "POST",
        "/api/prints/detach",
        { recordId, confirm: true },
        { headers },
      );
      return (await response.json()) as { ok: true; message: string };
    },
    onSuccess: ({ message }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      toast({ title: "Plate detached", description: message });
    },
    onError: (error: Error) => {
      toast({
        title: "The plate was not detached",
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

  const [analyzeStatus, setAnalyzeStatus] = useState("");

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

    setAnalyzeStatus(isCtbFileName(plate.name) ? describeCtbUploadPlan(plate) : "Reading slice data…");
    promptLogsRefreshThenAnalyze(plate, sliceLogs[0] ?? null);
  };

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
      const response = await apiRequest("POST", "/api/prints/cost-defaults/preview", costDefaultsBody(), { headers });
      return (await response.json()) as { ok: true; preview: CostDefaultsPreview };
    },
    onSuccess: ({ preview }) => {
      setCostPreview(preview);
      setLaborRate(String(preview.laborRatePerHour));
      setPackagingAmount(String(preview.packagingAmount));
    },
    onError: (error: Error) => {
      setCostPreview(null);
      toast({ title: "Could not preview cost defaults", description: error.message.replace(/^\d+:\s*/, "").slice(0, 240), variant: "destructive" });
    },
  });

  const applyCosts = useMutation({
    mutationFn: async () => {
      if (!dealId) throw new Error("Choose a Print Order first");
      const response = await apiRequest("POST", "/api/prints/cost-defaults/apply", { ...costDefaultsBody(), confirm: true }, { headers });
      return (await response.json()) as { ok: true; preview: CostDefaultsPreview; message: string };
    },
    onSuccess: ({ preview, message }) => {
      setCostPreview(preview);
      toast({ title: "Cost defaults written", description: message });
    },
    onError: (error: Error) => {
      toast({ title: "Cost defaults were not written", description: error.message.replace(/^\d+:\s*/, "").slice(0, 240), variant: "destructive" });
    },
  });

  const candidates = prints.data?.candidates ?? [];
  const boards = prints.data?.boards ?? [];
  const selected = candidates.find((candidate) => candidate.dealId === dealId);
  const attachPreview = prints.data?.attachPreview;
  const selectedHasPlates =
    Boolean(selected?.hasPrintFile) ||
    (prints.data?.records ?? []).some((record) => record.hubspotDealId === dealId);
  const writableCostCount = costPreview?.fields.filter((field) => field.willWrite).length ?? 0;

  const plateHistoryRecords = useMemo(() => {
    const records = prints.data?.records ?? [];
    if (!dealId || showAllPlateHistory) return records;
    return records.filter((record) => record.hubspotDealId === dealId);
  }, [prints.data?.records, dealId, showAllPlateHistory]);

  const hiddenOtherDealCount = useMemo(() => {
    const records = prints.data?.records ?? [];
    if (!dealId || showAllPlateHistory) return 0;
    return records.filter((record) => record.hubspotDealId !== dealId).length;
  }, [prints.data?.records, dealId, showAllPlateHistory]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Prints"
        subtitle="Analyze a .ctb / .ultx plate, attach metrics to a Print Order, then track part QC."
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

            <section
              className="rounded-lg border border-border bg-card"
              data-testid="panel-default-resin-rate"
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  className="inline-flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setResinRateOpen((open) => !open)}
                  aria-expanded={resinRateOpen}
                  data-testid="button-toggle-resin-rate"
                >
                  {resinRateOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="shrink-0 text-sm font-semibold tracking-tight">Resin rate</span>
                  <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    data-testid="text-resin-rate-status"
                  >
                    {resin?.rate
                      ? resin.rate.label
                      : resin?.inventoryRate
                        ? `Inventory · ${resin.inventoryRate.label}`
                        : resin?.suppliesRate
                          ? `Supplies · ${resin.suppliesRate.label}`
                          : "No fallback rate yet — expand to set bottle price"}
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => refreshAmazon.mutate()}
                    disabled={refreshAmazon.isPending || !resinAsin.trim()}
                    data-testid="button-refresh-amazon-resin"
                  >
                    {refreshAmazon.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1.5 hidden sm:inline">Amazon</span>
                  </Button>
                  {resin?.amazonUrl ? (
                    <Button asChild type="button" size="sm" variant="ghost">
                      <a
                        href={resin.amazonUrl}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="link-amazon-resin"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span className="ml-1.5 hidden sm:inline">Listing</span>
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>

              {resinRateOpen ? (
                <div className="space-y-3 border-t border-border px-3 py-3">
                  <p className="text-[0.6875rem] leading-4 text-muted-foreground">
                    Fallback when a CTB has no Chitubox resin price. Bottle profile → inventory → Supplies.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <Label htmlFor="resin-name" className="text-[0.6875rem]">
                        Resin
                      </Label>
                      <Input
                        id="resin-name"
                        className="h-8"
                        value={resinName}
                        onChange={(event) => setResinName(event.target.value)}
                        data-testid="input-resin-name"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="resin-asin" className="text-[0.6875rem]">
                        Amazon ASIN
                      </Label>
                      <Input
                        id="resin-asin"
                        className="h-8"
                        value={resinAsin}
                        onChange={(event) => setResinAsin(event.target.value)}
                        data-testid="input-resin-asin"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="resin-mass" className="text-[0.6875rem]">
                        Bottle mass (g)
                      </Label>
                      <Input
                        id="resin-mass"
                        className="h-8"
                        inputMode="decimal"
                        value={resinMassG}
                        onChange={(event) => setResinMassG(event.target.value)}
                        data-testid="input-resin-mass"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="resin-price" className="text-[0.6875rem]">
                        Bottle price (USD)
                      </Label>
                      <Input
                        id="resin-price"
                        className="h-8"
                        inputMode="decimal"
                        value={resinPrice}
                        onChange={(event) => setResinPrice(event.target.value)}
                        placeholder="35.99"
                        data-testid="input-resin-price"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveResin.mutate()}
                      disabled={saveResin.isPending}
                      data-testid="button-save-resin-profile"
                    >
                      {saveResin.isPending ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CircleDollarSign className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Save rate
                    </Button>
                    <p className="text-[0.6875rem] text-muted-foreground">
                      Amazon price is best-effort; manual price always works. Attach still burns the open bottle.
                    </p>
                  </div>
                </div>
              ) : null}
            </section>

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
                        ? analyzeStatus || "Reading slice data…"
                        : logsLink.ready
                          ? "Drop a .ultx plate — you’ll be asked to refresh logs first"
                          : "Drop a .ctb / .ultx plate, or drag the Blueprint logs folder here"}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    Layer count comes from the ULTX archive. Time and resin come from Slice.log. Large Mega 8K CTBs
                    send only a ~2 MB header sample (full plate never hits the proxy). Dropping a .ultx prompts a logs
                    refresh (Chrome can’t watch AppData). Or drag{" "}
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
                        Drag the Blueprint logs folder from Explorer onto the drop zone (or use Refresh logs).
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
                <div
                  className="mt-2 rounded-md border border-border bg-card px-3 py-2.5"
                  data-testid="panel-blueprint-logs-path"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="rule-label">HeyGears / ULTX logs folder</p>
                      <p className="mt-1 break-all font-mono text-xs font-medium text-foreground" data-testid="text-blueprint-logs-path">
                        {BLUEPRINT_STUDIO_LOGS_ENV_PATH}
                      </p>
                      <p className="mt-1 text-[0.6875rem] leading-4 text-muted-foreground">
                        Paste into Explorer or Win+R. Usually expands to{" "}
                        <span className="font-mono text-foreground/80">{BLUEPRINT_STUDIO_LOGS_EXAMPLE_PATH}</span>
                        . Drag that folder here after each slice so time/resin can fill from Slice.log.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0"
                      onClick={() => {
                        void (async () => {
                          try {
                            await navigator.clipboard.writeText(BLUEPRINT_STUDIO_LOGS_ENV_PATH);
                            setLogsPathCopied(true);
                            window.setTimeout(() => setLogsPathCopied(false), 2000);
                            toast({
                              title: "Logs path copied",
                              description: "Paste it into File Explorer’s address bar.",
                            });
                          } catch {
                            toast({
                              title: "Copy was blocked",
                              description: `Select and copy: ${BLUEPRINT_STUDIO_LOGS_ENV_PATH}`,
                              variant: "destructive",
                            });
                          }
                        })();
                      }}
                      data-testid="button-copy-blueprint-logs-path"
                    >
                      {logsPathCopied ? (
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {logsPathCopied ? "Copied" : "Copy path"}
                    </Button>
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
                        clearRememberedSliceLog();
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
                {attachPreview && selected ? (
                  <div className="rounded-lg border border-primary/25 bg-primary/5 p-4" data-testid="panel-attach-preview">
                    <p className="text-sm font-semibold">Attach preview for {selected.dealName}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      This attach would make {attachPreview.plateCount} plate{attachPreview.plateCount === 1 ? "" : "s"} ·{" "}
                      {formatHours(attachPreview.totalPrintTimeSeconds)} ·{" "}
                      {formatNumber(attachPreview.totalResinVolumeMl, " ml")} ·{" "}
                      ${formatMoney(attachPreview.totalResinCost)} estimated resin.
                    </p>
                  </div>
                ) : null}
                {staged.printerMatch ? (
                  <div
                    className="space-y-2 rounded-lg border border-border bg-muted/30 p-4"
                    data-testid="panel-attach-printer"
                  >
                    <Label htmlFor="attach-printer-select">Which printer ran this plate?</Label>
                    <select
                      id="attach-printer-select"
                      value={attachPrinterId}
                      onChange={(event) => setAttachPrinterId(event.target.value)}
                      className="flex h-10 w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      data-testid="select-attach-printer"
                    >
                      <option value="">
                        {staged.printerMatch.requiresPrinterChoice
                          ? "Choose NEWX1 / NEWX2 / NEWX3 / …"
                          : "Use auto-matched printer"}
                      </option>
                      {staged.printerMatch.printers.map((printer) => (
                        <option key={printer.id} value={String(printer.id)}>
                          {printer.name}
                          {staged.printerMatch?.matchedPrinterId === printer.id ? " · matched" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Slicer reported{" "}
                      <span className="font-medium text-foreground">
                        {staged.printerMatch.slicerProfile || "no machine name"}
                      </span>
                      . Chitubox often writes only the model (Mighty 8K), not your custom NEWX names — pick the
                      physical unit so Printers hours stay accurate. Tip: rename each machine in Chitubox to include
                      NEWX1 / NEWX2 / NEWX3 so future plates auto-match.
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-col justify-between gap-3 rounded-lg border border-card-border bg-card p-4 sm:flex-row sm:items-center">
                  <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
                    These figures describe the complete build plate. Do not use them as the order’s actual material cost when a plate contains more than one customer’s work.
                  </p>
                  <Button
                    onClick={() => attach.mutate()}
                    disabled={
                      !dealId ||
                      attach.isPending ||
                      Boolean(staged.printerMatch?.requiresPrinterChoice && !attachPrinterId)
                    }
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
                      <Input id="cost-packaging" inputMode="decimal" value={packagingAmount} onChange={(event) => { setPackagingAmount(event.target.value); setCostPreview(null); }} data-testid="input-cost-packaging" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="cost-shipping">Shipping postage ($)</Label>
                      <Input id="cost-shipping" inputMode="decimal" value={shippingAmount} placeholder="Paste from Pirate Ship" disabled={!includeShipping} onChange={(event) => { setShippingAmount(event.target.value); setCostPreview(null); }} data-testid="input-cost-shipping" />
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
                    <input type="checkbox" checked={overwriteCosts} onChange={(event) => { setOverwriteCosts(event.target.checked); setCostPreview(null); }} className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring" data-testid="checkbox-cost-overwrite" />
                    <span className="text-muted-foreground">Overwrite existing HubSpot cost fields. Leave off to fill blanks only.</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" onClick={() => previewCosts.mutate()} disabled={previewCosts.isPending} data-testid="button-preview-cost-defaults">
                      {previewCosts.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CircleDollarSign className="mr-2 h-4 w-4" />}Preview proposals
                    </Button>
                    <Button type="button" onClick={() => applyCosts.mutate()} disabled={!costPreview || writableCostCount === 0 || applyCosts.isPending} data-testid="button-apply-cost-defaults">
                      {applyCosts.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Confirm write to HubSpot
                    </Button>
                  </div>
                  {costPreview ? (
                    <ul className="space-y-2 rounded-md border border-border bg-muted/20 p-3" data-testid="panel-cost-preview">
                      {costPreview.fields.map((field) => (
                        <li key={field.field} className="flex flex-wrap items-baseline justify-between gap-2 text-xs" data-testid={`row-cost-proposal-${field.field}`}>
                          <span><span className="font-medium">{field.label}</span><span className="ml-2 text-muted-foreground">{field.source}</span></span>
                          <span className={field.willWrite ? "text-chart-4" : "text-muted-foreground"}>{field.willWrite ? `Will write $${field.proposed?.toFixed(2)}` : field.skipReason || "Skipped"}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Panel>
            ) : null}

            <Panel
              title="Order plate boards"
              description="Attached plates grouped by Print Order. Detaching is confirmed and updates only the order's HubSpot production-planning totals."
            >
              {boards.length ? (
                <div className="space-y-3" data-testid="list-print-deal-boards">
                  {boards.map((board) => (
                    <article key={board.dealId} className="rounded-md border border-card-border bg-card p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{board.dealName}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{board.dealStage}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                          <span>{board.plateCount} plate{board.plateCount === 1 ? "" : "s"}</span>
                          <span>{formatHours(board.totalPrintTimeSeconds)}</span>
                          <span>{formatNumber(board.totalResinVolumeMl, " ml")}</span>
                          <span>${formatMoney(board.totalResinCost)}</span>
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        {board.records.map((record) => (
                          <div key={record.id} className="flex items-center justify-between gap-3 text-xs">
                            <span className="min-w-0 truncate text-muted-foreground">{record.fileName}</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 shrink-0 text-destructive hover:text-destructive"
                              disabled={detach.isPending}
                              onClick={() => {
                                if (window.confirm(`Detach ${record.fileName}? This rebuilds only HubSpot print planning totals.`)) {
                                  detach.mutate(record.id);
                                }
                              }}
                              data-testid={`button-detach-print-${record.id}`}
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" />
                              Detach
                            </Button>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">No plates are attached to an order yet.</p>
              )}
            </Panel>

            <Panel
              title="Recent plate history"
              description="Each attached slice file is a plate. Drop the .stl parts that were on that plate to track good vs reprint and preview meshes locally."
            >
              {dealId && (hiddenOtherDealCount > 0 || showAllPlateHistory) ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {showAllPlateHistory
                      ? "Showing plates for every order."
                      : `Showing plates for the selected order${selected ? ` · ${selected.dealName}` : ""}.`}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setShowAllPlateHistory((value) => !value)}
                    data-testid="button-toggle-all-plate-history"
                  >
                    {showAllPlateHistory
                      ? "Show selected order only"
                      : `Show all orders (${hiddenOtherDealCount} more)`}
                  </Button>
                </div>
              ) : null}
              {plateHistoryRecords.length ? (
                <div className="space-y-3" data-testid="list-print-records">
                  {plateHistoryRecords.map((record) => (
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
                  <p className="mt-2 text-sm font-medium">
                    {dealId && (prints.data?.records.length ?? 0) > 0
                      ? "No plates on the selected order"
                      : "No plates attached yet"}
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                    {dealId && (prints.data?.records.length ?? 0) > 0
                      ? "Attach a plate to this order, or show all orders to QC another deal’s plates."
                      : "Attach a plate first. Then drop the .stl parts that were on that plate to track QC and preview meshes."}
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
