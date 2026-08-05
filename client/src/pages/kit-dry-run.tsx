import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FolderOpen,
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
import { cn } from "@/lib/utils";
import {
  buildKitBitsFromFileNames,
  createKitFromBits,
  createPlate,
  createSampleKit,
  groupSummaries,
  inventory,
  isPrintable,
  markBitGood,
  markBitReprint,
  markPlateAllGood,
  plateBits,
  type KitBit,
  type KitTracker,
} from "@/lib/kit-dry-run";
import {
  collectStlFilesFromDataTransfer,
  collectStlFilesFromFileList,
  inferKitNameFromImports,
  type ImportedStlFile,
} from "@/lib/stl-folder-import";

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
 * Simple kit tracker: inventory of bits + plates.
 * Select what still needs printing → make a plate → mark good or reprint.
 */
export default function KitDryRunPage() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [kit, setKit] = useState<KitTracker>(() => createSampleKit());
  const [groupFilter, setGroupFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plateName, setPlateName] = useState("Plate 1");
  const [ctbFileName, setCtbFileName] = useState("Acastus_P1.ctb");
  const [activePlateId, setActivePlateId] = useState<string | null>(null);
  const [stlByBitId, setStlByBitId] = useState<Record<string, File>>({});
  const [previewBitId, setPreviewBitId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [note, setNote] = useState<string | null>(
    "Load a kit folder or use the Acastus sample. Track what still needs printing, plate by plate.",
  );

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

  const applyImport = (imports: ImportedStlFile[]) => {
    if (imports.length === 0) {
      setNote("No .stl files found in that folder.");
      return;
    }
    const kitName = inferKitNameFromImports(imports);
    const bits = buildKitBitsFromFileNames(
      imports.map((item) => item.fileName),
      kitName,
    );
    const fileByName = new Map(imports.map((item) => [item.fileName.toLowerCase(), item.file]));
    const nextFiles: Record<string, File> = {};
    for (const bit of bits) {
      const file = fileByName.get(bit.fileName.toLowerCase());
      if (file) nextFiles[bit.id] = file;
    }
    setKit(createKitFromBits(kitName, bits));
    setStlByBitId(nextFiles);
    setSelected(new Set());
    setActivePlateId(null);
    setGroupFilter("all");
    setPreviewBitId(bits[0]?.id ?? null);
    setPlateName("Plate 1");
    setCtbFileName(`${kitName.replace(/[^\w]+/g, "_").slice(0, 28)}_P1.ctb`);
    setNote(`Loaded ${bits.length} bits from “${kitName}”. Select bits that still need printing, then make a plate.`);
  };

  const onDropFolder = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);
    try {
      applyImport(await collectStlFilesFromDataTransfer(event.dataTransfer));
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not read dropped folder");
    }
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

  const makePlate = () => {
    const result = createPlate(kit, {
      name: plateName,
      ctbFileName,
      bitIds: Array.from(selected),
    });
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    setKit(result.kit);
    setSelected(new Set());
    setActivePlateId(result.plateId);
    setPlateName(`Plate ${result.kit.plates.length + 1}`);
    const created = result.kit.plates.find((plate) => plate.id === result.plateId);
    setNote(
      created
        ? `Created ${created.name} with ${created.bitIds.length} bits.`
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
        subtitle="Bit inventory and plates — what still needs printing, what’s on a plate, what’s good or needs a reprint."
        actions={
          <StatusPill
            tone={counts.remaining === 0 ? "good" : "warn"}
            icon={Package}
            label={`${counts.good}/${counts.total} good · ${counts.remaining} left`}
            testId="status-kit-inventory"
          />
        }
      />

      <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
        {plateBanner ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="text-kit-note">
            {plateBanner}
          </p>
        ) : note ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="text-kit-note">
            {note}
          </p>
        ) : null}
        {plateBanner && note && !note.includes("selected —") && !note.startsWith("Created ") ? (
          <p className="text-sm text-muted-foreground" data-testid="text-kit-action-note">
            {note}
          </p>
        ) : null}

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
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (e.currentTarget === e.target) setDragActive(false);
          }}
          onDrop={onDropFolder}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold tracking-tight">{kit.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Drop an STL folder or choose one. Previews stay in this tab — nothing uploads.
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
                onChange={(event) => {
                  applyImport(collectStlFilesFromFileList(event.target.files ?? []));
                  event.target.value = "";
                }}
                data-testid="input-kit-folder"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => folderInputRef.current?.click()}
                data-testid="button-choose-kit-folder"
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                Choose folder
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setKit(createSampleKit());
                  setStlByBitId({});
                  setSelected(new Set());
                  setActivePlateId(null);
                  setPreviewBitId(null);
                  setNote("Reset to Acastus sample kit.");
                }}
                data-testid="button-reset-sample-kit"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Sample
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(16rem,0.85fr)]">
          <div className="space-y-4">
            <div className="rounded-md border border-card-border bg-card p-4" data-testid="panel-bit-inventory">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="rule-label">Inventory</p>
                  <h2 className="mt-1 text-base font-semibold tracking-tight">Bits still to print</h2>
                </div>
                <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter bits"
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
                    data-testid="input-plate-name"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" htmlFor="ctb-name">
                    CTB file (optional)
                  </label>
                  <Input
                    id="ctb-name"
                    value={ctbFileName}
                    onChange={(event) => setCtbFileName(event.target.value)}
                    data-testid="input-ctb-name"
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    disabled={selectedCount === 0}
                    onClick={makePlate}
                    data-testid="button-make-plate"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Make plate ({selectedCount})
                  </Button>
                </div>
              </div>
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
                      {activePlateBits.length} bit{activePlateBits.length === 1 ? "" : "s"}
                      {activeAwaitingQc > 0 ? ` · ${activeAwaitingQc} awaiting QC` : ""}
                    </span>
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{activePlate.ctbFileName}</p>
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
                                setKit(result.kit);
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
                                setKit(result.kit);
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
                        setKit(result.kit);
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
                        <span className="ml-2 text-xs text-muted-foreground">{plate.bitIds.length} bits</span>
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
