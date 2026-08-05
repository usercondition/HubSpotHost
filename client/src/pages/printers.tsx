import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Clock3,
  Layers3,
  Loader2,
  PackageCheck,
  Printer,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import {
  PRINTER_LIFECYCLE_EVENT_LABELS,
  PRINTER_LIFECYCLE_EVENT_TYPES,
  type PrinterFleetSnapshot,
  type PrinterLifecycleEventType,
  type PrinterUsageBreakdown,
} from "@shared/schema";

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0h";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return minutes > 0 ? `${whole}h ${String(minutes).padStart(2, "0")}m` : `${whole}h`;
}

function localDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "—";
}

function localDateInputValue(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fepTone(percent: number | null): "good" | "warn" | "bad" | "neutral" {
  if (percent == null) return "neutral";
  if (percent >= 100) return "bad";
  if (percent >= 75) return "warn";
  return "good";
}

function PrinterDetail({
  printer,
  onSaved,
}: {
  printer: PrinterUsageBreakdown;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { headers } = useOwnerSession();
  const [notes, setNotes] = useState(printer.notes);
  const [aliases, setAliases] = useState(printer.aliases.join(", "));
  const [fepHours, setFepHours] = useState(String(printer.recommendedFepHours));
  const [fepLayers, setFepLayers] = useState(String(printer.recommendedFepLayers));
  const [eventType, setEventType] = useState<PrinterLifecycleEventType>("fep_replaced");
  const [eventAt, setEventAt] = useState(localDateInputValue());
  const [eventNotes, setEventNotes] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "PATCH",
        `/api/printers/${printer.printerId}`,
        {
          notes,
          aliases: aliases
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          recommendedFepHours: Number(fepHours) || printer.recommendedFepHours,
          recommendedFepLayers: Number(fepLayers) || printer.recommendedFepLayers,
        },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      onSaved();
      toast({ title: "Printer updated", description: `${printer.name} settings saved.` });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not update printer",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const addEvent = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "POST",
        `/api/printers/${printer.printerId}/events`,
        { eventType, occurredAt: eventAt, notes: eventNotes },
        { headers },
      );
      return response.json();
    },
    onSuccess: () => {
      setEventNotes("");
      onSaved();
      toast({
        title: "Lifecycle event logged",
        description: PRINTER_LIFECYCLE_EVENT_LABELS[eventType],
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not log lifecycle event",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  const fepPercent = Math.max(
    printer.fepHoursUsedPercent ?? 0,
    printer.fepLayersUsedPercent ?? 0,
  );

  return (
    <div className="space-y-5" data-testid={`panel-printer-detail-${printer.printerId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold tracking-tight">{printer.name}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {printer.brand} · {printer.model || "Fleet machine"}
            {printer.matchedProfiles.length
              ? ` · matched CTB/ULTX names: ${printer.matchedProfiles.join(", ")}`
              : " · no plates matched yet"}
          </p>
        </div>
        <StatusPill
          tone={printer.status === "active" ? "good" : "neutral"}
          icon={printer.status === "active" ? ShieldCheck : AlertTriangle}
          label={printer.status === "active" ? "Active" : "Retired"}
          testId={`status-printer-${printer.printerId}`}
        />
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={`${printer.name} usage`}>
        <StatCard label="Print hours" value={formatHours(printer.totalPrintHours)} hint={`${printer.plateCount} plate${printer.plateCount === 1 ? "" : "s"}`} icon={Clock3} testId={`metric-printer-hours-${printer.printerId}`} />
        <StatCard label="Layers printed" value={printer.totalLayers.toLocaleString()} hint={`${printer.distinctOrders} order${printer.distinctOrders === 1 ? "" : "s"}`} icon={Layers3} testId={`metric-printer-layers-${printer.printerId}`} />
        <StatCard label="Resin volume" value={`${printer.totalResinVolumeMl.toLocaleString()} ml`} hint={`${printer.totalResinMassG.toLocaleString()} g`} icon={PackageCheck} testId={`metric-printer-resin-${printer.printerId}`} />
        <StatCard
          label="FEP life used"
          value={fepPercent > 0 ? `${Math.round(fepPercent)}%` : "—"}
          hint={`${formatHours(printer.hoursSinceFep)} / ${printer.layersSinceFep.toLocaleString()} layers since FEP`}
          icon={Wrench}
          tone={fepTone(fepPercent || null)}
          testId={`metric-printer-fep-${printer.printerId}`}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Lifecycle" description="Log FEP and screen changes so usage resets from that point.">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`event-type-${printer.printerId}`}>Event</Label>
                <select
                  id={`event-type-${printer.printerId}`}
                  value={eventType}
                  onChange={(event) => setEventType(event.target.value as PrinterLifecycleEventType)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid={`select-printer-event-${printer.printerId}`}
                >
                  {PRINTER_LIFECYCLE_EVENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {PRINTER_LIFECYCLE_EVENT_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`event-at-${printer.printerId}`}>When</Label>
                <Input
                  id={`event-at-${printer.printerId}`}
                  type="datetime-local"
                  value={eventAt}
                  onChange={(event) => setEventAt(event.target.value)}
                  data-testid={`input-printer-event-at-${printer.printerId}`}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`event-notes-${printer.printerId}`}>Notes</Label>
              <Textarea
                id={`event-notes-${printer.printerId}`}
                value={eventNotes}
                onChange={(event) => setEventNotes(event.target.value)}
                rows={2}
                placeholder="Film brand, batch, why it was changed…"
                data-testid={`input-printer-event-notes-${printer.printerId}`}
              />
            </div>
            <Button
              type="button"
              onClick={() => addEvent.mutate()}
              disabled={addEvent.isPending}
              data-testid={`button-log-printer-event-${printer.printerId}`}
            >
              {addEvent.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
              Log lifecycle event
            </Button>
            <ul className="space-y-2 border-t border-border pt-3">
              {printer.lifecycleEvents.length === 0 ? (
                <li className="text-xs text-muted-foreground">No lifecycle events yet. Log the current FEP install date to start the clock.</li>
              ) : (
                printer.lifecycleEvents.map((event) => (
                  <li key={event.id} className="text-xs leading-5" data-testid={`row-printer-event-${event.id}`}>
                    <span className="font-medium">
                      {PRINTER_LIFECYCLE_EVENT_LABELS[event.eventType as PrinterLifecycleEventType] || event.eventType}
                    </span>
                    <span className="text-muted-foreground"> · {localDate(event.occurredAt)}</span>
                    {event.notes ? <p className="mt-0.5 text-muted-foreground">{event.notes}</p> : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        </Panel>

        <Panel title="Machine settings" description="Aliases match slicer machine names from CTB/ULTX plates onto this printer.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`aliases-${printer.printerId}`}>Matching aliases</Label>
              <Input
                id={`aliases-${printer.printerId}`}
                value={aliases}
                onChange={(event) => setAliases(event.target.value)}
                placeholder="NEWX1, ELEGOO Mighty 8K NEWX1"
                data-testid={`input-printer-aliases-${printer.printerId}`}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`fep-hours-${printer.printerId}`}>Recommended FEP hours</Label>
                <Input
                  id={`fep-hours-${printer.printerId}`}
                  inputMode="decimal"
                  value={fepHours}
                  onChange={(event) => setFepHours(event.target.value)}
                  data-testid={`input-printer-fep-hours-${printer.printerId}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`fep-layers-${printer.printerId}`}>Recommended FEP layers</Label>
                <Input
                  id={`fep-layers-${printer.printerId}`}
                  inputMode="numeric"
                  value={fepLayers}
                  onChange={(event) => setFepLayers(event.target.value)}
                  data-testid={`input-printer-fep-layers-${printer.printerId}`}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`notes-${printer.printerId}`}>Notes</Label>
              <Textarea
                id={`notes-${printer.printerId}`}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                data-testid={`input-printer-notes-${printer.printerId}`}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid={`button-save-printer-${printer.printerId}`}
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save machine settings
            </Button>
            <p className="text-xs text-muted-foreground">
              Screen life since install: {formatHours(printer.hoursSinceScreen)} · {printer.layersSinceScreen.toLocaleString()} layers
              {printer.screenInstalledAt ? ` (from ${localDate(printer.screenInstalledAt)})` : " (log a screen replacement to start)"}
            </p>
          </div>
        </Panel>
      </div>

      <Panel title="Recent jobs on this machine" description="Pulled from attached plate metrics that matched this printer’s name or aliases.">
        {printer.recentJobs.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[42rem] text-left text-xs">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">Order</th>
                  <th className="px-2 py-2 font-medium">Plate</th>
                  <th className="px-2 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 font-medium">Layers</th>
                  <th className="px-2 py-2 font-medium">Attached</th>
                </tr>
              </thead>
              <tbody>
                {printer.recentJobs.map((job) => (
                  <tr key={job.recordId} className="border-b border-border/70 last:border-b-0" data-testid={`row-printer-job-${job.recordId}`}>
                    <td className="px-2 py-3">
                      <p className="font-medium">{job.dealName}</p>
                      <p className="mt-0.5 text-muted-foreground">{job.printerProfile || "No machine name"}</p>
                    </td>
                    <td className="max-w-48 truncate px-2 py-3 font-medium" title={job.fileName}>{job.fileName}</td>
                    <td className="px-2 py-3 numeric">{job.printTimeSeconds ? formatHours(job.printTimeSeconds / 3_600) : "—"}</td>
                    <td className="px-2 py-3 numeric">{job.layerCount?.toLocaleString() ?? "—"}</td>
                    <td className="px-2 py-3">{localDate(job.attachedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No attached plates match this machine yet. When you attach a CTB/ULTX whose slicer machine name matches an alias, it will appear here.
          </p>
        )}
      </Panel>
    </div>
  );
}

function UnassignedProfilesPanel({
  profiles,
  printers,
  headers,
  onAssigned,
}: {
  profiles: Array<{ profile: string; plateCount: number; totalPrintHours: number }>;
  printers: PrinterUsageBreakdown[];
  headers: Record<string, string>;
  onAssigned: () => void;
}) {
  const { toast } = useToast();
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});

  const assign = useMutation({
    mutationFn: async ({ profile, printerId }: { profile: string; printerId: number }) => {
      setPendingProfile(profile);
      const response = await apiRequest(
        "POST",
        "/api/printers/assign-profile",
        { profile, printerId },
        { headers },
      );
      return (await response.json()) as { ok: true; message: string };
    },
    onSuccess: (data) => {
      setPendingProfile(null);
      onAssigned();
      toast({ title: "Machine name assigned", description: data.message });
    },
    onError: (error: Error) => {
      setPendingProfile(null);
      toast({
        title: "Could not assign machine name",
        description: error.message.replace(/^\d+:\s*/, "").slice(0, 220),
        variant: "destructive",
      });
    },
  });

  return (
    <Panel
      title="Unassigned plate profiles"
      description="These CTB/ULTX machine names did not match automatically. Assign each one to a fleet printer — historical and future plates with that label will count toward it."
    >
      <ul className="space-y-3 text-sm" data-testid="list-unassigned-profiles">
        {profiles.map((profile) => {
          const selected = choices[profile.profile] ?? "";
          const busy = pendingProfile === profile.profile && assign.isPending;
          return (
            <li
              key={profile.profile}
              className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`row-unassigned-profile-${profile.profile}`}
            >
              <div className="min-w-0">
                <p className="font-medium">{profile.profile}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {profile.plateCount} plate{profile.plateCount === 1 ? "" : "s"} · {formatHours(profile.totalPrintHours)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={selected}
                  onChange={(event) =>
                    setChoices((current) => ({ ...current, [profile.profile]: event.target.value }))
                  }
                  className="flex h-9 min-w-[12rem] rounded-md border border-input bg-background px-2 text-xs"
                  data-testid={`select-assign-profile-${profile.profile}`}
                >
                  <option value="">Assign to printer…</option>
                  {printers.map((printer) => (
                    <option key={printer.printerId} value={String(printer.printerId)}>
                      {printer.name}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  disabled={!selected || busy}
                  onClick={() =>
                    assign.mutate({ profile: profile.profile, printerId: Number(selected) })
                  }
                  data-testid={`button-assign-profile-${profile.profile}`}
                >
                  {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Assign
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export default function PrintersPage() {
  const { toast } = useToast();
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: 'Printer fleet unlocked',
    successDescription: 'Track printers, maintenance, and lifecycle events.',
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const fleet = useQuery<PrinterFleetSnapshot & { ok: true }>({
    queryKey: ["/api/printers", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/printers", undefined, { headers });
      return (await response.json()) as PrinterFleetSnapshot & { ok: true };
    },
  });


  const printers = fleet.data?.printers ?? [];
  const selected = useMemo(
    () => printers.find((printer) => printer.printerId === selectedId) ?? printers[0] ?? null,
    [printers, selectedId],
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Printer fleet"
        subtitle="Track which jobs ran on each machine, cumulative hours and resin, and FEP / screen lifecycle."
        actions={
          <>
            {ownerCode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => fleet.refetch()}
                disabled={fleet.isFetching}
                data-testid="button-refresh-printers"
              >
                {fleet.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
          </>
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock printer fleet"
            description="Usage rolls up from attached CTB and ULTX plate metrics. Keep your owner code only in this open tab."
            buttonLabel="Unlock printers"
            testIdPrefix="printers"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : fleet.isLoading ? (
          <div className="space-y-5" data-testid="skeleton-printers">
            <Skeleton className="h-36 rounded-lg" />
            <Skeleton className="h-96 rounded-lg" />
          </div>
        ) : fleet.isError || !fleet.data ? (
          <section className="rounded-lg border border-destructive/35 bg-card p-5" data-testid="panel-printers-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <h2 className="text-base font-semibold tracking-tight">Printer fleet is not available right now</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">Refresh after checking your owner code and local database volume.</p>
                <Button className="mt-4" size="sm" onClick={() => fleet.refetch()} data-testid="button-retry-printers">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fleet totals">
              <StatCard label="Active printers" value={String(fleet.data.fleetTotals.activePrinters)} hint="Named machines in the fleet" icon={Printer} testId="metric-fleet-active" />
              <StatCard label="Fleet print hours" value={formatHours(fleet.data.fleetTotals.totalPrintHours)} hint="From attached plates" icon={Clock3} testId="metric-fleet-hours" />
              <StatCard label="Fleet layers" value={fleet.data.fleetTotals.totalLayers.toLocaleString()} hint={`${fleet.data.fleetTotals.plateCount} plates total`} icon={Layers3} testId="metric-fleet-layers" />
              <StatCard
                label="Unassigned plates"
                value={String(fleet.data.unassigned.plateCount)}
                hint={fleet.data.unassigned.plateCount ? "Machine name did not match a fleet alias" : "All plates matched a machine"}
                icon={AlertTriangle}
                tone={fleet.data.unassigned.plateCount ? "warn" : "good"}
                testId="metric-fleet-unassigned"
              />
            </section>

            <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
              <Panel title="Machines" description="Select a printer for the full usage breakdown.">
                <div className="space-y-1" data-testid="list-printers">
                  {printers.map((printer) => {
                    const active = (selected?.printerId ?? null) === printer.printerId;
                    return (
                      <button
                        key={printer.printerId}
                        type="button"
                        onClick={() => setSelectedId(printer.printerId)}
                        className={`flex w-full flex-col rounded-md px-3 py-2.5 text-left transition-colors ${
                          active ? "bg-primary/10 text-foreground" : "hover:bg-muted/60"
                        }`}
                        data-testid={`button-select-printer-${printer.printerId}`}
                      >
                        <span className="text-sm font-medium">{printer.name}</span>
                        <span className="mt-0.5 text-xs text-muted-foreground">
                          {formatHours(printer.totalPrintHours)} · {printer.plateCount} plate{printer.plateCount === 1 ? "" : "s"}
                          {printer.status === "retired" ? " · retired" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Panel>

              <div className="min-w-0">
                {selected ? (
                  <PrinterDetail
                    key={`${selected.printerId}-${selected.lastJobAt ?? ""}-${selected.lifecycleEvents[0]?.id ?? 0}-${selected.notes}-${selected.aliases.join("|")}`}
                    printer={selected}
                    onSaved={() => queryClient.invalidateQueries({ queryKey: ["/api/printers"] })}
                  />
                ) : (
                  <Panel title="No printers" description="The default fleet could not be seeded.">
                    <p className="text-sm text-muted-foreground">Refresh and try again.</p>
                  </Panel>
                )}
              </div>
            </div>

            {fleet.data.unassigned.plateCount > 0 ? (
              <UnassignedProfilesPanel
                profiles={fleet.data.unassigned.profiles}
                printers={printers}
                headers={headers}
                onAssigned={() => queryClient.invalidateQueries({ queryKey: ["/api/printers"] })}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
