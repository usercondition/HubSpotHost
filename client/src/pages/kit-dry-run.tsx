import { useMemo, useState } from "react";
import {
  CheckSquare,
  Layers3,
  PackageOpen,
  RotateCcw,
  Search,
  Square,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/shell";
import { StatusPill } from "@/components/primitives";
import { cn } from "@/lib/utils";
import {
  attachBitsToPlate,
  createAcastusDryRunKit,
  groupSummaries,
  kitProgress,
  parseKitFileList,
  resetKitProgress,
  type KitDryRun,
} from "@/lib/kit-dry-run";

export default function KitDryRunPage() {
  const [kit, setKit] = useState<KitDryRun>(() => createAcastusDryRunKit());
  const [paste, setPaste] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plateName, setPlateName] = useState("Plate 1");
  const [note, setNote] = useState<string | null>(null);

  const progress = kitProgress(kit);
  const groups = groupSummaries(kit);
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  const visibleBits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kit.bits.filter((bit) => {
      if (groupFilter !== "all" && bit.group !== groupFilter) return false;
      if (!q) return true;
      return bit.label.toLowerCase().includes(q) || bit.fileName.toLowerCase().includes(q);
    });
  }, [kit.bits, groupFilter, query]);

  const todoVisible = visibleBits.filter((bit) => bit.status === "todo");
  const selectedTodoCount = todoVisible.filter((bit) => selected.has(bit.id)).length;

  const toggleBit = (id: string, disabled: boolean) => {
    if (disabled) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisibleTodo = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const bit of todoVisible) next.add(bit.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const attachPlate = () => {
    const ids = Array.from(selected).filter((id) =>
      kit.bits.some((bit) => bit.id === id && bit.status === "todo"),
    );
    if (ids.length === 0) {
      setNote("Select at least one remaining bit for this plate.");
      return;
    }
    const next = attachBitsToPlate(kit, plateName, ids);
    setKit(next);
    setSelected(new Set());
    setPlateName(`Plate ${next.plates.length + 1}`);
    setNote(`Attached ${ids.length} bit${ids.length === 1 ? "" : "s"} on “${next.plates[0]?.name}”.`);
  };

  const loadAcastus = () => {
    setKit(createAcastusDryRunKit());
    setSelected(new Set());
    setPlateName("Plate 1");
    setGroupFilter("all");
    setQuery("");
    setPaste("");
    setNote("Loaded Acastus Knight Porphyrion sample kit.");
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
    setGroupFilter("all");
    setNote(`Imported ${next.bits.length} bits from paste.`);
  };

  return (
    <div data-testid="page-kit-dry-run">
      <PageHeader
        title="Kit & plate bits"
        subtitle="Prototype only — import an STL filename list, then check off which bits ride on each plate. Nothing is saved to HubSpot."
      />

      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
        This is a UX dry run. Use it to feel the checklist flow before we wire kits to real orders.
      </section>

      <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-kit-summary">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="rule-label">Current kit</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight" data-testid="text-kit-name">
              {kit.name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{kit.sourceNote}</p>
          </div>
          <StatusPill
            tone={progress.remaining === 0 && progress.total > 0 ? "good" : "warn"}
            icon={PackageOpen}
            label={`${progress.done} / ${progress.total} bits`}
            testId="status-kit-progress"
          />
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
            data-testid="bar-kit-progress"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {progress.remaining === 0 && progress.total > 0
            ? "Kit complete for this dry run."
            : `${progress.remaining} bit${progress.remaining === 1 ? "" : "s"} still need a plate.`}
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
              data-testid={`button-kit-group-${group.group.slice(0, 12).replace(/\s+/g, "-").toLowerCase()}`}
            >
              <p className="text-xs font-medium">{group.group}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {group.done}/{group.total}
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
              setNote("Cleared plate assignments.");
            }}
            data-testid="button-reset-kit-progress"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset plates
          </Button>
          {groupFilter !== "all" ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setGroupFilter("all")}>
              Show all groups
            </Button>
          ) : null}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-simulate-plate">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="rule-label">Simulate attach plate</p>
              <h3 className="mt-1 text-base font-semibold tracking-tight">Bits on this plate</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Search or filter a group, check the bits you loaded, then attach. Already-assigned bits stay locked.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs">
              <span className="text-muted-foreground">Plate name</span>
              <Input
                value={plateName}
                onChange={(event) => setPlateName(event.target.value)}
                placeholder="Plate 1"
                data-testid="input-plate-name"
              />
            </label>
            <label className="space-y-1.5 text-xs">
              <span className="text-muted-foreground">Search bits</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-8"
                  placeholder="leg, torso, head…"
                  data-testid="input-bit-search"
                />
              </div>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={selectVisibleTodo} data-testid="button-select-visible">
              Select visible remaining ({todoVisible.length})
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clearSelection}>
              Clear selection
            </Button>
          </div>

          <ul
            className="mt-4 max-h-[28rem] space-y-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-2"
            data-testid="list-kit-bits"
          >
            {visibleBits.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">No bits match this filter.</li>
            ) : (
              visibleBits.map((bit) => {
                const locked = bit.status === "on_plate";
                const checked = locked || selected.has(bit.id);
                return (
                  <li key={bit.id}>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => toggleBit(bit.id, locked)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                        locked
                          ? "cursor-default opacity-60"
                          : checked
                            ? "bg-primary/10 hover:bg-primary/15"
                            : "hover:bg-muted/70",
                      )}
                      data-testid={`button-bit-${bit.id}`}
                    >
                      {checked ? (
                        <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium leading-5">{bit.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {bit.group}
                          {locked ? " · already on a plate" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={attachPlate} data-testid="button-attach-plate">
              <Upload className="mr-2 h-4 w-4" />
              Attach plate with {selectedTodoCount} bit{selectedTodoCount === 1 ? "" : "s"}
            </Button>
            {note ? (
              <p className="text-sm text-muted-foreground" data-testid="text-kit-note">
                {note}
              </p>
            ) : null}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-plate-history">
            <p className="rule-label">Plates in this dry run</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Attachment history</h3>
            {kit.plates.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No plates yet — attach one from the left.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {kit.plates.map((plate) => (
                  <li key={plate.id} className="rounded-md border border-border bg-muted/30 p-3">
                    <p className="text-sm font-medium">{plate.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {plate.bitIds.length} bit{plate.bitIds.length === 1 ? "" : "s"} ·{" "}
                      {new Date(plate.attachedAt).toLocaleString()}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">
                      {plate.bitIds
                        .map((id) => kit.bits.find((bit) => bit.id === id)?.label)
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-card-border bg-card p-5" data-testid="panel-paste-import">
            <p className="rule-label">Replace kit</p>
            <h3 className="mt-1 text-base font-semibold tracking-tight">Paste another STL list</h3>
            <p className="mt-1 text-xs text-muted-foreground">One filename per line. Subfolder paths are fine — only the file name is kept.</p>
            <Textarea
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              className="mt-3 min-h-32 font-mono text-xs"
              placeholder={"01 Carapace.stl\n18 Head.stl\n..."}
              data-testid="input-kit-paste"
            />
            <Button type="button" className="mt-3" variant="outline" onClick={importPaste} data-testid="button-import-paste">
              Import pasted list
            </Button>
          </section>
        </div>
      </div>
      </div>
    </div>
  );
}
