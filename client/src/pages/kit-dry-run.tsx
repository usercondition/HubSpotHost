/**
 * PARKED page — route/nav removed from App/shell.
 * Do not re-enable until attach shares Prints Slice.log + printer + plate-bits path.
 * Live checklist/QC: Orders Parts + Prints plate bits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Link2,
  Package,
  RotateCcw,
  Search,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { StlPreview } from "@/components/stl-preview";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  analyzePrintPlate,
  assertAttachPrinterReady,
  attachPrintPlate,
  initialAttachPrinterId,
} from "@/lib/print-attach";
import { cn } from "@/lib/utils";
import { printsDealHref, readHashQueryParam } from "@/lib/workflow";
import {
  bindKitToDeal,
  buildKitBitsFromImports,
  createEmptyKit,
  createKitFromBits,
  createPlate,
  emptyKitForDeal,
  groupSummaries,
  inventory,
  isLegacySampleKit,
  isPrintable,
  markBitGood,
  markBitReprint,
  markPlateAllGood,
  plateBits,
  type KitBit,
  type KitTracker,
} from "@/lib/kit-dry-run";
import { clearKitStorage, loadKitFromStorage, saveKitToStorage } from "@/lib/kit-persistence";
import { fetchKitFromServer, saveKitToServer } from "@/lib/kit-api";
import {
  beginKitImportFromDataTransfer,
  collectKitFilesFromFileList,
  formatKitImportNote,
  inferKitNameFromImports,
  type KitImportSummary,
} from "@/lib/stl-folder-import";
import type { PrintFileCandidateDeal, PrintFileRecord } from "@shared/schema";

type PrintsListResponse = {
  ok: true;
  candidates: PrintFileCandidateDeal[];
  records: PrintFileRecord[];
};

function initialKit(): KitTracker {
  const dealId = readHashQueryParam("dealId");
  if (dealId) {
    return loadKitFromStorage(dealId) ?? emptyKitForDeal({ dealId, dealName: `Print Order ${dealId}` });
  }
  const saved = loadKitFromStorage(null);
  if (saved && !isLegacySampleKit(saved)) return saved;
  if (saved && isLegacySampleKit(saved)) clearKitStorage(null);
  return createEmptyKit();
}

function statusLabel(bit: KitBit, plateName?: string | null): string {
  switch (bit.status) {
    case "on_plate":
      return plateName ? `On ${plateName}` : "On plate";
    case "good":
      return plateName ? `Good · ${plateName}` : "Good";
    case "reprint":
      return "Reprint";
    default:
      return "Needed";
  }
}

function plateStatusMessage(
  plateName: string,
  bitCount: number,
  awaitingQc: number,
): string {
  if (awaitingQc > 0) {
    return `${plateName} selected — ${bitCount} bit${bitCount === 1 ? "" : "s"} (${awaitingQc} awaiting QC). After print, mark each good or reprint.`;
  }
  return `${plateName} selected — ${bitCount} bit${bitCount === 1 ? "" : "s"}. QC complete for this plate.`;
}

/**
 * Kit tracker bound to a HubSpot Print Order.
 * Import STL kit → select bits → make plate (optional CTB attach) → QC.
 */
