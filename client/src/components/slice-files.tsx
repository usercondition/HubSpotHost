import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { commitSliceToOrder, fingerprintFile, heldSliceFile, plainDriveMessage, SlicePrinterChoiceError } from "@/lib/plate-library-client";
import { PlateFileMenu, PlatePreviewHost, PlateThumb, usePlatePreview } from "@/components/plate-file-menu";
import { formatPacificUpdateStamp } from "@shared/ship-by";
import {
  PLATE_FILE_EXTENSIONS,
  PLATE_PRINTERS,
  guessPlatePrinter,
  isPlateFileName,
  type PlateFileRecord,
  type PlateLibraryPending,
  type PlateUploadFailure,
} from "@shared/plate-files";

function formatFileSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${Math.round(bytes)} B`;
}

type Listed = { ok: true; files: PlateFileRecord[]; failures: PlateUploadFailure[]; pending: PlateLibraryPending[] };

export function SliceFiles({
  orderKey,
  kit,
  customer,
  headers,
}: {
  orderKey: string;
  kit: string;
  customer: string;
  headers: Record<string, string>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingInput = useRef<HTMLInputElement | null>(null);
  const pendingTarget = useRef<PlateLibraryPending | null>(null);
  const [pendingMenu, setPendingMenu] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [printer, setPrinter] = useState("");
  const [notes, setNotes] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [fleetPrinterId, setFleetPrinterId] = useState("");
  const [fleetChoices, setFleetChoices] = useState<Array<{ id: number; name: string }>>([]);
  const [localError, setLocalError] = useState("");
  const preview = usePlatePreview();

  const listed = useQuery({
    queryKey: ["/api/plate-files", orderKey],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/plate-files?orderKey=${encodeURIComponent(orderKey)}`, undefined, { headers });
      const body = (await response.json()) as Partial<Listed>;
      return {
        ok: true as const,
        files: Array.isArray(body.files) ? body.files : [],
        failures: Array.isArray(body.failures) ? body.failures : [],
        pending: Array.isArray(body.pending) ? body.pending : [],
      };
    },
  });

  async function send(nextFile: File, nextPrinter: string, nextNotes: string) {
    setLocalError("");
    setProgress(0);
    setProgressLabel("Reading the plate");
    try {
      const result = await commitSliceToOrder({
        file: nextFile,
        orderKey,
        headers,
        kit,
        customer,
        printer: nextPrinter,
        notes: nextNotes,
        printerId: fleetPrinterId ? Number(fleetPrinterId) : null,
        onProgress: (label, fraction) => {
          setProgressLabel(label);
          setProgress(fraction);
        },
      });
      setFleetChoices([]);
      setFleetPrinterId("");
      if (result.library === "pending" && !result.record) {
        setLocalError(plainDriveMessage(result.libraryError || "Not in Library yet."));
      } else {
        setFile(null);
        setNotes("");
        setOpen(false);
        setLocalError("");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/prints"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/priority-stack"] });
    } catch (error) {
      if (error instanceof SlicePrinterChoiceError) {
        setFleetChoices(error.printers);
        setLocalError(error.message);
      } else {
        setLocalError(plainDriveMessage(error instanceof Error ? error.message : ""));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files", orderKey] });
    } finally {
      setProgress(null);
      setProgressLabel("");
    }
  }

  const files = listed.data?.files ?? [];
  const failures = listed.data?.failures ?? [];
  const pending = listed.data?.pending ?? [];

  return (
    <section className="mt-3" data-testid="slice-files">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Files</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href={`/library?orderKey=${encodeURIComponent(orderKey)}`} className="text-xs font-medium text-primary" data-testid="link-see-in-library">
            See in library
          </Link>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen((value) => !value)} data-testid="button-add-slice-file">
            Add slice file
          </Button>
        </div>
      </div>
      {open ? (
        <div className="mb-2 space-y-2 rounded-md border border-border p-2">
          <input
            ref={fileRef}
            type="file"
            accept={PLATE_FILE_EXTENSIONS.join(",")}
            className="block w-full min-w-0 text-sm"
            data-testid="input-slice-file"
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setFile(next);
              if (next && isPlateFileName(next.name)) {
                const guessed = guessPlatePrinter(next.name);
                if (guessed) setPrinter(guessed);
              }
              if (next && !isPlateFileName(next.name)) setLocalError("That file type is not a slice or mesh.");
              else setLocalError("");
            }}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select
              className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
              value={printer}
              data-testid="select-slice-printer"
              onChange={(event) => setPrinter(event.target.value)}
            >
              <option value="">Printer</option>
              {PLATE_PRINTERS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <input
              className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
              placeholder="Notes"
              value={notes}
              maxLength={2000}
              data-testid="input-slice-notes"
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          {fleetChoices.length > 0 ? (
            <select
              className="h-9 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={fleetPrinterId}
              data-testid="select-slice-fleet-printer"
              onChange={(event) => setFleetPrinterId(event.target.value)}
            >
              <option value="">Which printer ran this plate</option>
              {fleetChoices.map((option) => (
                <option key={option.id} value={String(option.id)}>
                  {option.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={!file || progress != null || !isPlateFileName(file.name)}
            data-testid="button-upload-slice"
            onClick={() => {
              if (file) void send(file, printer, notes);
            }}
          >
            {progress != null ? "Uploading" : "Upload"}
          </Button>
          {progress != null ? (
            <p className="text-xs text-muted-foreground" data-testid="slice-upload-progress">
              {progressLabel === "Sending to Library" ? `Sending to Library ${Math.round(progress * 100)}%` : progressLabel || "Uploading"}
            </p>
          ) : null}
        </div>
      ) : null}
      {localError ? (
        <p className="mb-2 text-sm text-destructive" data-testid="slice-upload-error">
          {plainDriveMessage(localError)}
          {/not in library|reconnect/i.test(localError) ? (
            <>
              {" "}
              <Link href="/setup" className="underline" data-testid="link-connect-drive">
                Connect Drive
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {files.length === 0 && failures.length === 0 && pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">No slice files yet.</p>
      ) : null}
      <ul className="space-y-2">
        {pending.map((item) => (
          <li key={item.printRecordId} className="min-w-0" data-testid={`slice-library-pending-${item.printRecordId}`}>
            <div className="grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="text-xs text-muted-foreground" data-testid={`text-slice-pending-${item.printRecordId}`}>
                  Not in Library
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Actions for ${item.name}`}
                aria-expanded={pendingMenu === item.printRecordId}
                data-testid={`button-pending-menu-${item.printRecordId}`}
                onClick={() => setPendingMenu((current) => (current === item.printRecordId ? null : item.printRecordId))}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </div>
            {pendingMenu === item.printRecordId ? (
              <div className="mt-1 w-full max-w-[11rem] rounded-md border border-border bg-popover p-1 text-sm shadow-md">
                <button
                  type="button"
                  className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                  data-testid={`button-send-to-library-${item.printRecordId}`}
                  onClick={() => {
                    setPendingMenu(null);
                    pendingTarget.current = item;
                    const held = heldSliceFile(item.sha256);
                    if (!held) {
                      pendingInput.current?.click();
                      return;
                    }
                    void fingerprintFile(held).then((sha) => {
                      if (sha !== item.sha256) {
                        setLocalError("That file does not match this plate.");
                        return;
                      }
                      void send(held, printer, notes);
                    });
                  }}
                >
                  Send to Library
                </button>
              </div>
            ) : null}
          </li>
        ))}
        {files.map((item) => (
          <li key={item.driveFileId} className="min-w-0" data-testid={`slice-file-${item.driveFileId}`}>
            <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_4.75rem_1.75rem] items-center gap-2">
              <PlateThumb file={item} headers={headers} onPreview={preview.setPreview} />
              <a
                href={item.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1 text-sm font-medium text-primary"
                title={item.name}
                data-testid="slice-file-name"
              >
                <span className="truncate">{item.name}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
              <span className="w-[4.75rem] text-right text-sm tabular-nums" data-testid="slice-file-size">
                {formatFileSize(item.sizeBytes)}
              </span>
              <PlateFileMenu file={item} headers={headers} onPreview={preview.setPreview} />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              <span data-testid="slice-file-printer">{item.printer || "Printer not set"}</span>
              {item.modifiedAt ? <span data-testid="slice-file-date"> · {formatPacificUpdateStamp(item.modifiedAt)}</span> : null}
            </p>
          </li>
        ))}
        {failures.map((item) => (
          <li key={item.id} className="min-w-0 text-sm" data-testid="slice-upload-failure">
            <p className="truncate font-medium">{item.name}</p>
            <p className="text-destructive">
              {item.error}{" "}
              <button
                type="button"
                className="underline"
                data-testid="button-retry-slice-saved"
                onClick={() => fileRef.current?.click()}
              >
                Choose the file again
              </button>
            </p>
          </li>
        ))}
      </ul>
      <input
        ref={pendingInput}
        type="file"
        accept={PLATE_FILE_EXTENSIONS.join(",")}
        className="hidden"
        data-testid="input-send-pending-to-library"
        onChange={(event) => {
          const next = event.target.files?.[0] ?? null;
          event.target.value = "";
          const target = pendingTarget.current;
          if (!next || !target) return;
          void fingerprintFile(next).then((sha) => {
            if (sha !== target.sha256) {
              setLocalError("That file does not match this plate.");
              return;
            }
            void send(next, printer || guessPlatePrinter(next.name), notes);
          });
        }}
      />
      <PlatePreviewHost file={preview.preview} headers={headers} onClose={() => preview.setPreview(null)} />
    </section>
  );
}
