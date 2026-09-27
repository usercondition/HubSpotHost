import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatPacificUpdateStamp } from "@shared/ship-by";
import {
  PLATE_FILE_EXTENSIONS,
  PLATE_PRINTERS,
  guessPlatePrinter,
  isPlateFileName,
  type PlateFileRecord,
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

type Listed = { ok: true; files: PlateFileRecord[]; failures: PlateUploadFailure[] };

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
  const retryFile = useRef<File | null>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [printer, setPrinter] = useState("");
  const [notes, setNotes] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [localError, setLocalError] = useState("");

  const listed = useQuery({
    queryKey: ["/api/plate-files", orderKey],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/plate-files?orderKey=${encodeURIComponent(orderKey)}`, undefined, { headers });
      const body = (await response.json()) as Partial<Listed>;
      return {
        ok: true as const,
        files: Array.isArray(body.files) ? body.files : [],
        failures: Array.isArray(body.failures) ? body.failures : [],
      };
    },
  });

  async function send(nextFile: File, nextPrinter: string, nextNotes: string) {
    setLocalError("");
    setProgress(0);
    const params = new URLSearchParams({
      orderKey,
      fileName: nextFile.name,
      printer: nextPrinter,
      notes: nextNotes,
      kit,
      customer,
    });
    try {
      const body = await new Promise<{ ok?: boolean; reconnect?: boolean; error?: string; file?: PlateFileRecord }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/plate-files/upload?${params.toString()}`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) setProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          let parsed: { ok?: boolean; reconnect?: boolean; error?: string; file?: PlateFileRecord } = {};
          try {
            parsed = JSON.parse(xhr.responseText) as typeof parsed;
          } catch {
            parsed = {};
          }
          if (xhr.status >= 200 && xhr.status < 300 && parsed.file?.driveFileId) resolve(parsed);
          else reject(parsed.error || "Drive upload failed.");
        };
        xhr.onerror = () => reject("Drive upload failed.");
        xhr.send(nextFile);
      });
      if (!body.file?.driveFileId) throw new Error("Drive upload failed.");
      setFile(null);
      setNotes("");
      setOpen(false);
      retryFile.current = null;
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Drive upload failed.");
      setLocalError(message);
      retryFile.current = nextFile;
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files", orderKey] });
    } finally {
      setProgress(null);
    }
  }

  const files = listed.data?.files ?? [];
  const failures = listed.data?.failures ?? [];

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
              Uploading {Math.round(progress * 100)}%
            </p>
          ) : null}
        </div>
      ) : null}
      {localError ? (
        <p className="mb-2 text-sm text-destructive" data-testid="slice-upload-error">
          {localError}{" "}
          {retryFile.current ? (
            <button
              type="button"
              className="underline"
              data-testid="button-retry-slice"
              onClick={() => {
                const next = retryFile.current;
                if (next) void send(next, printer, notes);
              }}
            >
              Retry
            </button>
          ) : null}
          {/reconnect/i.test(localError) ? (
            <Link href="/setup" className="underline">
              Reconnect
            </Link>
          ) : null}
        </p>
      ) : null}
      {files.length === 0 && failures.length === 0 ? (
        <p className="text-sm text-muted-foreground">No slice files yet.</p>
      ) : null}
      <ul className="space-y-2">
        {files.map((item) => (
          <li key={item.driveFileId} className="min-w-0" data-testid={`slice-file-${item.driveFileId}`}>
            <div className="grid grid-cols-[minmax(0,1fr)_4.75rem] items-baseline gap-2">
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
    </section>
  );
}
