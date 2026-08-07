/**
 * Order parts checklist dialog — import full kit, track needed → plate → good/reprint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Package, RotateCcw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { printsDealHref } from "@/lib/workflow";
import { collectKitFilesFromFileList } from "@/lib/stl-folder-import";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { OrderPart, OrderPartStatus } from "@shared/schema";

export type OrderPartSummary = {
  hubspotDealId: string;
  hubspotDealName: string;
  total: number;
  needed: number;
  onPlate: number;
  good: number;
  reprint: number;
  remaining: number;
};

type PartsResponse = {
  ok: true;
  dealId: string;
  dealName: string;
  parts: OrderPart[];
  summary: Omit<OrderPartSummary, "hubspotDealId" | "hubspotDealName">;
  added?: number;
};

function statusLabel(status: string): string {
  switch (status) {
    case "good":
      return "Good";
    case "reprint":
      return "Reprint";
    case "on_plate":
      return "On plate";
    default:
      return "Needed";
  }
}

export function OrderPartsDialog({
  dealId,
  dealName,
  open,
  onOpenChange,
  headers,
}: {
  dealId: string | null;
  dealName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headers: Record<string, string>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const partsQuery = useQuery<PartsResponse>({
    queryKey: ["/api/orders", dealId, "parts"],
    enabled: open && Boolean(dealId),
    queryFn: async () => {
      const response = await apiRequest(
        "GET",
        `/api/orders/${encodeURIComponent(dealId!)}/parts`,
        undefined,
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
  });

  useEffect(() => {
    if (!open) {
      setFilter("");
      setNote(null);
    }
  }, [open]);

  const importParts = useMutation({
    mutationFn: async (files: File[]) => {
      const collected = await collectKitFilesFromFileList(files);
      const fileNames = collected.imports.map((item) => item.fileName);
      if (fileNames.length === 0) {
        throw new Error(
          collected.unsupportedArchives.length > 0
            ? `No .stl files found. ${collected.unsupportedArchives.slice(0, 2).join("; ")}`
            : "No .stl files found. Drop a kit folder or .zip of parts.",
        );
      }
      const response = await apiRequest(
        "POST",
        `/api/orders/${encodeURIComponent(dealId!)}/parts/import`,
        { fileNames, dealName },
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
    onSuccess: (body) => {
      queryClient.setQueryData(["/api/orders", dealId, "parts"], body);
      queryClient.invalidateQueries({ queryKey: ["/api/order-parts/summaries"] });
      setNote(
        body.added
          ? `Added ${body.added} part${body.added === 1 ? "" : "s"} to this order.`
          : "Those parts were already on this order.",
      );
    },
    onError: (error: Error) => {
      setNote(error.message.replace(/^\d+:\s*/, ""));
    },
  });

  const patchStatus = useMutation({
    mutationFn: async (input: { partId: number; status: OrderPartStatus }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/orders/${encodeURIComponent(dealId!)}/parts/${input.partId}`,
        { status: input.status },
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
    onSuccess: (body) => {
      queryClient.setQueryData(["/api/orders", dealId, "parts"], body);
      queryClient.invalidateQueries({ queryKey: ["/api/order-parts/summaries"] });
      setNote(null);
    },
  });

  const removePart = useMutation({
    mutationFn: async (partId: number) => {
      const response = await apiRequest(
        "DELETE",
        `/api/orders/${encodeURIComponent(dealId!)}/parts/${partId}`,
        undefined,
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
    onSuccess: (body) => {
      queryClient.setQueryData(["/api/orders", dealId, "parts"], body);
      queryClient.invalidateQueries({ queryKey: ["/api/order-parts/summaries"] });
      setNote("Part removed.");
    },
  });

  const clearAll = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "DELETE",
        `/api/orders/${encodeURIComponent(dealId!)}/parts`,
        undefined,
        { headers },
      );
      return (await response.json()) as PartsResponse;
    },
    onSuccess: (body) => {
      queryClient.setQueryData(["/api/orders", dealId, "parts"], {
        ...body,
        dealName,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/order-parts/summaries"] });
      setNote("Cleared parts list for this order.");
    },
  });

  const summary = partsQuery.data?.summary;
  const parts = partsQuery.data?.parts ?? [];
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return parts;
    return parts.filter(
      (part) => part.label.toLowerCase().includes(q) || part.fileName.toLowerCase().includes(q),
    );
  }, [parts, filter]);

  const busy =
    importParts.isPending || patchStatus.isPending || removePart.isPending || clearAll.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] max-w-2xl overflow-y-auto"
        data-testid="dialog-order-parts"
      >
        <DialogHeader>
          <DialogTitle data-testid="text-order-parts-title">Parts for this order</DialogTitle>
          <DialogDescription>
            {dealName}. Import the full kit once. As you drop STLs onto attached plates in Prints,
            those parts move off the needed list until everything is accounted for.
          </DialogDescription>
        </DialogHeader>

        {summary ? (
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-5"
            data-testid="panel-order-parts-summary"
          >
            <SummaryChip label="Total" value={summary.total} />
            <SummaryChip label="Needed" value={summary.needed} />
            <SummaryChip label="On plate" value={summary.onPlate} />
            <SummaryChip label="Good" value={summary.good} good />
            <SummaryChip label="Left" value={summary.remaining} warn={summary.remaining > 0} />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".stl,.zip,model/stl,application/zip"
            multiple
            // @ts-expect-error webkitdirectory is supported in Chromium
            webkitdirectory=""
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              if (files.length) importParts.mutate(files);
            }}
            data-testid="input-order-parts-folder"
          />
          <input
            type="file"
            className="hidden"
            id="order-parts-zip"
            accept=".stl,.zip,model/stl,application/zip"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              if (files.length) importParts.mutate(files);
            }}
            data-testid="input-order-parts-zip"
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !dealId}
            onClick={() => fileInputRef.current?.click()}
            data-testid="button-import-order-parts-folder"
          >
            {importParts.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Import kit folder
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !dealId}
            onClick={() => document.getElementById("order-parts-zip")?.click()}
            data-testid="button-import-order-parts-zip"
          >
            Import zip / STLs
          </Button>
          {dealId ? (
            <Button asChild type="button" size="sm" variant="ghost">
              <Link href={printsDealHref(dealId)} data-testid="link-order-parts-prints">
                Open Prints
              </Link>
            </Button>
          ) : null}
          {parts.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => clearAll.mutate()}
              data-testid="button-clear-order-parts"
            >
              Clear list
            </Button>
          ) : null}
        </div>

        {note ? (
          <p className="text-xs text-muted-foreground" data-testid="text-order-parts-note">
            {note}
          </p>
        ) : null}

        {partsQuery.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading parts…</p>
        ) : parts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
            <Package className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No parts list yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Import the kit folder or zip for this client order. Then attach plates and drop the
              STLs that were on each plate — they subtract from this list.
            </p>
          </div>
        ) : (
          <>
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter parts"
              data-testid="input-order-parts-filter"
            />
            <ul className="max-h-[24rem] space-y-1 overflow-y-auto" data-testid="list-order-parts">
              {visible.map((part) => (
                <li
                  key={part.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 px-2.5 py-1.5 text-sm"
                  data-testid={`row-order-part-${part.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{part.label}</p>
                    <p className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                      {statusLabel(part.status)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={part.status === "good" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => patchStatus.mutate({ partId: part.id, status: "good" })}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      Good
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={part.status === "reprint" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => patchStatus.mutate({ partId: part.id, status: "reprint" })}
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />
                      Reprint
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => removePart.mutate(part.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryChip({
  label,
  value,
  good,
  warn,
}: {
  label: string;
  value: number;
  good?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2">
      <p className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-lg font-semibold numeric",
          good && "text-chart-4",
          warn && "text-primary",
        )}
      >
        {value}
      </p>
    </div>
  );
}
