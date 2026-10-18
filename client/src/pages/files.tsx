import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Box, Copy, Download, ExternalLink, FileArchive, FileText, Film, Folder, Image as ImageIcon, Layers, Loader2, Search, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { cn } from "@/lib/utils";
import {
  DRIVE_CATEGORY_LABEL,
  DRIVE_CATEGORY_ONE,
  DRIVE_FILE_CATEGORIES,
  driveDownloadUrl,
  humanSize,
  type DriveFileCategory,
  type DriveFileView,
  type DriveFilesResponse,
} from "@shared/drive-files";

const PAGE = 36;
const CAT_ICON: Record<DriveFileCategory, typeof Box> = {
  model: Box, sliced: Layers, archive: FileArchive, photo: ImageIcon, video: Film, doc: FileText, folder: Folder, other: FileText,
};
const SOURCE_LABEL: Record<DriveFileView["thumbSource"], string | null> = {
  drive: null, "folder-photo": "Kit photo", render: "3D preview", web: "Web match", icon: null,
};

/** Query string inside the hash route (`#/files?q=…&cat=…`), reactive to hash changes. */
function useHashParams(): URLSearchParams {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      window.addEventListener("popstate", cb);
      return () => {
        window.removeEventListener("hashchange", cb);
        window.removeEventListener("popstate", cb);
      };
    },
    () => window.location.hash,
    () => "",
  );
  const i = hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : "");
}

