import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CheckSquare,
  ClipboardCheck,
  FolderOpen,
  Layers3,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Upload,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { StlPreview } from "@/components/stl-preview";
import { cn } from "@/lib/utils";
import {
  attachOrderPlate,
  buildKitBitsFromFileNames,
  completePlateQc,
  createPlateFromReprintPool,
  createSampleShop,
  groupSummaries,
  isSelectableBit,
  markAllPlateBits,
  orderProgress,
  plateQcCounts,
  poolKey,
  replaceOrderKit,
  reprintPool,
  resetShop,
  setPlateBitResult,
  shopProgress,
  type KitBit,
  type KitOrder,
  type KitPlate,
  type ShopDryRun,
} from "@/lib/kit-dry-run";
import {
  collectStlFilesFromDataTransfer,
  collectStlFilesFromFileList,
  inferKitNameFromImports,
  type ImportedStlFile,
} from "@/lib/stl-folder-import";

function bitStatusLabel(bit: KitBit): string {
  switch (bit.status) {
    case "printing":
      return "on plate · waiting QC";
    case "done":
      return "good · done";
    case "needs_reprint":
      return "in reprint pool";
    default:
      return "not printed yet";
  }
}

export default function KitDryRunPage() {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [shop, setShop] = useState<ShopDryRun>(() => createSampleShop());
  const [orderId, setOrderId] = useState(shop.orders[0]?.id ?? "");
  const [groupFilter, setGroupFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedBits, setSelectedBits] = useState<Set<string>>(() => new Set());
  const [plateName, setPlateName] = useState("Plate 1");
  const [ctbFileName, setCtbFileName] = useState("Acastus_P1.ctb");
  const [poolFilter, setPoolFilter] = useState<"all" | "order" | "client">("all");
  const [poolSelected, setPoolSelected] = useState<Set<string>>(() => new Set());
  const [qcPlateId, setQcPlateId] = useState<string | null>(null);
  const [stlByBitId, setStlByBitId] = useState<Record<string, File>>({});
  const [previewBitId, setPreviewBitId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [note, setNote] = useState<string | null>(
    "Drag a kit folder here (or Choose folder). STLs stay in this browser tab for preview — not uploaded.",
  );

  const order = shop.orders.find((item) => item.id === orderId) ?? shop.orders[0] ?? null;
  const progress = order ? orderProgress(order) : null;
  const shopTotals = shopProgress(shop);
  const groups = order ? groupSummaries(order) : [];
  const pendingQc = shop.plates.filter((plate) => plate.status === "pending_qc");
  const qcPlate = shop.plates.find((plate) => plate.id === qcPlateId) ?? pendingQc[0] ?? null;
  const previewBit = order?.bits.find((bit) => bit.id === previewBitId) ?? null;
  const previewFile = previewBitId ? stlByBitId[previewBitId] ?? null : null;

  const poolItems = useMemo(() => {
    if (!order) return reprintPool(shop);
    if (poolFilter === "order") return reprintPool(shop, { orderId: order.id });
    if (poolFilter === "client") return reprintPool(shop, { clientName: order.clientName });
    return reprintPool(shop);
  }, [shop, order, poolFilter]);

  const visibleBits = useMemo(() => {
    if (!order) return [];
    const q = query.trim().toLowerCase();
    return order.bits.filter((bit) => {
      if (groupFilter !== "all" && bit.group !== groupFilter) return false;
      if (!q) return true;
      return bit.label.toLowerCase().includes(q) || bit.fileName.toLowerCase().includes(q);
    });
  }, [order, groupFilter, query]);

  const selectableVisible = visibleBits.filter(isSelectableBit);
  const selectedCount = selectableVisible.filter((bit) => selectedBits.has(bit.id)).length;

  const applyFolderImport = (imports: ImportedStlFile[]) => {
    if (!order) {
      setNote("Select an order first, then import the folder onto that kit.");
      return;
    }
    if (imports.length === 0) {
      setNote("No .stl files found in that folder/drop.");
      return;
    }

    const kitName = inferKitNameFromImports(imports);
    const bits = buildKitBitsFromFileNames(
      imports.map((item) => item.fileName),
      `${order.id}-${kitName}`,
    );
    const fileByName = new Map(imports.map((item) => [item.fileName.toLowerCase(), item.file]));
    const nextFiles: Record<string, File> = {};
    for (const bit of bits) {
      const file = fileByName.get(bit.fileName.toLowerCase());
      if (file) nextFiles[bit.id] = file;
    }

    setShop(replaceOrderKit(shop, order.id, bits));
    setStlByBitId(nextFiles);
    setSelectedBits(new Set());
    setPoolSelected(new Set());
    setQcPlateId(null);
    setGroupFilter("all");
    setPreviewBitId(bits[0]?.id ?? null);
    setPlateName("Plate 1");
    setCtbFileName(`${kitName.replace(/[^\w]+/g, "_").slice(0, 28)}_P1.ctb`);
    setNote(
      `Imported ${bits.length} STL${bits.length === 1 ? "" : "s"} onto ${order.clientName} / ${order.orderName} from “${kitName}”. Click a bit to preview.`,
    );
  };

  const onFolderInput = (list: FileList | null) => {
    if (!list) return;
    applyFolderImport(collectStlFilesFromFileList(list));
  };

  const onDropFolder = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    setImportBusy(true);
    try {
      const imports = await collectStlFilesFromDataTransfer(event.dataTransfer);
      applyFolderImport(imports);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not read dropped folder");
    } finally {
      setImportBusy(false);
    }
  };

  const selectOrder = (nextOrder: KitOrder) => {
    setOrderId(nextOrder.id);
    setSelectedBits(new Set());
    setGroupFilter("all");
    setQuery("");
    setPreviewBitId(null);
    setPlateName("Plate 1");
    setCtbFileName(`${nextOrder.orderName.replace(/[^\w]+/g, "_").slice(0, 24)}_P1.ctb`);
  };

  const toggleBit = (bit: KitBit) => {
    if (!isSelectableBit(bit)) return;
    setSelectedBits((prev) => {
      const next = new Set(prev);
      if (next.has(bit.id)) next.delete(bit.id);
      else next.add(bit.id);
      return next;
    });
  };

  const attachPlate = () => {
    if (!order) return;
    const result = attachOrderPlate(shop, {
      orderId: order.id,
      plateName,
      ctbFileName,
      bitIds: Array.from(selectedBits),
      kind: "planned",
    });
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    setShop(result.shop);
    setSelectedBits(new Set());
    setQcPlateId(result.plateId);
    setPlateName(`Plate ${result.shop.plates.filter((p) => p.kind === "planned").length + 1}`);
    setNote(`Logged CTB on ${order.clientName} / ${order.orderName}. QC only after print + inspection.`);
  };

  const createFromPool = () => {
    const selections = poolItems
      .filter((item) => poolSelected.has(poolKey(item)))
      .map((item) => ({ orderId: item.orderId, bitId: item.bitId }));
    const result = createPlateFromReprintPool(shop, { selections });
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    setShop(result.shop);
    setPoolSelected(new Set());
    setQcPlateId(result.plateId);
    setNote(`Reprint pool plate created with ${result.count} bits. Slice, print, then QC.`);
  };

  const finalizeQc = (plate: KitPlate) => {
    const result = completePlateQc(shop, plate.id);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    const counts = plateQcCounts(result.shop.plates.find((item) => item.id === plate.id) ?? plate);
    const poolSize = reprintPool(result.shop).length;
    setShop(result.shop);
    setNote(
      `QC saved: ${counts.good} good, ${counts.reprint} to pool.` +
        (poolSize > 0 ? ` Reprint pool now has ${poolSize}.` : ""),
    );
    setQcPlateId(result.shop.plates.find((item) => item.status === "pending_qc")?.id ?? null);
  };

  return (
    <div data-testid="page-kit-dry-run">
      <PageHeader
        title="Kit & plate bits"
        subtitle="Import a kit folder with Choose folder / drag-drop for local STL previews. Failures pool shop-wide until you build a reprint plate."
      />

      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6">
          <strong className="font-semibold">Safe import.</strong> Use drag-drop or Choose folder — not a disk path.
          STL files stay in this browser tab for preview and are not uploaded to the server in this dry run.
        </section>

        <section
          className={cn(
            "rounded-lg border border-dashed p-5 transition-colors",
            dragActive ? "border-primary bg-primary/10" : "border-card-border bg-card",
          )}
          data-testid="panel-folder-import"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget === event.target) setDragActive(false);
          }}
          onDrop={onDropFolder}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="rule-label">Import kit folder</p>
              <h2 className="mt-1 text-base font-semibold tracking-tight">Drop STL kit onto the selected order</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {order
                  ? `Target: ${order.clientName} · ${order.orderName}`
                  : "Select an order first"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!order || importBusy}
              onClick={() => folderInputRef.current?.click()}
              data-testid="button-choose-kit-folder"
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              {importBusy ? "Reading…" : "Choose folder"}
            </Button>
          </div>
          <input
            ref={(element) => {
              folderInputRef.current = element;
              if (element) {
                element.setAttribute("webkitdirectory", "");
                element.setAttribute("directory", "");
              }
            }}
            type="file"
            className="hidden"
            multiple
            onChange={(event) => {
              onFolderInput(event.target.files);
              event.target.value = "";
            }}
          />
          <p className="mt-3 text-sm text-muted-foreground">
            Drop the kit folder here (e.g. Acastus Knight … @STLHammer). Only <code>.stl</code> files are read.
          </p>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="rule-label">Shop snapshot</p>
              <h2 className="mt-1 text-base font-semibold tracking-tight">Open kit orders</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill tone="warn" icon={PackageOpen} label={`${shopTotals.done}/${shopTotals.total} good`} />
              <StatusPill tone="warn" icon={ClipboardCheck} label={`${shopTotals.printing} awaiting QC`} />
              <StatusPill tone="bad" icon={XCircle} label={`${shopTotals.reprint} in pool`} />
            </div>
          </div>

          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {shop.orders.map((item) => {
              const p = orderProgress(item);
              const active = item.id === order?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectOrder(item)}
                  className={cn(
                    "rounded-md border px-3 py-3 text-left transition-colors",
                    active ? "border-primary bg-primary/10" : "border-border bg-muted/30 hover:bg-muted/55",
                  )}
                >
                  <p className="text-xs text-muted-foreground">{item.clientName}</p>
                  <p className="mt-0.5 text-sm font-medium">{item.orderName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.done}/{p.total} good · {p.printing} QC · {p.reprint} pool
                  </p>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                const next = createSampleShop();
                setShop(next);
                setOrderId(next.orders[0]!.id);
                setStlByBitId({});
                setPreviewBitId(null);
                setSelectedBits(new Set());
                setPoolSelected(new Set());
                setQcPlateId(null);
                setNote("Reloaded sample shop (filenames only — import a folder for STL previews).");
              }}
            >
              <Layers3 className="mr-2 h-4 w-4" />
              Reload sample shop
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setShop(resetShop(shop));
                setSelectedBits(new Set());
                setPoolSelected(new Set());
                setQcPlateId(null);
                setNote("Reset all plates and bit statuses (STL files kept if imported).");
              }}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset progress
            </Button>
          </div>
        </section>

        {!order ? null : (
          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <section className="rounded-lg border border-card-border bg-card p-5">
              <p className="rule-label">Selected order kit</p>
              <h3 className="mt-1 text-base font-semibold tracking-tight">
                {order.clientName} · {order.orderName}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {progress?.todo} todo · {progress?.printing} awaiting QC · {progress?.reprint} in pool ·{" "}
                {progress?.done}/{progress?.total} good
                {Object.keys(stlByBitId).length > 0
                  ? ` · ${Object.keys(stlByBitId).length} STLs loaded for preview`
                  : " · no local STLs yet"}
              </p>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {groups.map((group) => (
                  <button
                    key={group.group}
                    type="button"
                    onClick={() => setGroupFilter(group.group)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-left text-xs",
                      groupFilter === group.group ? "border-primary bg-primary/10" : "border-border bg-muted/30",
                    )}
                  >
                    <span className="font-medium">{group.group}</span>
                    <span className="mt-0.5 block text-muted-foreground">
                      {group.done}/{group.total}
                      {group.reprint ? ` · ${group.reprint} pool` : ""}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Plate name</span>
                  <Input value={plateName} onChange={(e) => setPlateName(e.target.value)} />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">CTB file</span>
                  <Input value={ctbFileName} onChange={(e) => setCtbFileName(e.target.value)} />
                </label>
                <label className="space-y-1 text-xs sm:col-span-2">
                  <span className="text-muted-foreground">Search</span>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </div>
                </label>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedBits(new Set(selectableVisible.map((bit) => bit.id)))}
                >
                  Select visible queue ({selectableVisible.length})
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSelectedBits(new Set())}>
                  Clear
                </Button>
              </div>

              <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {visibleBits.map((bit) => {
                  const selectable = isSelectableBit(bit);
                  const checked = selectable && selectedBits.has(bit.id);
                  const hasStl = Boolean(stlByBitId[bit.id]);
                  const previewing = previewBitId === bit.id;
                  return (
                    <li key={bit.id}>
                      <div
                        className={cn(
                          "flex items-start gap-1 rounded-md px-1 py-1",
                          previewing ? "bg-muted/50" : "",
                        )}
                      >
                        <button
                          type="button"
                          disabled={!selectable}
                          onClick={() => toggleBit(bit)}
                          className={cn(
                            "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-sm",
                            !selectable ? "opacity-55" : checked ? "bg-primary/10" : "hover:bg-muted/60",
                          )}
                        >
                          {bit.status === "done" ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
                          ) : checked ? (
                            <CheckSquare className="mt-0.5 h-4 w-4 text-primary" />
                          ) : (
                            <Square className="mt-0.5 h-4 w-4 text-muted-foreground" />
                          )}
                          <span className="min-w-0">
                            <span className="block font-medium">
                              {bit.label}
                              {hasStl ? (
                                <span className="ml-2 text-[0.65rem] uppercase tracking-wide text-primary">STL</span>
                              ) : null}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {bit.group} · {bitStatusLabel(bit)}
                            </span>
                          </span>
                        </button>
                        <Button
                          type="button"
                          size="sm"
                          variant={previewing ? "default" : "ghost"}
                          disabled={!hasStl}
                          onClick={() => setPreviewBitId(bit.id)}
                          title={hasStl ? "Preview STL" : "Import folder to preview"}
                        >
                          View
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              <Button type="button" className="mt-4" onClick={attachPlate}>
                <Upload className="mr-2 h-4 w-4" />
                Attach CTB + {selectedCount} bit{selectedCount === 1 ? "" : "s"}
              </Button>
            </section>

            <div className="space-y-6">
              <section className="rounded-lg border border-card-border bg-card p-5">
                <p className="rule-label">STL preview</p>
                <h3 className="mt-1 text-base font-semibold tracking-tight">
                  {previewBit ? previewBit.label : "No bit selected"}
                </h3>
                <div className="mt-3">
                  <StlPreview file={previewFile} label={previewBit?.fileName} />
                </div>
              </section>

              <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-reprint-pool">
                <p className="rule-label">Shop reprint pool</p>
                <h3 className="mt-1 text-base font-semibold tracking-tight">Failed bits waiting to be sliced</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(
                    [
                      ["all", "All orders"],
                      ["client", `Client: ${order.clientName}`],
                      ["order", "This order only"],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      key={key}
                      type="button"
                      size="sm"
                      variant={poolFilter === key ? "default" : "outline"}
                      onClick={() => setPoolFilter(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {poolItems.length === 0 ? (
                  <p className="mt-4 text-sm text-muted-foreground">Pool empty.</p>
                ) : (
                  <>
                    <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                      {poolItems.map((item) => {
                        const key = poolKey(item);
                        const checked = poolSelected.has(key);
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              onClick={() =>
                                setPoolSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                              className={cn(
                                "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm",
                                checked ? "bg-destructive/10" : "hover:bg-muted/60",
                              )}
                            >
                              {checked ? (
                                <CheckSquare className="mt-0.5 h-4 w-4 text-destructive" />
                              ) : (
                                <Square className="mt-0.5 h-4 w-4 text-muted-foreground" />
                              )}
                              <span>
                                <span className="block font-medium">{item.label}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {item.clientName} · {item.orderName}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <Button type="button" className="mt-3" onClick={createFromPool}>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Create reprint plate from pool ({poolSelected.size})
                    </Button>
                  </>
                )}
              </section>
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-card-border bg-card p-5">
            <p className="rule-label">Post-print QC</p>
            <h3 className="mt-1 text-base font-semibold">After physical inspection</h3>
            {pendingQc.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">No plates awaiting QC.</p>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pendingQc.map((plate) => (
                    <Button
                      key={plate.id}
                      type="button"
                      size="sm"
                      variant={qcPlate?.id === plate.id ? "default" : "outline"}
                      onClick={() => setQcPlateId(plate.id)}
                    >
                      {plate.name}
                      {plate.kind === "reprint" ? " · redo" : ""}
                    </Button>
                  ))}
                </div>
                {qcPlate ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setShop(markAllPlateBits(shop, qcPlate.id, "good"))}>
                        Mark all good
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setShop(markAllPlateBits(shop, qcPlate.id, "reprint"))}
                      >
                        Mark all reprint (→ pool)
                      </Button>
                    </div>
                    <ul className="max-h-64 space-y-2 overflow-y-auto">
                      {qcPlate.bits.map((row) => {
                        const bitOrder = shop.orders.find((item) => item.id === row.orderId);
                        const bit = bitOrder?.bits.find((item) => item.id === row.bitId);
                        if (!bit || !bitOrder) return null;
                        return (
                          <li key={`${row.orderId}-${row.bitId}`} className="rounded-md border border-border px-3 py-2">
                            <p className="text-sm font-medium">{bit.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {bitOrder.clientName} · {bitOrder.orderName}
                            </p>
                            <div className="mt-2 flex gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant={row.result === "good" ? "default" : "outline"}
                                onClick={() => setShop(setPlateBitResult(shop, qcPlate.id, row.orderId, row.bitId, "good"))}
                              >
                                Good
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant={row.result === "reprint" ? "destructive" : "outline"}
                                onClick={() =>
                                  setShop(setPlateBitResult(shop, qcPlate.id, row.orderId, row.bitId, "reprint"))
                                }
                              >
                                Reprint → pool
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <Button type="button" onClick={() => finalizeQc(qcPlate)}>
                      <ClipboardCheck className="mr-2 h-4 w-4" />
                      Save QC after inspection
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            {note ? <p className="mt-4 text-sm text-muted-foreground">{note}</p> : null}
          </section>

          <section className="rounded-lg border border-card-border bg-card p-5">
            <p className="rule-label">Plate history</p>
            <h3 className="mt-1 text-base font-semibold">All logged CTBs</h3>
            {shop.plates.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {shop.plates.map((plate) => {
                  const counts = plateQcCounts(plate);
                  return (
                    <li key={plate.id} className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">
                          {plate.name}
                          {plate.kind === "reprint" ? " · pool redo" : ""}
                        </p>
                        <StatusPill
                          tone={plate.status === "inspected" ? (counts.reprint > 0 ? "warn" : "good") : "warn"}
                          icon={plate.status === "inspected" ? CheckCircle2 : ClipboardCheck}
                          label={
                            plate.status === "pending_qc"
                              ? "Awaiting QC"
                              : `${counts.good} good / ${counts.reprint} to pool`
                          }
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{plate.ctbFileName}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
