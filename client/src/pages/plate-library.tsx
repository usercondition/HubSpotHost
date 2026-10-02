import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { readHashQueryParam } from "@/lib/workflow";
import {
  LIBRARY_PRINTER_FILTERS,
  platePartName,
  usedOnOrders,
  type PlateFileRecord,
} from "@shared/plate-files";
import { PlateFileMenu, PlatePreviewHost, PlateThumb, usePlatePreview } from "@/components/plate-file-menu";

function formatFileSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.round((whole % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

function formatResin(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)} ml`;
}

function printerChipId(printer: string): string {
  return printer.toLowerCase().replace(/\s+/g, "-");
}

function kitSlug(kit: string): string {
  return kit.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kit";
}

function KitMenu({
  kit,
  kits,
  headers,
}: {
  kit: string;
  kits: string[];
  headers: Record<string, string>;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"" | "rename" | "merge">("");
  const [name, setName] = useState(kit);
  const [error, setError] = useState("");
  const others = kits.filter((item) => item !== kit);

  async function save(to: string) {
    const next = to.trim().replace(/\s+/g, " ");
    if (!next || next.toLowerCase() === kit.toLowerCase()) return;
    setError("");
    try {
      await apiRequest("POST", "/api/plate-files/kit", { from: kit, to: next }, { headers });
      setOpen(false);
      setMode("");
      await queryClient.invalidateQueries({ queryKey: ["/api/plate-files"] });
    } catch (reason) {
      setError(reason instanceof Error ? "Could not update that kit." : "Could not update that kit.");
    }
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Actions for ${kit}`}
        aria-expanded={open}
        data-testid={`button-kit-menu-${kitSlug(kit)}`}
        onClick={() => {
          setOpen((value) => !value);
          setMode("");
          setName(kit);
          setError("");
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div className="mt-1 w-full max-w-xs rounded-md border border-border bg-popover p-1 text-sm shadow-md">
          {mode === "" ? (
            <>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                data-testid={`button-rename-kit-${kitSlug(kit)}`}
                onClick={() => setMode("rename")}
              >
                Rename kit
              </button>
              <button
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                data-testid={`button-merge-kit-${kitSlug(kit)}`}
                onClick={() => setMode("merge")}
              >
                Merge into…
              </button>
            </>
          ) : null}
          {mode === "rename" ? (
            <form
              className="flex flex-wrap items-center gap-1 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void save(name);
              }}
            >
              <input
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={name}
                maxLength={180}
                data-testid={`input-rename-kit-${kitSlug(kit)}`}
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="rounded px-2 py-1 text-primary" data-testid={`button-save-kit-${kitSlug(kit)}`}>
                Save
              </button>
            </form>
          ) : null}
          {mode === "merge" ? (
            <form
              className="flex flex-wrap items-center gap-1 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                void save(name);
              }}
            >
              <select
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={others.includes(name) ? name : ""}
                data-testid={`select-merge-kit-${kitSlug(kit)}`}
                onChange={(event) => setName(event.target.value)}
              >
                <option value="">Choose a kit</option>
                {others.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded px-2 py-1 text-primary" data-testid={`button-save-kit-${kitSlug(kit)}`}>
                Merge
              </button>
            </form>
          ) : null}
          {error ? <p className="px-2 py-1 text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function PlateLibraryPage() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Library unlocked",
    successDescription: "Search sliced kits by name, part, or printer.",
  });
  const [q, setQ] = useState("");
  const [printer, setPrinter] = useState("");
  const [kit, setKit] = useState(() => readHashQueryParam("kit") ?? "");
  useEffect(() => {
    const sync = () => setKit(readHashQueryParam("kit") ?? "");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const filtering = Boolean(q.trim() || printer || kit);
  const preview = usePlatePreview();
  const library = useQuery({
    queryKey: ["/api/plate-files", "library", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/plate-files", undefined, { headers });
      const body = (await response.json()) as { files?: PlateFileRecord[] };
      return Array.isArray(body.files) ? body.files : [];
    },
  });
  const files = library.data ?? [];
  const kits = useMemo(() => {
    const names = new Set<string>();
    for (const file of files) names.add(file.kit.trim() || "Kit");
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [files]);
  const visible = useMemo(() => {
    const query = q.trim().toLowerCase();
    return files.filter((file) => {
      const fileKit = file.kit.trim() || "Kit";
      const filePart = platePartName(file.name);
      if (kit && fileKit !== kit) return false;
      if (printer && file.printer !== printer) return false;
      if (!query) return true;
      return [fileKit, filePart, file.name, file.printer].join(" ").toLowerCase().includes(query);
    });
  }, [files, kit, printer, q]);
  const grouped = useMemo(() => {
    const groups = new Map<string, PlateFileRecord[]>();
    for (const file of visible) {
      const fileKit = file.kit.trim() || "Kit";
      const rows = groups.get(fileKit) ?? [];
      rows.push(file);
      groups.set(fileKit, rows);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col" data-testid="page-library">
      <PageHeader title="Library" subtitle="Sliced kits you can print again without re-slicing." />
      <div className="page-stack px-4 md:px-8">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the slice library"
            description="Same owner code as Floor. Search plates by kit, part, or printer."
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
                placeholder="Search kit, part, file, or printer"
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
                {LIBRARY_PRINTER_FILTERS.map((option) => (
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
                {kit ? (
                  <button type="button" className="library-printer-chip" data-testid="chip-library-kit" data-active="true" onClick={() => setKit("")}>
                    {kit}
                  </button>
                ) : null}
              </div>
            </div>
            {library.isLoading ? <Skeleton className="h-40 rounded-lg" /> : null}
            {library.isError ? <p className="text-sm text-destructive">Could not load the slice library.</p> : null}
            {library.data && visible.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-library-empty">
                {filtering
                  ? "No slice files match that search. "
                  : "No slice files yet. "}
                Upload a slice file from an order on the Stack, or connect Google Drive in Setup.
              </p>
            ) : null}
            {visible.length > 0 ? (
              <div data-testid="library-list">
                <div className="library-head" aria-hidden="true">
                  <span />
                  <span>Part</span>
                  <span>Printer</span>
                  <span className="library-layers">Layers</span>
                  <span className="library-time">Time</span>
                  <span className="library-resin">Resin</span>
                  <span className="library-used">Orders</span>
                  <span className="library-size">Size</span>
                  <span />
                </div>
                {grouped.map(([group, rows]) => (
                  <section key={group} data-testid={`library-kit-${kitSlug(group)}`}>
                    <div className="library-kit">
                      <h2 className="min-w-0 truncate text-sm font-semibold">{group}</h2>
                      <KitMenu kit={group} kits={kits} headers={headers} />
                    </div>
                    {rows.map((file) => {
                      const filePart = platePartName(file.name);
                      const layers = file.stats?.layerCount != null ? String(file.stats.layerCount) : "—";
                      const time = formatDuration(file.stats?.printTimeSeconds);
                      const resin = formatResin(file.stats?.resinVolumeMl);
                      const used = usedOnOrders(file.orderKeys?.length ?? 0);
                      return (
                        <article key={file.driveFileId} className="library-row" data-testid={`library-row-${file.driveFileId}`}>
                          <PlateThumb file={file} headers={headers} onPreview={preview.setPreview} />
                          <div className="library-name-row">
                            <a
                              className="library-name"
                              href={file.webViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={filePart}
                              data-testid="library-file-name"
                            >
                              <span>{filePart}</span>
                              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                            </a>
                          </div>
                          <span className="library-printer truncate text-sm" data-testid="library-file-printer" title={file.printer || "Printer not set"}>
                            {file.printer || "Printer not set"}
                          </span>
                          <span className="library-layers text-sm" data-testid="library-file-layers">
                            {layers}
                          </span>
                          <span className="library-time text-sm" data-testid="library-file-time">
                            {time}
                          </span>
                          <span className="library-resin text-sm" data-testid="library-file-resin">
                            {resin}
                          </span>
                          <span className="library-used truncate text-sm" data-testid="library-file-used" title={used}>
                            {used}
                          </span>
                          <span className="library-size text-sm" data-testid="library-file-size">
                            {formatFileSize(file.sizeBytes)}
                          </span>
                          <div className="library-menu">
                            <PlateFileMenu file={file} headers={headers} onPreview={preview.setPreview} />
                          </div>
                          <p className="library-meta">
                            {[file.printer || "Printer not set", layers === "—" ? "" : `${layers} layers`, time === "—" ? "" : time, resin === "—" ? "" : resin, used]
                              .filter(Boolean)
                              .map((part, index) => (
                                <span key={index} className="library-meta-part">
                                  {part}
                                </span>
                              ))}
                          </p>
                        </article>
                      );
                    })}
                  </section>
                ))}
              </div>
            ) : null}
            <PlatePreviewHost file={preview.preview} headers={headers} onClose={() => preview.setPreview(null)} />
          </>
        )}
      </div>
    </div>
  );
}
