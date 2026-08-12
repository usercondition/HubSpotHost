/**
 * Drop STLs onto an attached plate to record which parts were on that plate.
 * Names are operator-declared — the slice file does not contain part names.
 * STL meshes stay in this browser tab for local 3D preview (not uploaded).
 */
import { useEffect, useMemo, useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import {
  Box,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StlPreview } from "@/components/stl-preview";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  collectKitFilesFromDataTransfer,
  collectKitFilesFromFileList,
  type ImportedStlFile,
} from "@/lib/stl-folder-import";
import { normalizeStlFileName } from "@shared/stl-names";
import { partStatusLabel, type PrintPlateBit, type PrintPlateBitStatus } from "@shared/schema";

export type PlateBitSummary = {
  total: number;
  onPlate: number;
  good: number;
  reprint: number;
};

type BitsResponse = {
  ok: true;
  bits: PrintPlateBit[];
  bitSummary: PlateBitSummary;
  added?: number;
};

type StatusFilter = "all" | PrintPlateBitStatus;

function fileKey(fileName: string): string {
  return fileName.trim().toLowerCase();
}

function rememberImports(
  imports: ImportedStlFile[],
  setFiles: Dispatch<SetStateAction<Record<string, File>>>,
  setGroups: Dispatch<SetStateAction<Record<string, string>>>,
) {
  setFiles((prev) => {
    const next = { ...prev };
    for (const item of imports) {
      const name = normalizeStlFileName(item.fileName);
      if (!name) continue;
      next[fileKey(name)] = item.file;
    }
    return next;
  });
  setGroups((prev) => {
    const next = { ...prev };
    for (const item of imports) {
      const name = normalizeStlFileName(item.fileName);
      const group = item.folderGroup?.trim();
      if (!name || !group) continue;
      next[fileKey(name)] = group;
    }
    return next;
  });
}

