/**
 * Drop STLs onto an attached plate to record which parts were on that plate.
 * Names are operator-declared — the slice file does not contain part names.
 */
import { useState } from "react";
import { CheckCircle2, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  collectKitFilesFromDataTransfer,
  collectKitFilesFromFileList,
} from "@/lib/stl-folder-import";
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

  const apply = (body: BitsResponse, message?: string) => {
    setBits(body.bits);
    setSummary(body.bitSummary);
    onChanged({ bits: body.bits, bitSummary: body.bitSummary });
    if (message) setNote(message);
  };

  const addFromFiles = async (files: File[]) => {
    setBusy(true);
    setNote("Reading part files…");
    try {
      const collected = await collectKitFilesFromFileList(files);
      const parts = collected.imports.map((item) => ({
        fileName: item.fileName,
        relativePath: item.relativePath,
        archivePath: item.archivePath,
      }));
      if (parts.length === 0) {
        setNote(
          collected.unsupportedArchives.length > 0
            ? `No .stl files found. ${collected.unsupportedArchives.slice(0, 2).join("; ")}`
            : "No .stl files found in that drop. Drop part files (.stl) or a zip of them.",
        );
        return;
      }
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
    } catch (error) {
      setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not add parts");
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    // Snapshot before the drop handler returns (DataTransfer clears).
    const pending = collectKitFilesFromDataTransfer(event.dataTransfer);
    setBusy(true);
    setNote("Reading part files…");
    void (async () => {
      try {
        const collected = await pending;
        const parts = collected.imports.map((item) => ({
          fileName: item.fileName,
          relativePath: item.relativePath,
          archivePath: item.archivePath,
        }));
        if (parts.length === 0) {
          setNote("No .stl files found. Drop the part files that were on this plate.");
          return;
        }
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
    } catch (error) {
      setNote(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not remove part");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-testid={`panel-plate-bits-${recordId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-foreground">
          Parts on this plate
          {summary.total > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {summary.good} good · {summary.onPlate} awaiting · {summary.reprint} reprint
            </span>
          ) : null}
        </p>
      </div>

      <div
        className={cn(
          "rounded-md border border-dashed px-3 py-3 transition-colors",
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
            Drop the .stl files (or a zip) that were on this CTB. This does not read the CTB — you
            are linking the parts that belong on this plate.
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
        <ul className="space-y-1" data-testid={`list-plate-bits-${recordId}`}>
          {bits.map((bit) => (
            <li
              key={bit.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-background px-2.5 py-1.5 text-sm"
              data-testid={`row-plate-bit-${bit.id}`}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{bit.label}</p>
                <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  {partStatusLabel(bit.status)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={bit.status === "good" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void setStatus(bit.id, "good")}
                  data-testid={`button-bit-good-${bit.id}`}
                >
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  Good
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={bit.status === "reprint" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void setStatus(bit.id, "reprint")}
                  data-testid={`button-bit-reprint-${bit.id}`}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  Reprint
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void removeBit(bit.id)}
                  data-testid={`button-bit-remove-${bit.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
