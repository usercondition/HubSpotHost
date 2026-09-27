import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { plainDriveMessage, startPlateDownload, uploadPlateBytes } from "@/lib/plate-library-client";
import { PlateLayerView } from "@/components/plate-layer-view";

const PlateModelPreview = lazy(() => import("@/components/stl-preview").then((mod) => ({ default: mod.StlPreview })));
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

function PlateModelHost({ file, headers }: { file: PlateFileRecord; headers: Record<string, string> }) {
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file.modelDriveFileId) return;
    let cancelled = false;
    setModelFile(null);
    setError("");
    void apiRequest("GET", `/api/plate-files/${encodeURIComponent(file.driveFileId)}/model`, undefined, { headers })
      .then((response) => response.blob())
      .then((blob) => {
        if (cancelled) return;
        setModelFile(new File([blob], file.modelName || "model.stl"));
      })
      .catch(() => {
        if (!cancelled) setError("This plate has no 3D model.");
      });
    return () => {
      cancelled = true;
    };
  }, [file.driveFileId, file.modelDriveFileId, file.modelName, headers]);
  if (error) {
    return (
      <p className="mb-3 text-sm text-muted-foreground" data-testid="text-model-missing">
        {error}
      </p>
    );
  }
  return (
    <div className="plate-model-view" data-testid="plate-model-view">
      {modelFile ? (
        <Suspense fallback={null}>
          <PlateModelPreview file={modelFile} bare />
        </Suspense>
      ) : null}
    </div>
  );
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
  const canLayers = /\.ctb$/i.test(file.name);
  const canModel = Boolean(file.modelDriveFileId);
  const [mode, setMode] = useState<"layers" | "model">(canLayers ? "layers" : "model");
  const [imageUrl, setImageUrl] = useState("");
  const stats: PlatePreviewStats | null = file.stats;
  useEffect(() => {
    if (canLayers || canModel || !file.hasPreview || !file.sha256) return;
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
        className={`max-h-[90vh] w-full overflow-auto rounded-lg border border-border bg-card p-4 ${canLayers || canModel ? "max-w-3xl" : "max-w-lg"}`}
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
        {canLayers && canModel ? (
          <div className="plate-view-toggle" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "layers"}
              data-testid="button-view-layers"
              className={mode === "layers" ? "is-active" : ""}
              onClick={() => setMode("layers")}
            >
              Layers
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "model"}
              data-testid="button-view-model"
              className={mode === "model" ? "is-active" : ""}
              onClick={() => setMode("model")}
            >
              3D
            </button>
          </div>
        ) : null}
        {mode === "model" && canModel ? (
          <PlateModelHost file={file} headers={headers} />
        ) : canLayers ? (
          <PlateLayerView file={file} headers={headers} />
        ) : imageUrl ? (
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
  const queryClient = useQueryClient();
  const modelInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const canAttachModel = /\.ctb$/i.test(file.name);
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
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 text-sm shadow-md">
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
          {canAttachModel ? (
            <button
              type="button"
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
              data-testid={`button-add-model-${file.driveFileId}`}
              onClick={() => modelInputRef.current?.click()}
            >
              Add 3D model
            </button>
          ) : null}
        </div>
      ) : null}
      {canAttachModel ? (
        <input
          ref={modelInputRef}
          type="file"
          accept=".stl,.3mf,model/stl,model/3mf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid={`input-plate-model-${file.driveFileId}`}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (!picked) return;
            setOpen(false);
            setError("");
            void uploadPlateBytes({
              file: picked,
              orderKey: file.orderKeys[0] || "",
              printer: file.printer,
              notes: "",
              kit: file.kit,
              customer: "",
              sha256: "",
              headers,
              modelFor: file.driveFileId,
              onProgress: () => undefined,
            })
              .then((updated) => {
                void queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
                onPreview(updated);
              })
              .catch((reason: unknown) => {
                const raw = reason instanceof Error ? reason.message : "";
                setError(plainDriveMessage(raw, "Drive upload failed."));
              });
          }}
        />
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
