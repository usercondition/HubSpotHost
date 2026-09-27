import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { readHashQueryParam } from "@/lib/workflow";
import { formatPacificUpdateStamp } from "@shared/ship-by";
import { PLATE_PRINTERS, type PlateFileRecord } from "@shared/plate-files";

function formatFileSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${Math.round(bytes)} B`;
}

function orderLabel(file: PlateFileRecord): string {
  const ids = file.orderKeys.map((key) =>
    key.startsWith("deal:") ? `Deal ${key.slice("deal:".length)}` : key.startsWith("offbook:") ? `Off-book ${key.slice("offbook:".length)}` : key,
  );
  const who = file.customer.trim();
  if (who && ids.length > 0) return `${who} · ${ids.join(", ")}`;
  if (ids.length > 0) return ids.join(", ");
  return who || "No order";
}

function printerChipId(printer: string): string {
  return printer.toLowerCase().replace(/\s+/g, "-");
}

function orderChipLabel(orderKey: string): string {
  if (orderKey.startsWith("deal:")) return `Deal ${orderKey.slice("deal:".length)}`;
  if (orderKey.startsWith("offbook:")) return `Off-book ${orderKey.slice("offbook:".length)}`;
  return orderKey;
}

export default function PlateLibraryPage() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Library unlocked",
    successDescription: "Search slice files across orders.",
  });
  const [q, setQ] = useState("");
  const [printer, setPrinter] = useState("");
  const [orderKey, setOrderKey] = useState(() => readHashQueryParam("orderKey") ?? "");
  useEffect(() => {
    const sync = () => setOrderKey(readHashQueryParam("orderKey") ?? "");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const filtering = Boolean(q.trim() || printer || orderKey);
  const library = useQuery({
    queryKey: ["/api/plate-files", "library", ownerCode, q, printer, orderKey],
    enabled: isUnlocked,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (printer) params.set("printer", printer);
      if (orderKey) params.set("orderKey", orderKey);
      const response = await apiRequest("GET", `/api/plate-files?${params.toString()}`, undefined, { headers });
      const body = (await response.json()) as { files?: PlateFileRecord[] };
      return Array.isArray(body.files) ? body.files : [];
    },
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col" data-testid="page-library">
      <PageHeader title="Library" subtitle="Slice files stored in Google Drive, across every order." />
      <div className="page-stack px-4 md:px-8">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the slice library"
            description="Same owner code as Floor. Search plates by kit, printer, or customer."
            buttonLabel="Unlock Library"
            testIdPrefix="library"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : (
          <>
            <div className="mb-3 flex min-w-0 flex-col gap-2">
              <input
                className="h-9 min-w-0 w-full rounded-md border border-input bg-background px-2 text-sm"
                placeholder="Search kit, customer, order, printer, or file"
                value={q}
                data-testid="input-library-search"
                onChange={(event) => setQ(event.target.value)}
              />
              <div className="library-printer-chips" data-testid="library-printer-chips">
                <button
                  type="button"
                  className="library-printer-chip"
                  data-testid="chip-library-printer-all"
                  data-active={printer ? "false" : "true"}
                  onClick={() => setPrinter("")}
                >
                  All printers
                </button>
                {PLATE_PRINTERS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="library-printer-chip"
                    data-testid={`chip-library-printer-${printerChipId(option)}`}
                    data-active={printer === option ? "true" : "false"}
                    onClick={() => setPrinter(option)}
                  >
                    {option}
                  </button>
                ))}
                {orderKey ? (
                  <button type="button" className="library-printer-chip" data-testid="chip-library-order" data-active="true" onClick={() => setOrderKey("")}>
                    {orderChipLabel(orderKey)}
                  </button>
                ) : null}
              </div>
            </div>
            {library.isLoading ? <Skeleton className="h-40 rounded-lg" /> : null}
            {library.isError ? <p className="text-sm text-destructive">Could not load the slice library.</p> : null}
            {library.data && library.data.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-library-empty">
                {filtering
                  ? "No slice files match that search. "
                  : "No slice files yet. "}
                Upload a slice file from an order on the Stack, or connect Google Drive in Setup.
              </p>
            ) : null}
            {library.data && library.data.length > 0 ? (
              <div data-testid="library-list">
                <div className="library-head" aria-hidden="true">
                  <span>File</span>
                  <span>Printer</span>
                  <span>Order</span>
                  <span>Date</span>
                  <span className="library-size">Size</span>
                </div>
                {library.data.map((file) => {
                  const when = file.modifiedAt ? formatPacificUpdateStamp(file.modifiedAt) : "";
                  const linked = orderLabel(file);
                  return (
                    <article key={file.driveFileId} className="library-row" data-testid={`library-row-${file.driveFileId}`}>
                      <a
                        className="library-name"
                        href={file.webViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={file.name}
                        data-testid="library-file-name"
                      >
                        <span className="truncate">{file.name}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <span className="library-printer truncate text-sm" data-testid="library-file-printer" title={file.printer || "Printer not set"}>
                        {file.printer || "Printer not set"}
                      </span>
                      <span className="library-order truncate text-sm" data-testid="library-file-order" title={linked}>
                        {linked}
                      </span>
                      <span className="library-date truncate text-sm" data-testid="library-file-date">
                        {when}
                      </span>
                      <span className="library-size text-sm" data-testid="library-file-size">
                        {formatFileSize(file.sizeBytes)}
                      </span>
                      <p className="library-meta">
                        {[file.printer || "Printer not set", linked, when].filter(Boolean).join(" · ")}
                      </p>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
