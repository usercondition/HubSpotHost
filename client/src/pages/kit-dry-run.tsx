import { useMemo, useState } from "react";
import {
  CheckCircle2,
  CheckSquare,
  ClipboardCheck,
  Layers3,
  PackageOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Upload,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import {
  attachBitsToPlate,
  completePlateQc,
  createAcastusDryRunKit,
  createReprintCatchAllPlate,
  groupSummaries,
  isSelectableBit,
  kitProgress,
  markAllPlateBits,
  parseKitFileList,
  plateQcCounts,
  resetKitProgress,
  setPlateBitResult,
  type KitBit,
  type KitDryRun,
  type KitPlate,
} from "@/lib/kit-dry-run";

function bitStatusLabel(bit: KitBit): string {
  switch (bit.status) {
    case "printing":
      return "on plate · waiting QC";
    case "done":
      return "good · done";
    case "needs_reprint":
      return "needs reprint";
    default:
      return "not printed yet";
  }
}

export default function KitDryRunPage() {
  const [kit, setKit] = useState<KitDryRun>(() => createAcastusDryRunKit());
  const [paste, setPaste] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plateName, setPlateName] = useState("Plate 1");
  const [ctbFileName, setCtbFileName] = useState("Acastus_P1.ctb");
  const [qcPlateId, setQcPlateId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(
    "Flow: select bits → attach CTB → print physically → inspect → mark good/reprint.",
  );

  const progress = kitProgress(kit);
  const groups = groupSummaries(kit);
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const pendingQcPlates = kit.plates.filter((plate) => plate.status === "pending_qc");
  const qcPlate = kit.plates.find((plate) => plate.id === qcPlateId) ?? pendingQcPlates[0] ?? null;

  const visibleBits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kit.bits.filter((bit) => {
      if (groupFilter !== "all" && bit.group !== groupFilter) return false;
      if (!q) return true;
      return bit.label.toLowerCase().includes(q) || bit.fileName.toLowerCase().includes(q);
    });
  }, [kit.bits, groupFilter, query]);

  const selectableVisible = visibleBits.filter(isSelectableBit);
  const selectedCount = selectableVisible.filter((bit) => selected.has(bit.id)).length;

  const toggleBit = (bit: KitBit) => {
    if (!isSelectableBit(bit)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bit.id)) next.delete(bit.id);
      else next.add(bit.id);
      return next;
    });
  };

  const selectVisibleSelectable = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const bit of selectableVisible) next.add(bit.id);
      return next;
    });
  };

  const attachPlate = () => {
    const ids = Array.from(selected).filter((id) =>
      kit.bits.some((bit) => bit.id === id && isSelectableBit(bit)),
    );
    if (ids.length === 0) {
      setNote("Select at least one todo or reprint bit for this plate.");
      return;
    }
    const next = attachBitsToPlate(kit, { plateName, ctbFileName, bitIds: ids });
    const created = next.plates[0];
    setKit(next);
    setSelected(new Set());
    setPlateName(`Plate ${next.plates.length + 1}`);
    setCtbFileName(`Acastus_P${next.plates.length + 1}.ctb`);
    if (created) setQcPlateId(created.id);
    setNote(
      `Plate “${created?.name}” logged with ${ids.length} bits + ${created?.ctbFileName}. Status: waiting for physical print & visual QC.`,
    );
  };

  const createCatchAllReprintPlate = () => {
    const result = createReprintCatchAllPlate(kit);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    setKit(result.kit);
    setSelected(new Set());
    setQcPlateId(result.plateId);
    const plate = result.kit.plates.find((item) => item.id === result.plateId);
    setPlateName(`Plate ${result.kit.plates.length + 1}`);
    setCtbFileName(`Acastus_P${result.kit.plates.length + 1}.ctb`);
    setNote(
      `Catch-all reprint plate “${plate?.name}” created with ${result.count} failed bit${result.count === 1 ? "" : "s"}. Slice those into ${plate?.ctbFileName}, print, then QC again.`,
    );
  };

  const loadAcastus = () => {
    setKit(createAcastusDryRunKit());
    setSelected(new Set());
    setPlateName("Plate 1");
    setCtbFileName("Acastus_P1.ctb");
    setQcPlateId(null);
    setGroupFilter("all");
    setQuery("");
    setPaste("");
    setNote("Loaded Acastus sample. Attach a plate, then QC after inspection.");
  };

  const importPaste = () => {
    const next = parseKitFileList(paste, {
      kitName: "Pasted STL list",
      sourceNote: "Dry run from pasted filenames",
    });
    if (next.bits.length === 0) {
      setNote("No .stl filenames found in the paste.");
      return;
    }
    setKit(next);
    setSelected(new Set());
    setPlateName("Plate 1");
    setCtbFileName("Plate_1.ctb");
    setQcPlateId(null);
    setGroupFilter("all");
    setNote(`Imported ${next.bits.length} bits from paste.`);
  };

  const finalizeQc = (plate: KitPlate) => {
    const result = completePlateQc(kit, plate.id);
    if (!result.ok) {
      setNote(result.error);
      return;
    }
    const counts = plateQcCounts(
      result.kit.plates.find((item) => item.id === plate.id) ?? plate,
    );
    setKit(result.kit);
    const reprintCount = kitProgress(result.kit).reprint;
    setNote(
      `QC saved for “${plate.name}”: ${counts.good} good, ${counts.reprint} reprint.` +
        (reprintCount > 0
          ? ` ${reprintCount} bit${reprintCount === 1 ? "" : "s"} waiting — use Catch-all reprint plate when ready.`
          : ""),
    );
    const stillPending = result.kit.plates.find((item) => item.status === "pending_qc");
    setQcPlateId(stillPending?.id ?? null);
  };

  return (
    <div data-testid="page-kit-dry-run">
      <PageHeader
        title="Kit & plate bits"
        subtitle="Dry run: attach CTB + bits now, confirm good/reprint only after physical print and visual inspection. Nothing saved to HubSpot."
      />

      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-foreground">
          <strong className="font-semibold">Two steps.</strong> (1) Select bits and log the CTB while the plate is
          sliced/queued. (2) After the printer finishes and you inspect parts, open QC and mark each bit{" "}
          <em>good</em> or <em>reprint</em>. Bits are not “done” until QC.
        </section>

        <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-kit-summary">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="rule-label">Client order kit (dry run)</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight" data-testid="text-kit-name">
                {kit.name}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{kit.sourceNote}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusPill
                tone={progress.done === progress.total && progress.total > 0 ? "good" : "warn"}
                icon={PackageOpen}
                label={`${progress.done}/${progress.total} good`}
                testId="status-kit-progress"
              />
              {progress.printing > 0 ? (
                <StatusPill tone="warn" icon={ClipboardCheck} label={`${progress.printing} awaiting QC`} />
              ) : null}
              {progress.reprint > 0 ? (
                <StatusPill tone="bad" icon={XCircle} label={`${progress.reprint} reprint`} />
              ) : null}
            </div>
          </div>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {progress.todo} not started · {progress.printing} printing/awaiting QC · {progress.reprint} need reprint ·{" "}
            {progress.done} good
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => (
              <button
                key={group.group}
                type="button"
                onClick={() => setGroupFilter(group.group)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  groupFilter === group.group
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted/35 hover:bg-muted/60",
                )}
              >
                <p className="text-xs font-medium">{group.group}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {group.done}/{group.total} good
                  {group.printing ? ` · ${group.printing} QC` : ""}
                  {group.reprint ? ` · ${group.reprint} reprint` : ""}
                </p>
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={loadAcastus} data-testid="button-load-acastus">
              <Layers3 className="mr-2 h-4 w-4" />
              Load Acastus sample
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setKit(resetKitProgress(kit));
                setSelected(new Set());
                setPlateName("Plate 1");
                setCtbFileName("Acastus_P1.ctb");
                setQcPlateId(null);
                setNote("Cleared plates and QC.");
              }}
              data-testid="button-reset-kit-progress"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
            {progress.reprint > 0 ? (
              <Button
                type="button"
                size="sm"
                onClick={createCatchAllReprintPlate}
                data-testid="button-catchall-reprint-plate"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Catch-all reprint plate ({progress.reprint})
              </Button>
            ) : null}
            {groupFilter !== "all" ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setGroupFilter("all")}>
                Show all groups
              </Button>
            ) : null}
          </div>

          {progress.reprint > 0 ? (
            <div
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm"
              data-testid="panel-reprint-queue"
            >
              <p className="font-medium text-foreground">
                Reprint queue · {progress.reprint} bit{progress.reprint === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {kit.bits
                  .filter((bit) => bit.status === "needs_reprint")
                  .map((bit) => bit.label)
                  .join(" · ")}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Create one catch-all plate for all of these, slice that CTB, print, then QC again.
              </p>
            </div>
          ) : null}
        </section>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-simulate-plate">
            <p className="rule-label">Step 1 · Log plate + CTB</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Bits loaded on this plate</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Select todo/reprint bits that went onto the slicer plate, name the CTB, and attach. QC comes later —
              after you print and inspect.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">Plate name</span>
                <Input value={plateName} onChange={(e) => setPlateName(e.target.value)} data-testid="input-plate-name" />
              </label>
              <label className="space-y-1.5 text-xs">
                <span className="text-muted-foreground">CTB file (simulated)</span>
                <Input
                  value={ctbFileName}
                  onChange={(e) => setCtbFileName(e.target.value)}
                  data-testid="input-ctb-name"
                />
              </label>
              <label className="space-y-1.5 text-xs sm:col-span-2">
                <span className="text-muted-foreground">Search bits</span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-8"
                    placeholder="leg, torso, head…"
                    data-testid="input-bit-search"
                  />
                </div>
              </label>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={selectVisibleSelectable}>
                Select visible queue ({selectableVisible.length})
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>

            <ul className="mt-4 max-h-[24rem] space-y-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
              {visibleBits.map((bit) => {
                const selectable = isSelectableBit(bit);
                const checked = selectable && selected.has(bit.id);
                return (
                  <li key={bit.id}>
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => toggleBit(bit)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                        !selectable
                          ? "cursor-default opacity-55"
                          : checked
                            ? "bg-primary/10 hover:bg-primary/15"
                            : "hover:bg-muted/70",
                      )}
                    >
                      {bit.status === "done" ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : checked ? (
                        <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-5">
                          {bit.label}
                          {bit.status === "needs_reprint" ? (
                            <span className="ml-2 text-[0.65rem] uppercase tracking-wide text-destructive">Reprint</span>
                          ) : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {bit.group} · {bitStatusLabel(bit)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button type="button" onClick={attachPlate} data-testid="button-attach-plate">
                <Upload className="mr-2 h-4 w-4" />
                Attach CTB + {selectedCount} bit{selectedCount === 1 ? "" : "s"}
              </Button>
              {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
            </div>
          </section>

          <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-plate-qc">
            <p className="rule-label">Step 2 · Post-print QC</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Visual inspection</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Only after the plate is printed and you have looked at the parts. Mark each bit good or reprint, then
              save QC.
            </p>

            {pendingQcPlates.length === 0 ? (
              <p className="mt-6 text-sm text-muted-foreground">No plates waiting for QC. Attach a plate first.</p>
            ) : (
              <>
                <div className="mt-4 flex flex-wrap gap-2">
                  {pendingQcPlates.map((plate) => (
                    <Button
                      key={plate.id}
                      type="button"
                      size="sm"
                      variant={qcPlate?.id === plate.id ? "default" : "outline"}
                      onClick={() => setQcPlateId(plate.id)}
                    >
                      {plate.name}
                    </Button>
                  ))}
                </div>

                {qcPlate ? (
                  <div className="mt-4 space-y-3" data-testid="panel-active-qc">
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <p className="text-sm font-medium">{qcPlate.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        CTB: {qcPlate.ctbFileName} · logged {new Date(qcPlate.attachedAt).toLocaleString()} · awaiting
                        inspection
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setKit(markAllPlateBits(kit, qcPlate.id, "good"))}
                      >
                        Mark all good
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setKit(markAllPlateBits(kit, qcPlate.id, "reprint"))}
                      >
                        Mark all reprint
                      </Button>
                    </div>

                    <ul className="max-h-[18rem] space-y-2 overflow-y-auto">
                      {qcPlate.bits.map((row) => {
                        const bit = kit.bits.find((item) => item.id === row.bitId);
                        if (!bit) return null;
                        return (
                          <li
                            key={row.bitId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{bit.label}</p>
                              <p className="text-xs text-muted-foreground">{bit.group}</p>
                            </div>
                            <div className="flex gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant={row.result === "good" ? "default" : "outline"}
                                onClick={() => setKit(setPlateBitResult(kit, qcPlate.id, row.bitId, "good"))}
                              >
                                Good
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant={row.result === "reprint" ? "destructive" : "outline"}
                                onClick={() => setKit(setPlateBitResult(kit, qcPlate.id, row.bitId, "reprint"))}
                              >
                                Reprint
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <Button type="button" onClick={() => finalizeQc(qcPlate)} data-testid="button-save-qc">
                      <ClipboardCheck className="mr-2 h-4 w-4" />
                      Save QC after inspection
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-lg border border-card-border bg-card p-5">
            <p className="rule-label">Order plates</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">History</h3>
            {kit.plates.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No plates logged yet.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {kit.plates.map((plate) => {
                  const counts = plateQcCounts(plate);
                  return (
                    <li key={plate.id} className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">{plate.name}</p>
                        <StatusPill
                          tone={plate.status === "inspected" ? (counts.reprint > 0 ? "warn" : "good") : "warn"}
                          icon={plate.status === "inspected" ? CheckCircle2 : ClipboardCheck}
                          label={
                            plate.status === "pending_qc"
                              ? "Awaiting QC"
                              : `${counts.good} good / ${counts.reprint} reprint`
                          }
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {plate.ctbFileName} · {plate.bits.length} bits
                        {plate.inspectedAt ? ` · QC ${new Date(plate.inspectedAt).toLocaleString()}` : ""}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {plate.bits
                          .map((row) => {
                            const bit = kit.bits.find((item) => item.id === row.bitId);
                            const tag =
                              plate.status === "pending_qc"
                                ? row.result === "pending"
                                  ? "?"
                                  : row.result
                                : row.result;
                            return bit ? `${bit.label} (${tag})` : null;
                          })
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-card-border bg-card p-5">
            <p className="rule-label">Replace kit</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Paste another STL list</h3>
            <Textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              className="mt-3 min-h-32 font-mono text-xs"
              placeholder={"01 Carapace.stl\n18 Head.stl\n..."}
            />
            <Button type="button" className="mt-3" variant="outline" onClick={importPaste}>
              Import pasted list
            </Button>
          </section>
        </div>
      </div>
    </div>
  );
}