function writeHashParams(q: string, cat: DriveFileCategory | null) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (cat) p.set("cat", cat);
  const next = `#/files${p.size ? `?${p}` : ""}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", next);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function fmtDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

function Thumb({ f, className }: { f: DriveFileView; className?: string }) {
  const Icon = CAT_ICON[f.category] ?? FileText;
  if (f.thumb) return <img src={f.thumb} alt="" loading="lazy" className={cn("h-full w-full object-cover", className)} />;
  return (
    <div className={cn("flex h-full w-full items-center justify-center bg-[hsl(var(--surface))]", className)}>
      <Icon className="h-10 w-10 text-[hsl(var(--amber))]" aria-hidden />
    </div>
  );
}

export default function FilesPage() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const unlock = useOwnerUnlock({ successTitle: "Files unlocked", successDescription: "Business Drive files only." });
  const params = useHashParams();
  const urlQ = params.get("q") ?? "";
  const urlCatRaw = params.get("cat");
  const urlCat = (DRIVE_FILE_CATEGORIES as readonly string[]).includes(urlCatRaw ?? "") ? (urlCatRaw as DriveFileCategory) : null;
  const [draft, setDraft] = useState(urlQ);
  const [open, setOpen] = useState<DriveFileView | null>(null);
  const { toast } = useToast();

  useEffect(() => setDraft(urlQ), [urlQ]);
  // Debounced live search; the URL stays the source of truth so Hermes deep links (?q=) just work.
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft.trim() !== urlQ) writeHashParams(draft.trim(), urlCat);
    }, 300);
    return () => clearTimeout(t);
  }, [draft, urlQ, urlCat]);

  const query = useInfiniteQuery<DriveFilesResponse>({
    queryKey: ["/api/files", urlQ, urlCat, ownerCode],
    enabled: isUnlocked,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const p = new URLSearchParams({ q: urlQ, offset: String(pageParam), limit: String(PAGE) });
      if (urlCat) p.set("cat", urlCat);
      return (await apiRequest("GET", `/api/files?${p}`, undefined, { headers })).json();
    },
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    staleTime: 60_000,
  });
  const first = query.data?.pages[0];
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const allCount = first ? Object.values(first.counts).reduce((s, n) => s + (n ?? 0), 0) : 0;

  async function share(f: DriveFileView) {
    if (!f.webViewLink) return;
    try {
      if (navigator.share) await navigator.share({ title: f.name, url: f.webViewLink });
      else {
        await navigator.clipboard.writeText(f.webViewLink);
        toast({ title: "Link copied", description: "Drive sharing settings are unchanged." });
      }
    } catch {
      /* share sheet dismissed */
    }
  }

  return (
    <div className="mx-auto max-w-6xl pb-24 md:pb-6" data-testid="page-files">
      <PageHeader title="Files" subtitle="Search the shop's Google Drive. Business files only, refreshed nightly." />
      {!isUnlocked ? (
        <OwnerUnlockPanel
          title="Unlock files"
          description="Enter the owner code to search Drive files."
          buttonLabel="Unlock files"
          testIdPrefix="files"
          pending={unlock.isPending}
          onUnlock={(code) => unlock.mutate(code)}
        />
      ) : (
        <div className="px-3 md:px-8">
          <div className="sticky top-0 z-10 -mx-3 bg-[hsl(var(--background))]/95 px-3 pb-2 pt-3 backdrop-blur md:static md:mx-0 md:px-0">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--text-3))]" aria-hidden />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Search name or folder, e.g. dark angels kill team"
                className="h-11 rounded-xl pl-9 pr-9 text-base"
                inputMode="search"
                enterKeyHint="search"
                data-testid="input-files-search"
              />
              {draft ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-[hsl(var(--text-3))]"
                  onClick={() => setDraft("")}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Category">
              {([null, ...DRIVE_FILE_CATEGORIES] as Array<DriveFileCategory | null>)
                .filter((c) => c === null || (first?.counts[c] ?? 0) > 0 || c === urlCat)
                .map((c) => {
                  const active = c === urlCat;
                  const n = c === null ? allCount : first?.counts[c] ?? 0;
                  return (
                    <button
                      key={c ?? "all"}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => writeHashParams(urlQ, c)}
                      className={cn(
                        "shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                        active
                          ? "border-[hsl(var(--amber))] bg-[hsl(var(--amber))] text-white"
                          : "border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--foreground))]",
                      )}
                      data-testid={`chip-files-${c ?? "all"}`}
                    >
                      {c === null ? "All" : DRIVE_CATEGORY_LABEL[c]}
                      {first ? <span className="ml-1 opacity-70">{n.toLocaleString()}</span> : null}
                    </button>
                  );
                })}
            </div>
          </div>

          {query.isLoading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-[hsl(var(--text-2))]"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>
          ) : query.isError ? (
            <p className="py-10 text-sm text-[hsl(var(--bad))]">Couldn't load files. {(query.error as Error).message}</p>
          ) : first && !first.configured ? (
            <p className="py-10 text-sm text-[hsl(var(--text-2))]" data-testid="text-files-not-synced">The Drive index hasn't been synced from the Mac mini yet.</p>
          ) : items.length === 0 ? (
            <p className="py-10 text-sm text-[hsl(var(--text-2))]" data-testid="text-files-empty">No files match{urlQ ? ` “${urlQ}”` : ""}.</p>
          ) : (
            <>
              <p className="mb-2 mt-1 text-xs text-[hsl(var(--text-3))]" data-testid="text-files-count">
                {first?.total.toLocaleString()} result{first?.total === 1 ? "" : "s"}
                {first?.generatedAt ? ` · index ${fmtDate(first.generatedAt)}` : ""}
              </p>
              <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4" data-testid="grid-files">
                {items.map((f, i) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setOpen(f)}
                      className="group block w-full overflow-hidden rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-left active:scale-[0.99]"
                      data-testid={`card-file-${i}`}
                    >
                      <div className="relative aspect-square overflow-hidden">
                        <Thumb f={f} />
                        {SOURCE_LABEL[f.thumbSource] ? (
                          <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                            {SOURCE_LABEL[f.thumbSource]}
                          </span>
                        ) : null}
                      </div>
                      <div className="p-2">
                        <p className="line-clamp-2 break-words text-[13px] font-semibold leading-tight">{f.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-[hsl(var(--text-2))]">
                          {DRIVE_CATEGORY_ONE[f.category]}
                          {f.size ? ` · ${humanSize(f.size)}` : ""}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {query.hasNextPage ? (
                <div className="flex justify-center py-4">
                  <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage} data-testid="button-files-more">
                    {query.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Show more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      <Sheet open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl p-0 md:mx-auto md:max-w-lg" data-testid="sheet-file">
          {open ? (
            <>
              <div className="relative aspect-[4/3] w-full overflow-hidden bg-[hsl(var(--surface))]">
                <Thumb f={open} className="object-contain" />
              </div>
              <div className="space-y-3 p-4">
                <SheetHeader className="text-left">
                  <SheetTitle className="break-words text-lg leading-snug">{open.name}</SheetTitle>
                  <SheetDescription className="break-words">{open.path || "My Drive"}</SheetDescription>
                </SheetHeader>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div><dt className="text-xs text-[hsl(var(--text-3))]">Type</dt><dd>{DRIVE_CATEGORY_ONE[open.category]}</dd></div>
                  <div><dt className="text-xs text-[hsl(var(--text-3))]">Size</dt><dd>{humanSize(open.size) || "—"}</dd></div>
                  <div><dt className="text-xs text-[hsl(var(--text-3))]">Modified</dt><dd>{fmtDate(open.modifiedTime) || "—"}</dd></div>
                </dl>
                {Object.keys(open.tags).length ? (
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(open.tags).map(([k, v]) => (
                      <span key={k} className="rounded-full bg-[hsl(var(--surface))] px-2 py-0.5 text-xs">{v}</span>
                    ))}
                  </div>
                ) : null}
                {open.thumbSource === "web" && open.webSourceUrl ? (
                  <p className="text-xs text-[hsl(var(--text-2))]">
                    Cover is a web match from{" "}
                    <a className="underline" href={open.webSourceUrl} target="_blank" rel="noreferrer">the creator's listing</a>.
                  </p>
                ) : null}
                <div className="grid grid-cols-3 gap-2 pb-[env(safe-area-inset-bottom)]">
                  <Button asChild className="bg-[hsl(var(--amber))] text-white hover:bg-[hsl(var(--amber))]/90" disabled={!open.webViewLink}>
                    <a href={open.webViewLink ?? "#"} target="_blank" rel="noreferrer" data-testid="button-file-open"><ExternalLink className="mr-1.5 h-4 w-4" />Open</a>
                  </Button>
                  {driveDownloadUrl(open) ? (
                    <Button asChild variant="outline">
                      <a href={driveDownloadUrl(open)!} target="_blank" rel="noreferrer" data-testid="button-file-download"><Download className="mr-1.5 h-4 w-4" />Download</a>
                    </Button>
                  ) : (
                    <Button variant="outline" disabled><Download className="mr-1.5 h-4 w-4" />Download</Button>
                  )}
                  <Button variant="outline" onClick={() => share(open)} data-testid="button-file-share">
                    {typeof navigator !== "undefined" && "share" in navigator ? <Share2 className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}Share link
                  </Button>
                </div>
                <p className="text-[11px] text-[hsl(var(--text-3))]">Share link copies the Drive link; it doesn't change who can open the file.</p>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
