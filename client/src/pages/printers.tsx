import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Play, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import {
  buildPrinterStatusBoard,
  formatRemaining,
  type PrinterLiveStatus,
  type PrinterRun,
  type PrinterStatusBoard,
  type StartablePlate,
} from "@shared/printer-status";

type StatusResponse = PrinterStatusBoard & { ok: true; plates?: StartablePlate[] };

const QUERY_KEY = ["/api/printers/status"];

function clock(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

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
      className={`inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-sm font-bold uppercase tracking-wider ${
        printing ? "bg-warn/15 text-warn ring-1 ring-inset ring-warn/40" : "bg-muted text-muted-foreground"
      }`}
      data-testid={testId}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${printing ? "animate-pulse bg-warn" : "bg-muted-foreground/50"}`} aria-hidden />
      {printing ? "Printing" : "Idle"}
    </span>
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

function PrinterCard({
  printer,
  plates,
  nowMs,
  busy,
  onStart,
  onDone,
}: {
  printer: PrinterLiveStatus;
  plates: StartablePlate[];
  nowMs: number;
  busy: boolean;
  onStart: (body: { recordId?: number; jobLabel?: string; estHours?: number }) => void;
  onDone: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const cur = printer.current;
  const pct = cur?.progress != null ? Math.round(cur.progress * 100) : null;

  return (
    <article
      className={`min-w-0 rounded-lg border bg-card p-4 ${printer.state === "printing" ? "border-warn/40" : "border-border"}`}
      data-testid={`card-printer-${printer.key}`}
      data-state={printer.state}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words pt-1.5 text-base font-semibold leading-snug">{printer.name}</h2>
        <StatusBadge state={printer.state} testId={`status-printer-${printer.key}`} />
      </div>

      {cur ? (
        <div className="mt-3 space-y-3">
          <div className="min-w-0">
            <p className="break-words text-base font-medium" data-testid={`text-job-${printer.key}`}>{cur.jobLabel}</p>
            {cur.fileName ? <p className="truncate text-sm text-muted-foreground" title={cur.fileName}>{cur.fileName}</p> : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Started</dt>
              <dd className="tabular-nums" data-testid={`text-started-${printer.key}`}>{clock(cur.startedAt, nowMs)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Done by</dt>
              <dd className="tabular-nums" data-testid={`text-eta-${printer.key}`}>
                {cur.etaAt ? (
                  <>
                    <span className="font-semibold text-warn">{clock(cur.etaAt, nowMs)}</span>
                    <span className="block text-muted-foreground">{formatRemaining(cur.remainingSeconds)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No print time</span>
                )}
              </dd>
            </div>
          </dl>
          {pct != null ? (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${printer.name} progress`}>
              <div className="h-full rounded-full bg-warn" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <Button type="button" variant="outline" className="min-h-11 w-full" onClick={onDone} disabled={busy} data-testid={`button-done-${printer.key}`}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            Done, it's off
          </Button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="break-words text-sm text-muted-foreground" data-testid={`text-last-${printer.key}`}>
            {printer.last ? `Last: ${printer.last.jobLabel} · ${printer.last.autoEnded ? "est. done" : "done"} ${clock(printer.last.endedAt, nowMs)}` : "Nothing running"}
          </p>
          {starting ? (
            <StartForm
              printer={printer}
              plates={plates}
              pending={busy}
              onStart={(body) => onStart(body)}
              onCancel={() => setStarting(false)}
            />
          ) : (
            <Button type="button" variant="outline" className="mt-3 min-h-11 w-full" onClick={() => setStarting(true)} data-testid={`button-start-${printer.key}`}>
              <Play className="mr-2 h-4 w-4" />
              Start a job
            </Button>
          )}
        </div>
      )}
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
    mutationFn: async ({ key, action, body }: { key: string; action: "start" | "done"; body?: unknown }) => {
      setBusyKey(key);
      const response = await apiRequest("POST", `/api/printers/status/${encodeURIComponent(key)}/${action}`, body ?? {}, { headers });
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
            estSeconds: p.current.etaAt ? Math.round((Date.parse(p.current.etaAt) - Date.parse(p.current.startedAt)) / 1000) : null,
            finishedAt: null,
          }]
        : [],
    );
    const live = buildPrinterStatusBoard(board.printers, runs, Math.max(nowMs, Date.parse(board.now) || 0)).printers;
    return live.map((p, i) => ({ ...p, last: p.current ? null : (p.last ?? board.printers[i]!.last) }));
  }, [board, nowMs]);
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
            <section className="grid grid-cols-2 gap-3" aria-label="Printer summary" data-testid="printers-summary">
              <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 sm:p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-warn">Printing</p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-warn" data-testid="count-printing">{printingCount}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Idle</p>
                <p className="mt-1 text-3xl font-bold tabular-nums" data-testid="count-idle">{idleCount}</p>
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="list-printers">
              {printers.map((printer) => (
                <PrinterCard
                  key={`${printer.key}-${printer.current?.runId ?? "idle"}`}
                  printer={printer}
                  plates={board.plates ?? []}
                  nowMs={nowMs}
                  busy={busyKey === printer.key && act.isPending}
                  onStart={(body) => act.mutate({ key: printer.key, action: "start", body })}
                  onDone={() => act.mutate({ key: printer.key, action: "done" })}
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
