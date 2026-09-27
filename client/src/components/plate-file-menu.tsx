import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { plainDriveMessage, startPlateDownload } from "@/lib/plate-library-client";
import { usedOnOrders, type PlateFileRecord, type PlatePreviewStats } from "@shared/plate-files";

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

function formatMeasure(value: number | null, suffix: string, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function formatCost(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function PreviewPanel({
  file,
  headers,
  onClose,
}: {
  file: PlateFileRecord;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  const [imageUrl, setImageUrl] = useState("");
  const stats: PlatePreviewStats | null = file.stats;
  useEffect(() => {
    if (!file.hasPreview || !file.sha256) return;
    let cancelled = false;
    let url = "";
    void apiRequest("GET", `/api/plate-previews/${file.sha256}`, undefined, { headers })
      .then((response) => response.blob())
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageUrl("");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.hasPreview, file.sha256, headers]);

  const rows = [
    ["Kit", file.kit || "—"],
    ["Orders", usedOnOrders(file.orderKeys.length)],
    ["Printer", stats?.printerProfile || file.printer || "—"],
    ["Layers", stats?.layerCount != null ? String(stats.layerCount) : "—"],
    ["Layer height", formatMeasure(stats?.layerHeightMm ?? null, " mm", 3)],
    ["Print time", formatDuration(stats?.printTimeSeconds ?? null)],
    ["Resin", formatMeasure(stats?.resinVolumeMl ?? null, " ml")],
    ["Cost", formatCost(stats?.resinCost ?? null)],
  ];

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 p-3 md:items-center" data-testid="panel-plate-preview" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-card p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="min-w-0 truncate text-base font-semibold" title={file.name}>
            {file.name}
          </h2>
          <button type="button" className="shrink-0 text-sm text-primary" data-testid="button-close-plate-preview" onClick={onClose}>
            Close
          </button>
        </div>
        {imageUrl ? (
          <img src={imageUrl} alt="" className="mb-3 max-h-48 w-full rounded-md bg-black object-contain md:max-h-80" data-testid="img-plate-preview" />
        ) : (
          <p className="mb-3 text-sm text-muted-foreground" data-testid="text-plate-preview-missing">
            No thumbnail in this file.
          </p>
        )}
        <dl className="plate-preview-stats" data-testid="plate-preview-stats">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function PlateFileMenu({
  file,
  headers,
  onPreview,
  buttonTestId,
  sendToLibrary,
}: {
  file: PlateFileRecord;
  headers: Record<string, string>;
  onPreview: (file: PlateFileRecord) => void;
  buttonTestId?: string;
  sendToLibrary?: { recordId: number; onSend: () => void } | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Actions for ${file.name}`}
        data-testid={buttonTestId ?? `button-plate-menu-${file.driveFileId}`}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-border bg-popover p-1 text-sm shadow-md">
          {sendToLibrary ? (
            <button
              type="button"
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
              data-testid={`button-send-to-library-${sendToLibrary.recordId}`}
              onClick={() => {
                setOpen(false);
                sendToLibrary.onSend();
              }}
            >
              Send to Library
            </button>
          ) : null}
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
            data-testid={`button-preview-plate-${file.driveFileId}`}
            onClick={() => {
              setOpen(false);
              onPreview(file);
            }}
          >
            Preview
          </button>
          <button
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
            data-testid={`button-download-plate-${file.driveFileId}`}
            onClick={() => {
              setOpen(false);
              setError("");
              void startPlateDownload(file.driveFileId, headers).catch((reason: unknown) => {
                const raw = reason instanceof Error ? reason.message : "";
                setError(plainDriveMessage(raw, "Drive could not read that file."));
              });
            }}
          >
            Download
          </button>
          <a className="block rounded px-2 py-1.5 hover:bg-muted" href={file.webViewLink} target="_blank" rel="noopener noreferrer">
            Open in Drive
          </a>
        </div>
      ) : null}
      {error ? (
        <p
          className="fixed bottom-3 left-3 right-3 z-[80] mx-auto max-w-sm rounded-md border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive shadow-md"
          role="alert"
          data-testid="text-plate-download-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PlateThumb({
  file,
  headers,
  onPreview,
}: {
  file: PlateFileRecord;
  headers: Record<string, string>;
  onPreview: (file: PlateFileRecord) => void;
}) {
  const [imageUrl, setImageUrl] = useState("");
  useEffect(() => {
    if (!file.hasPreview || !file.sha256) return;
    let cancelled = false;
    let url = "";
    void apiRequest("GET", `/api/plate-previews/${file.sha256}`, undefined, { headers })
      .then((response) => response.blob())
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.hasPreview, file.sha256, file.driveFileId, headers]);
  return (
    <button
      type="button"
      className="plate-thumb"
      data-testid={`button-plate-thumb-${file.driveFileId}`}
      aria-label={`Preview ${file.name}`}
      onClick={() => onPreview(file)}
    >
      {imageUrl ? <img src={imageUrl} alt="" /> : <span className="plate-thumb-empty" />}
    </button>
  );
}

export function usePlatePreview() {
  const [preview, setPreview] = useState<PlateFileRecord | null>(null);
  return { preview, setPreview };
}

export function PlatePreviewHost({
  file,
  headers,
  onClose,
}: {
  file: PlateFileRecord | null;
  headers: Record<string, string>;
  onClose: () => void;
}) {
  if (!file || typeof document === "undefined") return null;
  return createPortal(<PreviewPanel file={file} headers={headers} onClose={onClose} />, document.body);
}