export function PlateBitsPanel({
  recordId,
  bits: initialBits,
  bitSummary: initialSummary,
  headers,
  onChanged,
}: {
  recordId: number;
  bits: PrintPlateBit[];
  bitSummary: PlateBitSummary;
  headers: Record<string, string>;
  onChanged: (next: { bits: PrintPlateBit[]; bitSummary: PlateBitSummary }) => void;
}) {
  const [bits, setBits] = useState(initialBits);
  const [summary, setSummary] = useState(initialSummary);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedBitId, setSelectedBitId] = useState<number | null>(null);
  const [stlByFileName, setStlByFileName] = useState<Record<string, File>>({});
  const [groupByFileName, setGroupByFileName] = useState<Record<string, string>>({});

  useEffect(() => {
    setBits(initialBits);
    setSummary(initialSummary);
  }, [initialBits, initialSummary]);

  useEffect(() => {
    if (selectedBitId == null) return;
    if (!bits.some((bit) => bit.id === selectedBitId)) {
      setSelectedBitId(null);
    }
  }, [bits, selectedBitId]);

  const apply = (body: BitsResponse, message?: string) => {
    setBits(body.bits);
    setSummary(body.bitSummary);
    onChanged({ bits: body.bits, bitSummary: body.bitSummary });
    if (message) setNote(message);
  };

  const postParts = async (imports: ImportedStlFile[]) => {
    const parts = imports.map((item) => ({
      fileName: item.fileName,
      relativePath: item.relativePath,
      archivePath: item.archivePath,
      itemGroup: item.folderGroup,
    }));
    if (parts.length === 0) {
      setNote("No .stl files found. Drop the part files that were on this plate.");
      return;
    }
    rememberImports(imports, setStlByFileName, setGroupByFileName);
    const response = await apiRequest(
      "POST",
      `/api/prints/${recordId}/bits`,
      { parts },
      { headers },
    );
    const body = (await response.json()) as BitsResponse;
    apply(
      body,
      body.added
        ? `Added ${body.added} part${body.added === 1 ? "" : "s"} to this plate.`
        : "Those parts were already on this plate.",
    );
    const importKeys = new Set(
      imports
        .map((item) => normalizeStlFileName(item.fileName))
        .filter((name): name is string => Boolean(name))
        .map((name) => fileKey(name)),
    );
    const focus =
      body.bits.find((bit) => importKeys.has(fileKey(bit.fileName))) ?? body.bits[0] ?? null;
    if (focus) setSelectedBitId(focus.id);
  };

  const addFromFiles = async (files: File[]) => {
    setBusy(true);
    setNote("Reading part files…");
    try {
      const collected = await collectKitFilesFromFileList(files);
      if (collected.imports.length === 0) {
        setNote(
          collected.unsupportedArchives.length > 0
            ? `No .stl files found. ${collected.unsupportedArchives.slice(0, 2).join("; ")}`
            : "No .stl files found in that drop. Drop part files (.stl) or a zip of them.",
        );
        return;
      }
      await postParts(collected.imports);
    } catch (error) {
      setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not add parts");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const pending = collectKitFilesFromDataTransfer(event.dataTransfer);
    setBusy(true);
    setNote("Reading part files…");
    void (async () => {
      try {
        const collected = await pending;
        if (collected.imports.length === 0) {
          setNote("No .stl files found. Drop the part files that were on this plate.");
          return;
        }
        await postParts(collected.imports);
      } catch (error) {
        setNote(
          error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not add parts",
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const setStatus = async (bitId: number, status: PrintPlateBitStatus) => {
    setBusy(true);
    try {
      const response = await apiRequest(
        "PATCH",
        `/api/prints/${recordId}/bits/${bitId}`,
        { status },
        { headers },
      );
      const body = (await response.json()) as BitsResponse & { bit: PrintPlateBit };
      apply(body);
      setNote(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not update part");
    } finally {
      setBusy(false);
    }
  };

  const removeBit = async (bitId: number) => {
    setBusy(true);
    try {
      const response = await apiRequest(
        "DELETE",
        `/api/prints/${recordId}/bits/${bitId}`,
        undefined,
        { headers },
      );
      const body = (await response.json()) as BitsResponse;
      apply(body, "Part removed from this plate.");
      if (selectedBitId === bitId) setSelectedBitId(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not remove part");
    } finally {
      setBusy(false);
    }
  };

  const markRemainingGood = async () => {
    const awaiting = bits.filter((bit) => bit.status === "on_plate");
    if (awaiting.length === 0) return;
    setBusy(true);
    try {
      let last: BitsResponse | null = null;
      for (const bit of awaiting) {
        const response = await apiRequest(
          "PATCH",
          `/api/prints/${recordId}/bits/${bit.id}`,
          { status: "good" },
          { headers },
        );
        last = (await response.json()) as BitsResponse;
      }
      if (last) {
        apply(last, `Marked ${awaiting.length} remaining part${awaiting.length === 1 ? "" : "s"} good.`);
      }
    } catch (error) {
      setNote(
        error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not mark remaining good",
      );
    } finally {
      setBusy(false);
    }
  };

  const filteredBits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bits.filter((bit) => {
      if (statusFilter !== "all" && bit.status !== statusFilter) return false;
      if (!q) return true;
      return bit.label.toLowerCase().includes(q) || bit.fileName.toLowerCase().includes(q);
    });
  }, [bits, filter, statusFilter]);

  const groupedBits = useMemo(() => {
    const groups = new Map<string, PrintPlateBit[]>();
    for (const bit of filteredBits) {
      const group = groupByFileName[fileKey(bit.fileName)] || "Parts";
      const list = groups.get(group) ?? [];
      list.push(bit);
      groups.set(group, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === "Parts") return 1;
      if (b === "Parts") return -1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  }, [filteredBits, groupByFileName]);

  const showGroupHeaders = groupedBits.length > 1 || (groupedBits[0]?.[0] !== "Parts" && groupedBits.length === 1);
  const selectedBit = bits.find((bit) => bit.id === selectedBitId) ?? null;
  const previewFile = selectedBit ? stlByFileName[fileKey(selectedBit.fileName)] ?? null : null;
  const previewAvailableCount = bits.filter((bit) => stlByFileName[fileKey(bit.fileName)]).length;

  return (
    <div className="mt-3 space-y-2" data-testid={`panel-plate-bits-${recordId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          Parts on this plate
          {summary.total > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {summary.total} total · {summary.good} good · {summary.onPlate} awaiting · {summary.reprint}{" "}
              reprint
            </span>
          ) : null}
        </p>
        {summary.onPlate > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => void markRemainingGood()}
            data-testid={`button-mark-remaining-good-${recordId}`}
          >
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            Mark remaining good ({summary.onPlate})
          </Button>
        ) : null}
      </div>

      <div
        className={cn(
          "rounded-md border border-dashed px-3 py-2.5 transition-colors",
          dragActive ? "border-primary bg-primary/10" : "border-border bg-muted/20",
        )}
        onDragEnter={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer.types.includes("Files")) setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer.types.includes("Files")) {
            event.dataTransfer.dropEffect = "copy";
            setDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          setDragActive(false);
        }}
        onDrop={onDrop}
        data-testid={`dropzone-plate-bits-${recordId}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Drop the .stl files (or a zip) from this plate. Names are recorded for QC; meshes stay local for
            3D preview in this tab.
          </p>
          <label className="inline-flex">
            <input
              type="file"
              className="hidden"
              accept=".stl,.zip,model/stl,application/zip"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = "";
                if (files.length) void addFromFiles(files);
              }}
              data-testid={`input-plate-bits-${recordId}`}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={(event) => {
                const input = (event.currentTarget.previousSibling ||
                  event.currentTarget.parentElement?.querySelector("input")) as HTMLInputElement | null;
                input?.click();
              }}
              data-testid={`button-add-plate-bits-${recordId}`}
            >
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
              Add STLs
            </Button>
          </label>
        </div>
      </div>

      {note ? (
        <p className="text-xs text-muted-foreground" data-testid={`text-plate-bits-note-${recordId}`}>
          {note}
        </p>
      ) : null}

      {bits.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,18rem)]">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[10rem] flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-sm"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter parts"
                  data-testid={`input-plate-bits-filter-${recordId}`}
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["all", `All (${bits.length})`],
                    ["on_plate", `Awaiting (${summary.onPlate})`],
                    ["good", `Good (${summary.good})`],
                    ["reprint", `Reprint (${summary.reprint})`],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[0.6875rem] font-medium transition-colors",
                      statusFilter === value
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50",
                    )}
                    data-testid={`button-plate-bits-filter-${recordId}-${value}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <ul
              className="max-h-[min(28rem,50vh)] space-y-1 overflow-y-auto overscroll-contain rounded-md border border-border/70 bg-muted/15 p-1.5"
              data-testid={`list-plate-bits-${recordId}`}
            >
              {filteredBits.length === 0 ? (
                <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No parts match this filter.
                </li>
              ) : (
                groupedBits.map(([groupName, groupBits]) => (
                  <li key={groupName} className="space-y-1">
                    {showGroupHeaders ? (
                      <p className="sticky top-0 z-10 bg-muted/90 px-1.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
                        {groupName}
                        <span className="ml-1.5 font-normal normal-case tracking-normal">
                          ({groupBits.length})
                        </span>
                      </p>
                    ) : null}
                    <ul className="space-y-0.5">
                      {groupBits.map((bit) => {
                        const hasPreview = Boolean(stlByFileName[fileKey(bit.fileName)]);
                        const selected = selectedBitId === bit.id;
                        return (
                          <li key={bit.id}>
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => setSelectedBitId(bit.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setSelectedBitId(bit.id);
                                }
                              }}
                              onDoubleClick={() => {
                                if (hasPreview) setSelectedBitId(bit.id);
                              }}
                              className={cn(
                                "flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-sm transition-colors",
                                selected
                                  ? "border-primary/40 bg-primary/10"
                                  : "border-transparent bg-background/80 hover:border-border hover:bg-background",
                                bit.status === "reprint" && !selected && "bg-destructive/5",
                                bit.status === "good" && !selected && "opacity-80",
                              )}
                              data-testid={`row-plate-bit-${bit.id}`}
                            >
                              <span
                                className={cn(
                                  "h-2 w-2 shrink-0 rounded-full",
                                  bit.status === "good" && "bg-chart-4",
                                  bit.status === "reprint" && "bg-destructive",
                                  bit.status === "on_plate" && "bg-muted-foreground/50",
                                )}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1 truncate font-medium">{bit.label}</span>
                              <span className="hidden shrink-0 text-[0.625rem] uppercase tracking-wide text-muted-foreground sm:inline">
                                {partStatusLabel(bit.status)}
                              </span>
                              <div
                                className="flex shrink-0 items-center gap-0.5"
                                onClick={(event) => event.stopPropagation()}
                              >
                                {hasPreview ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant={selected ? "secondary" : "ghost"}
                                    className="h-7 w-7 px-0"
                                    title="Preview STL"
                                    disabled={busy}
                                    onClick={() => setSelectedBitId(bit.id)}
                                    data-testid={`button-bit-preview-${bit.id}`}
                                  >
                                    <Box className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={bit.status === "good" ? "default" : "ghost"}
                                  className="h-7 w-7 px-0"
                                  title="Mark good"
                                  disabled={busy}
                                  onClick={() => void setStatus(bit.id, "good")}
                                  data-testid={`button-bit-good-${bit.id}`}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={bit.status === "reprint" ? "default" : "ghost"}
                                  className="h-7 w-7 px-0"
                                  title="Mark reprint"
                                  disabled={busy}
                                  onClick={() => void setStatus(bit.id, "reprint")}
                                  data-testid={`button-bit-reprint-${bit.id}`}
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 px-0 text-muted-foreground hover:text-destructive"
                                  title="Remove"
                                  disabled={busy}
                                  onClick={() => void removeBit(bit.id)}
                                  data-testid={`button-bit-remove-${bit.id}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="min-w-0 lg:sticky lg:top-2 lg:self-start" data-testid={`panel-plate-bit-preview-${recordId}`}>
            <StlPreview
              file={previewFile}
              label={selectedBit?.label}
              emptyHint={
                previewAvailableCount === 0
                  ? "Drop or re-add the .stl files for this plate to preview parts in 3D. Meshes stay in this browser tab."
                  : "Select a part with a local STL to compare against the physical print."
              }
              className="min-h-[16rem]"
              canvasClassName="h-64 md:h-72"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
