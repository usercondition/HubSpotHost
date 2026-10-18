import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, FileText, Layers, Loader2, Moon, Paperclip, Play, RefreshCw, Sparkles, Upload, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import { PrinterArt } from "@/components/printer-art";
import { VoiceStart, type VoiceResult } from "@/components/printer-voice";
import { assignSliceFile, rejectSliceFileReason } from "@/lib/printer-assign";
import { describeLastRun, describeRunTimes, formatDurationShort, formatHours } from "@shared/printer-times";
import {
  ASSIGNABLE_SLICE_EXTENSIONS,
  buildPrinterStatusBoard,
  printerArt,
  shortPrinterName,
  splitJobLabel,
  type PrinterLiveStatus,
  type PrinterRun,
  type PrinterStatusBoard,
  type StartablePlate,
} from "@shared/printer-status";

type StatusResponse = PrinterStatusBoard & { ok: true; plates?: StartablePlate[] };

const QUERY_KEY = ["/api/printers/status"];

function hours(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "no print time";
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Recompute progress/remaining locally every 30 s between server refreshes. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function StatusBadge({ state, testId }: { state: PrinterLiveStatus["state"]; testId: string }) {
  const printing = state === "printing";
  return (
    <span
      className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold uppercase tracking-wider ${
        printing ? "bg-warn/15 text-warn ring-1 ring-inset ring-warn/40" : "bg-muted text-muted-foreground"
      }`}
      data-testid={testId}
    >
      <span className={`h-2 w-2 rounded-full ${printing ? "animate-pulse bg-warn" : "bg-muted-foreground/50"}`} aria-hidden />
      {printing ? "Printing" : "Idle"}
    </span>
  );
}

/** Friendly idle lines, picked by printer so each card keeps its own. */
const IDLE_LINES = [
  "Plate's up, vat's ready. Bring on the next one!",
  "Taking a breather. Ready when you are.",
  "All clear and waiting for the next masterpiece.",
  "Napping with one eye open. Start a job to wake it.",
  "Clean plate, happy printer.",
];
function idleLine(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return IDLE_LINES[h % IDLE_LINES.length]!;
}

function ProgressBar({ pct, label, testId }: { pct: number; label: string; testId: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        data-testid={testId}
      >
        <div className="printer-progress-fill h-full rounded-full" style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-lg font-bold tabular-nums text-warn">{pct}%</span>
    </div>
  );
}

function StartForm({
  printer,
  plates,
  pending,
  onStart,
  onCancel,
}: {
  printer: PrinterLiveStatus;
  plates: StartablePlate[];
  pending: boolean;
  onStart: (body: { recordId?: number; jobLabel?: string; estHours?: number }) => void;
  onCancel: () => void;
}) {
  const ordered = useMemo(() => {
    const score = (p: StartablePlate) => (p.suggestedPrinterKey === printer.key ? 0 : 2) + (p.started ? 1 : 0);
    return [...plates].sort((a, b) => score(a) - score(b));
  }, [plates, printer.key]);
  const [choice, setChoice] = useState<string>(ordered[0] ? String(ordered[0].recordId) : "other");
  const [label, setLabel] = useState("");
  const [hrs, setHrs] = useState("");
  const other = choice === "other";
  const id = `start-${printer.key}`;

  return (
    <form
      className="mt-3 space-y-3 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (other) onStart({ jobLabel: label.trim(), estHours: Number(hrs) > 0 ? Number(hrs) : undefined });
        else onStart({ recordId: Number(choice) });
      }}
      data-testid={`form-start-${printer.key}`}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-plate`}>What's going on it?</Label>
        <select
          id={`${id}-plate`}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="flex min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base"
          data-testid={`select-start-plate-${printer.key}`}
        >
          {ordered.map((p) => (
            <option key={p.recordId} value={String(p.recordId)}>
              {p.suggestedPrinterKey === printer.key ? "★ " : ""}
              {p.dealName} · {p.fileName} · {hours(p.printTimeSeconds)}
              {p.started ? " · started before" : ""}
            </option>
          ))}
          <option value="other">Other job (type it)</option>
        </select>
      </div>
      {other ? (
        <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-label`}>Job name</Label>
            <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} className="min-h-11 text-base" data-testid={`input-start-label-${printer.key}`} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-hours`}>Hours</Label>
            <Input id={`${id}-hours`} inputMode="decimal" value={hrs} onChange={(e) => setHrs(e.target.value)} placeholder="4.5" className="min-h-11 text-base" data-testid={`input-start-hours-${printer.key}`} />
          </div>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11 flex-1 bg-warn text-black hover:bg-warn/90" disabled={pending || (other && !label.trim())} data-testid={`button-confirm-start-${printer.key}`}>
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Started now
        </Button>
        <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={onCancel} aria-label="Cancel" data-testid={`button-cancel-start-${printer.key}`}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

/** Assigned slice file: name, layers, estimated time, start / replace / clear. */
function AssignedFile({
  printer,
  busy,
  printing,
  onStartAssigned,
  onReplace,
  onClear,
}: {
  printer: PrinterLiveStatus;
  busy: boolean;
  printing: boolean;
  onStartAssigned: () => void;
  onReplace: () => void;
  onClear: () => void;
}) {
  const a = printer.assigned!;
  const est = formatDurationShort(a.printTimeSeconds);
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-3" data-testid={`assigned-${printer.key}`}>
      <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-warn/90">{printing ? "Up next" : "File on this printer"}</p>
      <p className="mt-0.5 flex min-w-0 items-start gap-1.5 text-sm font-semibold" title={a.fileName}>
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
        <span className="min-w-0 break-all" data-testid={`text-assigned-name-${printer.key}`}>{a.fileName}</span>
      </p>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground" data-testid={`text-assigned-meta-${printer.key}`}>
        {a.layerCount != null ? `${a.layerCount.toLocaleString()} layers` : "Layers unknown"}{est ? ` · est. ${est}` : " · no print time in file"}
        {a.layerHeightMm ? ` · ${Number(a.layerHeightMm.toFixed(3))} mm` : ""}
      </p>
      <div className="mt-2 flex gap-2">
        {printing ? null : (
          <Button type="button" className="min-h-11 flex-1 bg-warn text-black hover:bg-warn/90" onClick={onStartAssigned} disabled={busy} data-testid={`button-start-assigned-${printer.key}`}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Start this job{est ? ` (${formatHours(a.printTimeSeconds)})` : ""}
          </Button>
        )}
        <Button type="button" variant="outline" className={`min-h-11 ${printing ? "flex-1" : ""}`} onClick={onReplace} disabled={busy} data-testid={`button-replace-assigned-${printer.key}`}>
          Replace
        </Button>
        <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={onClear} disabled={busy} aria-label="Clear file" data-testid={`button-clear-assigned-${printer.key}`}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function PrinterCard({
  printer,
  plates,
  nowMs,
  busy,
  headers,
  onStart,
  onDone,
  onAssigned,
  onClear,
}: {
  printer: PrinterLiveStatus;
  plates: StartablePlate[];
  nowMs: number;
  busy: boolean;
  headers: Record<string, string>;
  onStart: (body: { recordId?: number; jobLabel?: string; estHours?: number; useAssigned?: boolean }) => void;
  onDone: () => void;
  onAssigned: (fileName: string) => void;
  onClear: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [assignError, setAssignError] = useState("");
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const cur = printer.current;
  const times = cur ? describeRunTimes({ startedAt: cur.startedAt, etaAt: cur.etaAt, estSeconds: cur.estSeconds ?? null }, nowMs) : null;
  const pct = times?.pct ?? null;
  const lastTimes = !cur && printer.last ? describeLastRun(printer.last, nowMs) : null;

  async function takeFile(file: File | undefined | null) {
    if (!file) return;
    const reason = rejectSliceFileReason(file.name);
    if (reason) {
      setAssignError(reason);
      return;
    }
    setAssignError("");
    setUploading(true);
    try {
      await assignSliceFile(printer.key, file, headers);
      setStarting(false);
      onAssigned(file.name);
    } catch (error) {
      setAssignError(error instanceof Error ? error.message : "Could not read that slice file.");
    } finally {
      setUploading(false);
    }
  }

  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 1) setAssignError("One file per printer. Using the first one.");
      void takeFile(files[0]);
    },
  };
  const printing = printer.state === "printing";
  const art = printerArt(printer);
  const short = shortPrinterName(printer.name);
  const brand = /^phrozen\s+sonic\s+/i.test(printer.name) ? "Phrozen Sonic" : "";
  const split = cur ? (cur.printName ? { printName: cur.printName, clientName: cur.clientName ?? null } : splitJobLabel(cur.jobLabel)) : null;

  return (
    <article
      className={`relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-colors ${
        dragOver ? "border-warn ring-2 ring-warn ring-offset-2 ring-offset-background" : printing ? "border-warn/50" : "border-border"
      }`}
      data-testid={`card-printer-${printer.key}`}
      data-state={printer.state}
      data-dragover={dragOver ? "true" : undefined}
      {...dropHandlers}
    >
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/85 text-center" data-testid={`dropzone-${printer.key}`}>
          <Upload className="h-8 w-8 text-warn" aria-hidden />
          <p className="text-base font-semibold">Drop to put it on {short}</p>
          <p className="text-xs text-muted-foreground">{ASSIGNABLE_SLICE_EXTENSIONS.join(" / ")} slice files</p>
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept={ASSIGNABLE_SLICE_EXTENSIONS.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void takeFile(file);
        }}
        data-testid={`input-assign-file-${printer.key}`}
      />
      <div className="flex min-w-0 gap-3 p-3 sm:p-4">
        <div
          className={`flex w-[5.5rem] shrink-0 items-end justify-center rounded-lg sm:w-28 ${printing ? "printer-art-panel-printing" : "printer-art-panel-idle"}`}
          data-testid={`art-printer-${printer.key}`}
        >
          <PrinterArt art={art} printing={printing} className="h-[6.5rem] w-full sm:h-32" title={`${printer.name} illustration`} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="break-words text-base font-semibold leading-snug" data-testid={`text-printer-name-${printer.key}`}>{short}</h2>
              {brand ? <p className="truncate text-xs text-muted-foreground">{brand}</p> : null}
            </div>
            <StatusBadge state={printer.state} testId={`status-printer-${printer.key}`} />
          </div>

          {cur && split ? (
            <div className="mt-2 min-w-0 space-y-1">
              <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-warn/90">Now printing</p>
              <p className="line-clamp-2 break-words text-base font-semibold leading-snug" data-testid={`text-job-${printer.key}`} title={cur.jobLabel}>
                {split.printName || cur.jobLabel}
              </p>
              {split.clientName ? (
                <p className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium" data-testid={`text-client-${printer.key}`}>
                  <User className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">for {split.clientName}</span>
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 min-w-0 space-y-1">
              <p className="flex items-start gap-1.5 text-sm leading-snug" data-testid={`text-idle-${printer.key}`}>
                <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>{idleLine(printer.key)}</span>
              </p>
              <p className="break-words text-xs text-muted-foreground" data-testid={`text-last-${printer.key}`}>
                {printer.last && lastTimes
                  ? [
                      `Last: ${splitJobLabel(printer.last.jobLabel).printName}`,
                      lastTimes.duration ? `ran ${lastTimes.duration}` : "",
                      lastTimes.ended ? `${printer.last.autoEnded ? "est. ended" : "ended"} ${lastTimes.ended}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "Nothing running yet"}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto space-y-3 px-3 pb-3 sm:px-4 sm:pb-4">
        {cur ? (
          <>
            {pct != null ? <ProgressBar pct={pct} label={`${printer.name} progress`} testId={`progress-${printer.key}`} /> : null}
            {times ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm" data-testid={`times-${printer.key}`}>
                <div className="min-w-0">
                  <dt className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">Started</dt>
                  <dd className="font-medium tabular-nums" data-testid={`text-started-${printer.key}`}>{times.started || "—"}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">Finish</dt>
                  <dd className={`font-semibold tabular-nums ${times.hasEstimate ? "text-warn" : "text-muted-foreground"}`} data-testid={`text-eta-${printer.key}`}>
                    <Clock className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
                    {times.finish}
                  </dd>
                </div>
                {times.hasEstimate ? (
                  <>
                    <div className="min-w-0">
                      <dt className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">Total est.</dt>
                      <dd className="tabular-nums" data-testid={`text-total-${printer.key}`}>{times.total}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">Time left</dt>
                      <dd className="font-medium tabular-nums" data-testid={`text-left-${printer.key}`}>{times.left}</dd>
                    </div>
                  </>
                ) : (
                  <p className="col-span-2 text-xs text-muted-foreground" data-testid={`text-no-estimate-${printer.key}`}>No print time on this job, so there's no countdown. Tap Done when it's off.</p>
                )}
              </dl>
            ) : null}
            {cur.fileName ? <p className="truncate text-xs text-muted-foreground" title={cur.fileName}>{cur.fileName}</p> : null}
            <Button type="button" variant="outline" className="min-h-11 w-full" onClick={onDone} disabled={busy} data-testid={`button-done-${printer.key}`}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
              Done, it's off
            </Button>
          </>
        ) : null}
        {printer.assigned ? (
          <AssignedFile
            printer={printer}
            busy={busy || uploading}
            printing={printing}
            onStartAssigned={() => onStart({ useAssigned: true })}
            onReplace={() => fileInput.current?.click()}
            onClear={onClear}
          />
        ) : null}
        {assignError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid={`text-assign-error-${printer.key}`}>
            {assignError}
          </p>
        ) : null}
        {uploading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={`text-assign-reading-${printer.key}`}>
            <Loader2 className="h-4 w-4 animate-spin" /> Reading slice file…
          </p>
        ) : null}
        {cur ? null : starting ? (
          <StartForm
            printer={printer}
            plates={plates}
            pending={busy}
            onStart={(body) => onStart(body)}
            onCancel={() => setStarting(false)}
          />
        ) : (
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => setStarting(true)} data-testid={`button-start-${printer.key}`}>
              <Play className="mr-2 h-4 w-4" />
              {printer.assigned ? "Other job" : "Start a job"}
            </Button>
            {printer.assigned ? null : (
              <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => fileInput.current?.click()} disabled={uploading} data-testid={`button-assign-file-${printer.key}`}>
                <Paperclip className="mr-2 h-4 w-4" />
                Assign file
              </Button>
            )}
          </div>
        )}
        {!printer.assigned && !cur && !starting ? (
          <p className="hidden text-center text-xs text-muted-foreground sm:block" data-testid={`text-drop-hint-${printer.key}`}>or drag a {ASSIGNABLE_SLICE_EXTENSIONS.join(" / ")} onto this card</p>
        ) : null}
        {!printer.assigned && cur ? (
          <button type="button" className="min-h-11 w-full text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => fileInput.current?.click()} disabled={uploading} data-testid={`button-assign-file-${printer.key}`}>
            Queue the next file here
          </button>
        ) : null}
      </div>
    </article>
  );
}

export default function PrintersPage() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Printers unlocked",
    successDescription: "See which printers are idle or printing.",
  });
  const nowMs = useNow();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A file dropped beside a card shouldn't make the browser navigate away and open it.
  useEffect(() => {
    const stop = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const status = useQuery<StatusResponse>({
    queryKey: [...QUERY_KEY, ownerCode],
    enabled: isUnlocked,
    refetchInterval: 60_000,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/printers/status", undefined, { headers });
      return (await response.json()) as StatusResponse;
    },
  });

  const act = useMutation({
    mutationFn: async ({ key, action, body }: { key: string; action: "start" | "done" | "clear"; body?: unknown }) => {
      setBusyKey(key);
      const response =
        action === "clear"
          ? await apiRequest("DELETE", `/api/printers/status/${encodeURIComponent(key)}/assign`, undefined, { headers })
          : await apiRequest("POST", `/api/printers/status/${encodeURIComponent(key)}/${action}`, body ?? {}, { headers });
      return response.json();
    },
    onSettled: () => {
      setBusyKey(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update printer", description: error.message.replace(/^\d+:\s*/, "").slice(0, 220), variant: "destructive" });
    },
  });

  // Re-derive from the server's runs view so remaining time ticks without refetching.
  const board = status.data;
  const printers = useMemo(() => {
    if (!board?.printers) return [];
    const runs: PrinterRun[] = board.printers.flatMap((p) =>
      p.current
        ? [{
            id: p.current.runId,
            printerKey: p.key,
            recordId: null,
            dealId: p.current.dealId,
            jobLabel: p.current.jobLabel,
            fileName: p.current.fileName,
            startedAt: p.current.startedAt,
            estSeconds:
              p.current.estSeconds ??
              (p.current.etaAt ? Math.round((Date.parse(p.current.etaAt) - Date.parse(p.current.startedAt)) / 1000) : null),
            finishedAt: null,
          }]
        : [],
    );
    const live = buildPrinterStatusBoard(board.printers, runs, Math.max(nowMs, Date.parse(board.now) || 0)).printers;
    const merged = live.map((p, i) => {
      const src = board.printers[i]!.current;
      return {
        ...p,
        current: p.current && src ? { ...p.current, printName: src.printName, clientName: src.clientName ?? null } : p.current,
        last: p.current ? null : (p.last ?? board.printers[i]!.last),
      };
    });
    // Printing first (soonest done on top), then idle in roster order.
    return merged
      .map((p, i) => ({ p, i }))
      .sort((a, b) => {
        const pa = a.p.current ? 0 : 1;
        const pb = b.p.current ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if (a.p.current && b.p.current) {
          const ea = a.p.current.remainingSeconds ?? Number.MAX_SAFE_INTEGER;
          const eb = b.p.current.remainingSeconds ?? Number.MAX_SAFE_INTEGER;
          if (ea !== eb) return ea - eb;
        }
        return a.i - b.i;
      })
      .map(({ p }) => p);
  }, [board, nowMs]);
  function onVoiceStarted(result: VoiceResult) {
    toast({
      title: `${shortPrinterName(result.printerName ?? "Printer")} started`,
      description: result.estHours ? `Estimated ${result.estHours} from the assigned file.` : "Started from the assigned file.",
    });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }
  const printingCount = printers.filter((p) => p.state === "printing").length;
  const idleCount = printers.length - printingCount;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Printers"
        subtitle="What's printing right now, and when it should be done."
        actions={
          ownerCode ? (
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => status.refetch()} disabled={status.isFetching} data-testid="button-refresh-printers">
              {status.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          ) : null
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock printers"
            description="Keep your owner code only in this open tab."
            buttonLabel="Unlock printers"
            testIdPrefix="printers"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : status.isLoading ? (
          <div className="space-y-3" data-testid="skeleton-printers">
            <Skeleton className="h-16 rounded-lg" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : status.isError || !board ? (
          <Panel title="Printers are not available right now" testId="panel-printers-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm leading-6 text-muted-foreground">Refresh after checking your owner code.</p>
                <Button className="mt-4 min-h-11" size="sm" onClick={() => status.refetch()} data-testid="button-retry-printers">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <>
            <section
              className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5"
              aria-label="Printer summary"
              data-testid="printers-summary"
            >
              <div className="pointer-events-none absolute -right-6 -top-6 h-32 w-32 rounded-full bg-warn/10 blur-2xl" aria-hidden />
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#1c1917] ring-1 ring-warn/40">
                  <Layers className="h-5 w-5 text-warn" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-base font-semibold leading-snug" data-testid="text-summary-line">
                    {printingCount === 0
                      ? "All printers are resting"
                      : printingCount === printers.length
                        ? "Every printer is busy!"
                        : `${printingCount} printing, ${idleCount} ready for more`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {printingCount === 0 ? "Plates up, vats ready. Start a job on any card." : "Layer by layer. Cards with the soonest finish are on top."}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className={`rounded-lg border p-3 ${printingCount > 0 ? "border-warn/40 bg-warn/10" : "border-border bg-background/40 opacity-80"}`}>
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warn">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden /> Printing
                  </p>
                  <p className="mt-1 text-3xl font-bold tabular-nums text-warn" data-testid="count-printing">{printingCount}</p>
                </div>
                <div className="rounded-lg border border-border bg-background/40 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Moon className="h-3.5 w-3.5" aria-hidden /> Idle
                  </p>
                  <p className="mt-1 text-3xl font-bold tabular-nums" data-testid="count-idle">{idleCount}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5" aria-hidden>
                {printers.map((p) => (
                  <span
                    key={p.key}
                    title={`${shortPrinterName(p.name)}: ${p.state}`}
                    className={`h-2 w-6 rounded-full ${p.state === "printing" ? "bg-warn" : "bg-muted-foreground/30"}`}
                  />
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-border bg-card p-3 sm:p-4" aria-label="Voice start" data-testid="section-voice">
              <VoiceStart headers={headers} onStarted={onVoiceStarted} />
            </section>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="list-printers">
              {printers.map((printer) => (
                <PrinterCard
                  key={`${printer.key}-${printer.current?.runId ?? "idle"}`}
                  printer={printer}
                  plates={board.plates ?? []}
                  nowMs={nowMs}
                  busy={busyKey === printer.key && act.isPending}
                  headers={headers}
                  onStart={(body) => act.mutate({ key: printer.key, action: "start", body })}
                  onDone={() => act.mutate({ key: printer.key, action: "done" })}
                  onAssigned={(fileName) => {
                    toast({ title: `File on ${shortPrinterName(printer.name)}`, description: fileName });
                    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
                  }}
                  onClear={() => act.mutate({ key: printer.key, action: "clear" })}
                />
              ))}
            </section>
            <p className="text-xs text-muted-foreground">
              Status comes from your own taps here plus the plate's sliced print time. Print Ops never connects to the printers.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