export default function KitDryRunPage() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const ctbInputRef = useRef<HTMLInputElement | null>(null);
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Kits unlocked",
    successDescription: "You can link kits to Print Orders and attach plate files.",
  });

  const [kit, setKit] = useState<KitTracker>(() => initialKit());
  const [groupFilter, setGroupFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plateName, setPlateName] = useState("Plate 1");
  const [ctbFileName, setCtbFileName] = useState("Plate_1.ctb");
  const [ctbFile, setCtbFile] = useState<File | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [activePlateId, setActivePlateId] = useState<string | null>(null);
  const [stlByBitId, setStlByBitId] = useState<Record<string, File>>({});
  const [previewBitId, setPreviewBitId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [note, setNote] = useState<string | null>(
    "Choose a Print Order, then drop a kit folder or .zip to load the parts.",
  );
  const [serverSync, setServerSync] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const skipNextServerSave = useRef(false);
  const serverLoadToken = useRef(0);
  /** Bumped on every local kit edit so in-flight server loads cannot clobber imports. */
  const kitRevision = useRef(0);

  const prints = useQuery<PrintsListResponse>({
    queryKey: ["/api/prints", ownerCode, "kits"],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/prints?includeAttached=true", undefined, { headers });
      return (await response.json()) as PrintsListResponse;
    },
  });

  useEffect(() => {
    saveKitToStorage(kit);
  }, [kit]);

  /** Prefer SQLite when unlocked + deal-bound; migrate browser cache once if server is empty. */
  useEffect(() => {
    const dealId = (kit.hubspotDealId || "").trim();
    if (!isUnlocked || !dealId) return;

    const token = ++serverLoadToken.current;
    const revisionAtStart = kitRevision.current;
    let cancelled = false;
    setServerSync("loading");

    void (async () => {
      try {
        const remote = await fetchKitFromServer(dealId, headers);
        if (cancelled || token !== serverLoadToken.current) return;
        // User imported / edited while this request was in flight — keep their work.
        if (revisionAtStart !== kitRevision.current) {
          setServerSync("idle");
          return;
        }

        if (remote && remote.bits.length + remote.plates.length > 0) {
          skipNextServerSave.current = true;
          setKit({
            ...remote,
            hubspotDealId: dealId,
            hubspotDealName: remote.hubspotDealName || kit.hubspotDealName || remote.name,
          });
          setNote(`Loaded kit from server for ${remote.hubspotDealName || dealId}.`);
        } else {
          const local = loadKitFromStorage(dealId);
          if (local && local.bits.length + local.plates.length > 0) {
            if (revisionAtStart !== kitRevision.current) {
              setServerSync("idle");
              return;
            }
            skipNextServerSave.current = true;
            const migrated = bindKitToDeal(local, {
              dealId,
              dealName: local.hubspotDealName || kit.hubspotDealName || `Print Order ${dealId}`,
            });
            setKit(migrated);
            try {
              await saveKitToServer(migrated, headers);
              if (!cancelled && revisionAtStart === kitRevision.current) {
                setNote(`Migrated browser kit to server for ${migrated.hubspotDealName}.`);
              }
            } catch {
              if (!cancelled) setNote("Loaded browser kit; server save will retry on the next change.");
            }
          }
        }
        if (!cancelled && token === serverLoadToken.current) setServerSync("idle");
      } catch {
        if (!cancelled && token === serverLoadToken.current) {
          setServerSync("error");
          setNote("Could not reach kit storage — working from this browser until the server is back.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally only re-run when unlock / deal binding changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked, kit.hubspotDealId, ownerCode]);

  /** Debounced SQLite save for deal-bound kits. */
  useEffect(() => {
    const dealId = (kit.hubspotDealId || "").trim();
    if (!isUnlocked || !dealId) return;
    if (skipNextServerSave.current) {
      skipNextServerSave.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      setServerSync("saving");
      void saveKitToServer(kit, headers)
        .then(() => setServerSync("idle"))
        .catch(() => setServerSync("error"));
    }, 450);

    return () => window.clearTimeout(timer);
    // headers is derived from ownerCode; avoid re-saving on unrelated session draft changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit, isUnlocked, ownerCode]);

  useEffect(() => {
    const applyDealFromHash = () => {
      const dealId = readHashQueryParam("dealId");
      if (!dealId) return;
      setKit((current) => {
        if (current.hubspotDealId === dealId) return current;
        const saved = loadKitFromStorage(dealId);
        if (saved) return saved;
        const candidate = prints.data?.candidates.find((row) => row.dealId === dealId);
        return emptyKitForDeal({
          dealId,
          dealName: candidate?.dealName || `Print Order ${dealId}`,
        });
      });
    };
    applyDealFromHash();
    window.addEventListener("hashchange", applyDealFromHash);
    return () => window.removeEventListener("hashchange", applyDealFromHash);
  }, [prints.data?.candidates]);

  const updateKit = (next: KitTracker) => {
    kitRevision.current += 1;
    setKit({ ...next, updatedAt: new Date().toISOString() });
  };

  const counts = inventory(kit);
  const groups = groupSummaries(kit);
  const activePlate = kit.plates.find((plate) => plate.id === activePlateId) ?? kit.plates[kit.plates.length - 1] ?? null;
  const activePlateBits = activePlate ? plateBits(kit, activePlate.id) : [];
  const activeAwaitingQc = activePlateBits.filter((bit) => bit.status === "on_plate").length;
  const plateById = useMemo(() => new Map(kit.plates.map((plate) => [plate.id, plate])), [kit.plates]);
  const previewBit = kit.bits.find((bit) => bit.id === previewBitId) ?? null;
  const previewFile = previewBitId ? stlByBitId[previewBitId] ?? null : null;
  const plateBanner = activePlate
    ? plateStatusMessage(activePlate.name, activePlateBits.length, activeAwaitingQc)
    : null;
  const dealBound = Boolean(kit.hubspotDealId);

  const visibleBits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kit.bits.filter((bit) => {
      if (groupFilter !== "all" && bit.group !== groupFilter) return false;
      if (!q) return true;
      return bit.label.toLowerCase().includes(q) || bit.fileName.toLowerCase().includes(q);
    });
  }, [kit.bits, groupFilter, query]);

  const printableVisible = visibleBits.filter(isPrintable);
  const selectedCount = printableVisible.filter((bit) => selected.has(bit.id)).length;

  const selectDeal = (deal: PrintFileCandidateDeal) => {
    const saved = loadKitFromStorage(deal.dealId);
    if (saved) {
      skipNextServerSave.current = true;
      updateKit(bindKitToDeal(saved, { dealId: deal.dealId, dealName: deal.dealName }));
      setNote(`Loading kit for ${deal.dealName}…`);
    } else if (kit.bits.length > 0 && !kit.hubspotDealId) {
      updateKit(bindKitToDeal(kit, { dealId: deal.dealId, dealName: deal.dealName }));
      setNote(`Bound current kit to ${deal.dealName}. Import/CTB attach will use this Print Order.`);
    } else {
      skipNextServerSave.current = true;
      updateKit(emptyKitForDeal({ dealId: deal.dealId, dealName: deal.dealName }));
      setStlByBitId({});
      setNote(`Selected ${deal.dealName}. Import the STL kit folder or zip for this order.`);
    }
    setSelected(new Set());
    setActivePlateId(null);
    setPreviewBitId(null);
    setCtbFile(null);
    window.location.hash = `#/kit-dry-run?dealId=${encodeURIComponent(deal.dealId)}`;
  };

  const applyImport = (summary: KitImportSummary) => {
    const { imports } = summary;
    if (imports.length === 0) {
      setActivePlateId(null);
      setNote(formatKitImportNote(summary, "kit"));
      return;
    }
    const kitName = inferKitNameFromImports(imports);
    const bits = buildKitBitsFromImports(imports, kitName);
    const fileByName = new Map(imports.map((item) => [item.fileName.toLowerCase(), item.file]));
    const nextFiles: Record<string, File> = {};
    for (const bit of bits) {
      const file = fileByName.get(bit.fileName.toLowerCase());
      if (file) nextFiles[bit.id] = file;
    }
    updateKit(
      createKitFromBits(kitName, bits, {
        hubspotDealId: kit.hubspotDealId,
        hubspotDealName: kit.hubspotDealName,
      }),
    );
    setStlByBitId(nextFiles);
    setSelected(new Set());
    setActivePlateId(null);
    setGroupFilter("all");
    setPreviewBitId(bits[0]?.id ?? null);
    setPlateName("Plate 1");
    setCtbFileName(`${kitName.replace(/[^\w]+/g, "_").slice(0, 28)}_P1.ctb`);
    setCtbFile(null);
    setNote(formatKitImportNote(summary, kitName));
  };

  const runImport = async (loader: () => Promise<KitImportSummary>) => {
    setImportBusy(true);
    setNote("Reading kit files…");
    try {
      applyImport(await loader());
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not read kit folder or archive");
    } finally {
      setImportBusy(false);
    }
  };

  /** Copy files first — FileList is live and empties when the input is reset. */
  const importFromFiles = (files: File[]) => {
    if (files.length === 0) {
      setNote("No files selected. Choose a folder with .stl files or a .zip kit.");
      return;
    }
    void runImport(() => collectKitFilesFromFileList(files));
  };

  /**
   * Snapshot the drop synchronously, then process.
   * Do not make this async — browsers clear DataTransfer when the drop handler returns.
   */
  const onDropKitFiles = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const pending = beginKitImportFromDataTransfer(event.dataTransfer);
    void runImport(() => pending);
  };

  const onDragEnterKit = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) setDragActive(true);
  };

  const onDragOverKit = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) {
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    }
  };

  const onDragLeaveKit = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDragActive(false);
  };

  const toggleBit = (bit: KitBit) => {
    if (!isPrintable(bit)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bit.id)) next.delete(bit.id);
      else next.add(bit.id);
      return next;
    });
  };

  const makePlate = async () => {
    if (selectedCount === 0) {
      setNote("Select at least one bit that still needs printing.");
      return;
    }

    let nextCtbName = ctbFile?.name || ctbFileName;
    let printFileRecordId: number | null = null;

    if (ctbFile && kit.hubspotDealId) {
      if (!isUnlocked) {
        setNote("Unlock owner tools to attach this CTB to the Print Order.");
        return;
      }
      setAttachBusy(true);
      try {
        const staged = await analyzePrintPlate(ctbFile, { headers });
        const printerIdRaw = initialAttachPrinterId(staged.printerMatch);
        if (staged.printerMatch?.requiresPrinterChoice) {
          throw new Error(
            "This plate needs a printer choice (shared model name). Attach it from Prints so you can pick NEWX1/2/3.",
          );
        }
        assertAttachPrinterReady(staged.printerMatch, printerIdRaw);
        const body = await attachPrintPlate({
          analysisId: staged.analysisId,
          dealId: kit.hubspotDealId,
          printerId: printerIdRaw ? Number(printerIdRaw) : null,
          headers,
        });
        nextCtbName = body.record.fileName;
        printFileRecordId = body.record.id;
        queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
        queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
        queryClient.invalidateQueries({ queryKey: ["/api/printers"] });
      } catch (error) {
        setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not attach plate to HubSpot");
        setAttachBusy(false);
        return;
      } finally {
        setAttachBusy(false);
      }
    }

    const result = createPlate(kit, {
      name: plateName,
      ctbFileName: nextCtbName,
      bitIds: Array.from(selected),
      printFileRecordId,
    });
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    updateKit(result.kit);
    setSelected(new Set());
    setActivePlateId(result.plateId);
    setPlateName(`Plate ${result.kit.plates.length + 1}`);
    setCtbFile(null);
    const created = result.kit.plates.find((plate) => plate.id === result.plateId);
    setNote(
      created
        ? printFileRecordId
          ? `Created ${created.name} with ${created.bitIds.length} bits and attached ${created.ctbFileName} to HubSpot.`
          : `Created ${created.name} with ${created.bitIds.length} bits.`
        : "Plate created.",
    );
  };

  const selectPlate = (plateId: string) => {
    setActivePlateId(plateId);
    const plate = kit.plates.find((item) => item.id === plateId);
    if (!plate) return;
    const bits = plateBits(kit, plate.id);
    const awaiting = bits.filter((bit) => bit.status === "on_plate").length;
    setNote(plateStatusMessage(plate.name, bits.length, awaiting));
  };

  return (
    <div data-testid="page-kit-dry-run">
      <PageHeader
        title="Kits"
        subtitle="Track which parts still need printing for a job, then build plates and mark QC."
        actions={
          <StatusPill
            tone={counts.remaining === 0 && counts.total > 0 ? "good" : "warn"}
            icon={Package}
            label={`${counts.good}/${counts.total} good · ${counts.remaining} left`}
            testId="status-kit-inventory"
          />
        }
      />

      <div
        className={cn(
          "mx-auto max-w-5xl space-y-5 p-4 md:p-6 transition-colors",
          dragActive ? "rounded-lg bg-primary/5 ring-2 ring-primary/30 ring-inset" : "",
        )}
        onDragEnter={onDragEnterKit}
        onDragOver={onDragOverKit}
        onDragLeave={onDragLeaveKit}
        onDrop={onDropKitFiles}
      >
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock Kits"
            description="Enter the owner code to link kits to Print Orders and attach plate files to HubSpot."
            buttonLabel="Unlock Kits"
            testIdPrefix="kits"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : null}

        <section className="rounded-md border border-card-border bg-card p-4" data-testid="panel-kit-deal">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="rule-label">Print Order</p>
              <h2 className="mt-1 text-base font-semibold tracking-tight">
                {dealBound ? kit.hubspotDealName || kit.name : "No order selected"}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {dealBound
                  ? `This kit is linked to the HubSpot job above. Progress saves automatically${
                      serverSync === "saving"
                        ? " (saving…)"
                        : serverSync === "loading"
                          ? " (loading…)"
                          : serverSync === "error"
                            ? " (server unreachable — this browser still keeps a copy)"
                            : ""
                    }. Adding a CTB when you make a plate also records it on that order.`
                  : "Pick which HubSpot Print Order this kit belongs to. Kit progress and plate files then save against that job."}
              </p>
            </div>
            {dealBound ? (
              <Link
                href={printsDealHref(kit.hubspotDealId!)}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                data-testid="link-kit-open-prints"
              >
                Open Print files
                <ExternalLink className="h-3 w-3" />
              </Link>
            ) : null}
          </div>

          {isUnlocked ? (
            <div className="mt-3 flex flex-wrap gap-2" data-testid="list-kit-deal-candidates">
              {(prints.data?.candidates ?? []).slice(0, 12).map((deal) => {
                const active = kit.hubspotDealId === deal.dealId;
                return (
                  <Button
                    key={deal.dealId}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => selectDeal(deal)}
                    data-testid={`button-kit-deal-${deal.dealId}`}
                  >
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    <span className="max-w-[14rem] truncate">{deal.dealName}</span>
                    <span className="ml-1.5 text-[0.65rem] opacity-80">{deal.stage}</span>
                  </Button>
                );
              })}
              {prints.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading Print Orders…</p>
              ) : null}
              {!prints.isLoading && (prints.data?.candidates.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">No open Print Orders found.</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Unlock to choose an open Print Order.</p>
          )}
        </section>

        {(note || plateBanner || importBusy) && (
          <div className="space-y-2" data-testid="panel-kit-notes">
            {importBusy ? (
              <p
                className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-foreground"
                data-testid="text-kit-import-busy"
              >
                Reading kit files…
              </p>
            ) : null}
            {note ? (
              <p
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                data-testid="text-kit-note"
              >
                {note}
              </p>
            ) : null}
            {plateBanner && note && !note.includes("selected —") && !note.startsWith("Created ") && !note.startsWith("Loaded ") && !note.startsWith("Reading ") ? (
              <p className="text-sm text-muted-foreground" data-testid="text-kit-action-note">
                {plateBanner}
              </p>
            ) : plateBanner && !note ? (
              <p
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                data-testid="text-kit-note"
              >
                {plateBanner}
              </p>
            ) : null}
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-4" data-testid="panel-kit-inventory">
          <InvStat label="Needed" value={counts.needed} />
          <InvStat label="Reprint" value={counts.reprint} warn={counts.reprint > 0} />
          <InvStat label="On plate" value={counts.onPlate} />
          <InvStat label="Good" value={counts.good} good />
        </section>

        <section
          className={cn(
            "rounded-md border border-dashed p-4 transition-colors",
            dragActive ? "border-primary bg-primary/10" : "border-border bg-card",
          )}
          data-testid="panel-folder-import"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold tracking-tight">
                {kit.bits.length > 0 ? kit.name : "Import kit files"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Drop a folder or .zip anywhere on this page (or use the buttons). Each .stl becomes a
                part to print. Subfolders or separate zips become groups. RAR/7z are not supported —
                zip those first.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={folderInputRef}
                type="file"
                className="hidden"
                multiple
                // @ts-expect-error webkitdirectory is supported in Chromium
                webkitdirectory=""
                {...({ directory: "" } as Record<string, string>)}
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = "";
                  importFromFiles(files);
                }}
                data-testid="input-kit-folder"
              />
              <input
                ref={zipInputRef}
                type="file"
                className="hidden"
                accept=".zip,application/zip,application/x-zip-compressed"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files || []);
                  event.target.value = "";
                  importFromFiles(files);
                }}
                data-testid="input-kit-zip"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={importBusy}
                onClick={() => folderInputRef.current?.click()}
                data-testid="button-choose-kit-folder"
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {importBusy ? "Reading…" : "Choose folder"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={importBusy}
                onClick={() => zipInputRef.current?.click()}
                data-testid="button-choose-kit-zip"
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Choose zip
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearKitStorage(kit.hubspotDealId);
                  updateKit(
                    kit.hubspotDealId
                      ? emptyKitForDeal({
                          dealId: kit.hubspotDealId,
                          dealName: kit.hubspotDealName || kit.name || "Print Order",
                        })
                      : createEmptyKit(),
                  );
                  setStlByBitId({});
                  setSelected(new Set());
                  setActivePlateId(null);
                  setPreviewBitId(null);
                  setCtbFile(null);
                  setCtbFileName("Plate_1.ctb");
                  setPlateName("Plate 1");
                  setGroupFilter("all");
                  setNote(
                    kit.hubspotDealId
                      ? "Cleared kit parts for this order. Drop a folder or .zip to import again."
                      : "Cleared. Choose a Print Order, then drop a folder or .zip.",
                  );
                }}
                data-testid="button-clear-kit"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Clear
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(16rem,0.85fr)]">
          <div className="space-y-4">
            <div className="rounded-md border border-card-border bg-card p-4" data-testid="panel-bit-inventory">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="rule-label">Parts</p>
                  <h2 className="mt-1 text-base font-semibold tracking-tight">
                    {kit.bits.length === 0 ? "No parts loaded yet" : "Parts still to print"}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Select the parts for the next plate. After printing, mark each good or reprint.
                  </p>
                </div>
                <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter by name"
                    data-testid="input-kit-bit-filter"
                  />
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                <FilterChip active={groupFilter === "all"} onClick={() => setGroupFilter("all")} label="All" />
                {groups.map((group) => (
                  <FilterChip
                    key={group.group}
                    active={groupFilter === group.group}
                    onClick={() => setGroupFilter(group.group)}
                    label={`${group.group} (${group.remaining})`}
                  />
                ))}
              </div>

              <ul className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto" data-testid="list-kit-bits">
                {kit.bits.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    Drop a kit folder or .zip to load parts.
                  </li>
                ) : null}
                {visibleBits.map((bit) => {
                  const printable = isPrintable(bit);
                  const checked = selected.has(bit.id);
                  const bitPlate = bit.plateId ? plateById.get(bit.plateId) : null;
                  const onActivePlate = Boolean(activePlate && bit.plateId === activePlate.id);
                  return (
                    <li key={bit.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (printable) {
                            toggleBit(bit);
                            return;
                          }
                          if (bit.plateId) selectPlate(bit.plateId);
                        }}
                        onDoubleClick={() => setPreviewBitId(bit.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors",
                          printable
                            ? checked
                              ? "border-primary/40 bg-primary/10"
                              : "border-border bg-background hover:bg-muted/40"
                            : onActivePlate
                              ? "border-primary/30 bg-primary/5 text-foreground"
                              : "border-transparent bg-muted/20 text-muted-foreground hover:bg-muted/40",
                        )}
                        data-testid={`row-kit-bit-${bit.id}`}
                      >
                        <span
                          className={cn(
                            "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[0.625rem]",
                            checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
                          )}
                        >
                          {checked ? "✓" : ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium">{bit.label}</span>
                        <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                          {statusLabel(bit, bitPlate?.name)}
                        </span>
                        {stlByBitId[bit.id] ? (
                          <button
                            type="button"
                            className="hs-link shrink-0 text-xs"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPreviewBitId(bit.id);
                            }}
                            data-testid={`button-preview-bit-${bit.id}`}
                          >
                            View
                          </button>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto]">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" htmlFor="plate-name">
                    Plate name
                  </label>
                  <Input
                    id="plate-name"
                    value={plateName}
                    onChange={(event) => setPlateName(event.target.value)}
                    placeholder="e.g. Plate 1"
                    data-testid="input-plate-name"
                  />
                  <p className="text-[0.6875rem] text-muted-foreground">Label for this print run.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" htmlFor="ctb-name">
                    {dealBound ? "Plate file (.ctb / .ultx)" : "Plate file name (optional)"}
                  </label>
                  {dealBound ? (
                    <>
                      <input
                        ref={ctbInputRef}
                        type="file"
                        className="hidden"
                        accept=".ctb,.ultx,application/octet-stream"
                        onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          event.target.value = "";
                          setCtbFile(file);
                          if (file) setCtbFileName(file.name);
                        }}
                        data-testid="input-kit-ctb-file"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => ctbInputRef.current?.click()}
                        data-testid="button-choose-kit-ctb"
                      >
                        <Upload className="mr-1.5 h-3.5 w-3.5" />
                        <span className="truncate">{ctbFile ? ctbFile.name : "Choose .ctb / .ultx"}</span>
                      </Button>
                      <p className="text-[0.6875rem] text-muted-foreground">
                        Optional. Attaches to the Print Order when you make the plate.
                      </p>
                    </>
                  ) : (
                    <Input
                      id="ctb-name"
                      value={ctbFileName}
                      onChange={(event) => setCtbFileName(event.target.value)}
                      data-testid="input-ctb-name"
                    />
                  )}
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    disabled={selectedCount === 0 || attachBusy}
                    onClick={() => void makePlate()}
                    data-testid="button-make-plate"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {attachBusy ? "Attaching…" : `Make plate (${selectedCount})`}
                  </Button>
                </div>
              </div>
              {dealBound ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Make plate records the selected parts. If you also chose a plate file, it is analyzed and saved on this Print Order.
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={printableVisible.length === 0}
                  onClick={() => setSelected(new Set(printableVisible.map((bit) => bit.id)))}
                  data-testid="button-select-visible-printable"
                >
                  Select visible needed
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={selectedCount === 0}
                  onClick={() => setSelected(new Set())}
                  data-testid="button-clear-bit-selection"
                >
                  Clear selection
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border border-card-border bg-card p-4" data-testid="panel-active-plate">
              <p className="rule-label">Current plate</p>
              {activePlate ? (
                <>
                  <h2 className="mt-1 text-base font-semibold tracking-tight">
                    {activePlate.name}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {activePlateBits.length} part{activePlateBits.length === 1 ? "" : "s"}
                      {activeAwaitingQc > 0 ? ` · ${activeAwaitingQc} awaiting QC` : ""}
                    </span>
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {activePlate.ctbFileName || "No plate file attached"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    After the printer finishes, mark each part good or reprint.
                  </p>
                  <ul className="mt-3 space-y-1.5" data-testid="list-plate-bits">
                    {activePlateBits.map((bit) => (
                      <li
                        key={bit.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                        data-testid={`row-plate-bit-${bit.id}`}
                      >
                        <span className="min-w-0 truncate font-medium">{bit.label}</span>
                        <div className="flex shrink-0 gap-1.5">
                          {bit.status === "on_plate" || bit.status === "good" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant={bit.status === "good" ? "default" : "outline"}
                              onClick={() => {
                                const result = markBitGood(kit, bit.id);
                                if (!result.ok) {
                                  setNote(result.error);
                                  return;
                                }
                                updateKit(result.kit);
                              }}
                              data-testid={`button-mark-good-${bit.id}`}
                            >
                              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                              Good
                            </Button>
                          ) : null}
                          {bit.status === "on_plate" || bit.status === "good" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                const result = markBitReprint(kit, bit.id);
                                if (!result.ok) {
                                  setNote(result.error);
                                  return;
                                }
                                updateKit(result.kit);
                                setNote(`${bit.label} marked for reprint — select it for the next plate.`);
                              }}
                              data-testid={`button-mark-reprint-${bit.id}`}
                            >
                              Reprint
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">{statusLabel(bit)}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {activeAwaitingQc > 0 ? (
                    <Button
                      type="button"
                      className="mt-3 w-full"
                      onClick={() => {
                        const result = markPlateAllGood(kit, activePlate.id);
                        if (!result.ok) {
                          setNote(result.error);
                          return;
                        }
                        updateKit(result.kit);
                        setNote(`Marked ${result.count} bits good on ${activePlate.name}.`);
                      }}
                      data-testid="button-mark-plate-all-good"
                    >
                      Mark remaining good
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No plate yet. Select bits that need printing, then Make plate.
                </p>
              )}
            </div>

            {kit.plates.length > 0 ? (
              <div className="rounded-md border border-card-border bg-card p-4" data-testid="panel-plate-list">
                <p className="rule-label">Plates</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Kit-wide on plate: {counts.onPlate}. Selecting a plate updates Current plate only.
                </p>
                <ul className="mt-2 space-y-1">
                  {kit.plates.map((plate) => (
                    <li key={plate.id}>
                      <button
                        type="button"
                        className={cn(
                          "w-full rounded-md px-2 py-1.5 text-left text-sm",
                          activePlate?.id === plate.id ? "bg-primary/10 font-medium" : "hover:bg-muted/40",
                        )}
                        onClick={() => selectPlate(plate.id)}
                        data-testid={`button-select-plate-${plate.id}`}
                      >
                        {plate.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {plate.bitIds.length} bits
                          {plate.printFileRecordId ? " · HubSpot" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {previewBit && previewFile ? (
              <div className="rounded-md border border-card-border bg-card p-3" data-testid="panel-stl-preview">
                <p className="mb-2 text-xs font-medium">{previewBit.label}</p>
                <StlPreview file={previewFile} />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function InvStat({
  label,
  value,
  warn,
  good,
}: {
  label: string;
  value: number;
  warn?: boolean;
  good?: boolean;
}) {
  return (
    <div className="rounded-md border border-card-border bg-card px-3 py-2.5" data-testid={`stat-kit-${label.toLowerCase()}`}>
      <p className="rule-label">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-semibold numeric",
          warn && value > 0 && "text-primary",
          good && "text-chart-4",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-xs transition-colors",
        active ? "border-primary/40 bg-primary/10 font-medium" : "border-border text-muted-foreground hover:bg-muted/40",
      )}
    >
      {label}
    </button>
  );
}
