import { useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronUp, ListChecks } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { formatShipByShort, shipByCalendarDate } from "@shared/ship-by";
import type { FulfillmentChecklistView } from "@shared/schema";
import type { StackTier } from "@shared/priority-stack";
import { cn } from "@/lib/utils";

export interface StackStep {
  label: string;
  done: boolean;
}

export interface StackRowModel {
  key: string;
  kind: "deal" | "offbook" | "bundle";
  rank: number;
  manual: boolean;
  isNew: boolean;
  name: string;
  contactName: string | null;
  stage: string;
  bucket: string;
  lane: "plates" | "fly" | "bad" | "good" | "shop";
  blocker: string;
  blockerSource: "manual" | "auto";
  nextStep: string;
  targetDate: string;
  targetSource: "override" | "derived" | "local" | "unset";
  tentative: boolean;
  amount: number | null;
  tier: StackTier;
  shippingRequired: boolean;
  dealId: string | null;
  offbookId: number | null;
  bundleId: number | null;
  fulfillment: FulfillmentChecklistView | null;
  steps: StackStep[];
  members: StackRowModel[];
}

export interface StackView {
  ok: true;
  generatedAt: string;
  today: string;
  weekEnd: string;
  rows: StackRowModel[];
  outTheDoor: StackRowModel[];
  totals: {
    committed: number;
    stretch: number;
    later: number;
    outTheDoor: number;
    offBookUnpriced: number;
  };
  hiddenCount: number;
}

const FULFILLMENT_STEPS: Array<{ key: keyof FulfillmentChecklistView; label: string; shipOnly?: boolean }> = [
  { key: "addressVerified", label: "Address", shipOnly: true },
  { key: "costsEntered", label: "Costs" },
  { key: "labelBought", label: "Label", shipOnly: true },
  { key: "trackingPasted", label: "Tracking", shipOnly: true },
  { key: "packingDone", label: "Packed" },
];

function money(amount: number | null): string {
  return amount == null ? "—" : formatMoney(amount);
}

function targetLabel(row: StackRowModel, today: string): string {
  const when =
    row.targetDate < today
      ? `Overdue ${formatShipByShort(row.targetDate)}`
      : row.targetDate === today
        ? "Due today"
        : formatShipByShort(row.targetDate);
  const honesty =
    row.targetSource === "override" || row.targetSource === "local"
      ? " · set"
      : row.targetSource === "unset"
        ? " · unset"
        : " · plan";
  return `${row.tentative ? "~" : ""}${when}${honesty}`;
}

function progressLabel(row: StackRowModel): string {
  if (row.kind === "offbook") {
    if (row.steps.length === 0) return row.stage;
    const done = row.steps.filter((step) => step.done).length;
    return `${row.stage} · ${done}/${row.steps.length}`;
  }
  const steps = FULFILLMENT_STEPS.filter((step) => row.shippingRequired || !step.shipOnly);
  const checklist = row.fulfillment;
  if (!checklist) return row.stage;
  const done = steps.filter((step) => checklist[step.key] === true).length;
  return `${row.stage} · ${done}/${steps.length}`;
}

export function StackTotalsBar({ view }: { view: StackView }) {
  const offBook =
    view.totals.offBookUnpriced > 0
      ? ` (+${view.totals.offBookUnpriced} off-book, no amount)`
      : "";
  const goal = view.totals.committed;
  return (
    <p className="scan-facts text-sm" data-testid="stack-totals">
      <span>
        Cash this week <span className="text-foreground">{money(view.totals.committed)}</span>
        {offBook}
      </span>
      <span>
        Stretch <span className="text-foreground">{money(view.totals.stretch)}</span>
      </span>
      <span>
        Out the door <span className="text-foreground">{money(view.totals.outTheDoor)} / {money(goal)}</span>
      </span>
    </p>
  );
}

function InlineBlocker({
  row,
  headers,
  onSaved,
}: {
  row: StackRowModel;
  headers: Record<string, string>;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.blocker);
  const save = useMutation({
    mutationFn: async (blocker: string) => {
      const path =
        row.kind === "bundle"
          ? `/api/priority-stack/bundles/${row.bundleId}`
          : row.kind === "offbook"
            ? `/api/priority-stack/offbook/${row.offbookId}`
            : `/api/priority-stack/deals/${row.dealId}`;
      await apiRequest("PATCH", path, { blocker }, { headers });
    },
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Could not save blocker", description: error.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  if (!editing) {
    return (
      <button
        type="button"
        className={cn("min-w-0 truncate text-left text-sm", row.blockerSource === "auto" && "text-muted-foreground")}
        onClick={() => {
          setDraft(row.blockerSource === "manual" ? row.blocker : "");
          setEditing(true);
        }}
        data-testid={`button-blocker-${row.key}`}
      >
        {row.blockerSource === "auto" && row.blocker ? `(auto) ${row.blocker}` : row.blocker || "Add blocker"}
      </button>
    );
  }

  return (
    <input
      autoFocus
      className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
      value={draft}
      maxLength={500}
      data-testid={`input-blocker-${row.key}`}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") save.mutate(draft.trim());
        if (event.key === "Escape") setEditing(false);
      }}
      onBlur={() => save.mutate(draft.trim())}
    />
  );
}

function ChecklistPopover({
  row,
  headers,
  onSaved,
}: {
  row: StackRowModel;
  headers: Record<string, string>;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const toggle = useMutation({
    mutationFn: async (patch: Record<string, boolean>) => {
      if (row.kind === "offbook" && row.offbookId) {
        const steps = row.steps.map((step) =>
          patch[step.label] === undefined ? step : { ...step, done: patch[step.label] },
        );
        await apiRequest("PATCH", `/api/priority-stack/offbook/${row.offbookId}`, { steps }, { headers });
        return;
      }
      if (!row.dealId) return;
      await apiRequest("PATCH", `/api/fulfillment/${encodeURIComponent(row.dealId)}`, { ...patch, liveWrite: true }, { headers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Could not update checklist", description: error.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const steps =
    row.kind === "offbook"
      ? row.steps.map((step) => ({ id: step.label, label: step.label, done: step.done, patch: { [step.label]: !step.done } }))
      : FULFILLMENT_STEPS.filter((step) => row.shippingRequired || !step.shipOnly).map((step) => ({
          id: String(step.key),
          label: step.label,
          done: row.fulfillment?.[step.key] === true,
          patch: { [step.key]: row.fulfillment?.[step.key] !== true },
        }));

  if (steps.length === 0 || row.kind === "bundle") return <span className="text-sm">{progressLabel(row)}</span>;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 text-left text-sm" data-testid={`button-checklist-${row.key}`}>
          <ListChecks className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{progressLabel(row)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <ul className="space-y-1">
          {steps.map((step) => (
            <li key={step.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => toggle.mutate(step.patch)}
                data-testid={`check-stack-${row.key}-${step.id}`}
              >
                <Check className={cn("h-3.5 w-3.5", step.done ? "text-accent" : "opacity-30")} />
                {step.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function DateEditor({
  row,
  headers,
  onSaved,
  today,
}: {
  row: StackRowModel;
  headers: Record<string, string>;
  onSaved: () => void;
  today: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: async (shipBy: string) => {
      if (row.kind === "offbook" && row.offbookId) {
        await apiRequest("PATCH", `/api/priority-stack/offbook/${row.offbookId}`, { targetDate: shipBy }, { headers });
        return;
      }
      if (!row.dealId) return;
      await apiRequest(
        "PATCH",
        `/api/deal-ops/${encodeURIComponent(row.dealId)}/ship-by`,
        { shipBy, liveWrite: true },
        { headers },
      );
    },
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Could not save target date", description: error.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  if (row.kind === "bundle") return <span className="text-sm">{targetLabel(row, today)}</span>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("text-left text-sm", row.targetDate < today && "text-destructive", row.targetDate === today && "text-chart-4")}
          data-testid={`button-target-${row.key}`}
        >
          {targetLabel(row, today)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3">
        <label className="text-xs text-muted-foreground" htmlFor={`target-${row.key}`}>
          Target date
        </label>
        <input
          id={`target-${row.key}`}
          type="date"
          defaultValue={row.targetDate}
          className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          data-testid={`input-target-${row.key}`}
          onChange={(event) => {
            if (event.target.value) save.mutate(event.target.value);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function StackRow({
  row,
  today,
  headers,
  desktopDrag,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
  onDropOn,
  onSaved,
}: {
  row: StackRowModel;
  today: string;
  headers: Record<string, string>;
  desktopDrag: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMove: (direction: -1 | 1 | "top") => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
  onSaved: () => void;
}) {
  const who = row.contactName ? `${row.name} · ${row.contactName}` : row.name;
  return (
    <article
      className={cn("stack-row workspace-node", dragging && "opacity-60")}
      data-lane={row.lane}
      data-testid={`stack-row-${row.key}`}
      draggable={desktopDrag}
      onDragStart={(event) => {
        if (!desktopDrag) return;
        event.dataTransfer.setData("text/plain", row.key);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!desktopDrag) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!desktopDrag) return;
        event.preventDefault();
        onDropOn();
      }}
    >
      <span className="stack-rank">{row.rank}</span>
      <button type="button" className="stack-name min-w-0 truncate text-left text-sm font-medium" onClick={onOpen} data-testid={`button-open-${row.key}`}>
        {who}
        {row.isNew ? <span className="ml-1 text-xs text-primary">new</span> : null}
        {row.kind === "offbook" ? <span className="ml-1 text-xs text-muted-foreground">off-book</span> : null}
      </button>
      <div className="stack-facts min-w-0 md:contents">
        <div className="stack-desktop-only min-w-0">
          <ChecklistPopover row={row} headers={headers} onSaved={onSaved} />
        </div>
        <div className="min-w-0">
          <InlineBlocker row={row} headers={headers} onSaved={onSaved} />
          {row.nextStep ? <p className="truncate text-xs text-muted-foreground">{row.nextStep}</p> : null}
        </div>
        <div className="stack-desktop-only">
          <DateEditor row={row} headers={headers} onSaved={onSaved} today={today} />
        </div>
        <div className="stack-mobile-actions items-center gap-2">
          <ChecklistPopover row={row} headers={headers} onSaved={onSaved} />
          <DateEditor row={row} headers={headers} onSaved={onSaved} today={today} />
          <Button type="button" size="icon" variant="ghost" className="ml-auto h-8 w-8" onClick={() => onMove(-1)} data-testid={`button-up-mobile-${row.key}`}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => onMove(1)} data-testid={`button-down-mobile-${row.key}`}>
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <span className="stack-money text-sm font-medium">{money(row.amount)}</span>
      <div className="stack-desktop-only flex items-center gap-0.5">
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move up" onClick={() => onMove(-1)} data-testid={`button-up-${row.key}`}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move down" onClick={() => onMove(1)} data-testid={`button-down-${row.key}`}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move to top" onClick={() => onMove("top")} data-testid={`button-top-${row.key}`}>
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      </div>
    </article>
  );
}

export function StackCommitLine({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="stack-commit-line" data-testid={`stack-divider-${label}`}>
      <span>{label}</span>
      <span className="numeric">{money(amount)}</span>
    </div>
  );
}

export function rowsWithDividers(rows: StackRowModel[], totals: StackView["totals"]): Array<
  | { type: "row"; row: StackRowModel }
  | { type: "divider"; label: string; amount: number }
> {
  const lastCommitted = rows.reduce((found, row, index) => (row.tier === "committed" ? index : found), -1);
  const lastStretch = rows.reduce((found, row, index) => (row.tier === "stretch" ? index : found), -1);
  const out: Array<{ type: "row"; row: StackRowModel } | { type: "divider"; label: string; amount: number }> = [];
  rows.forEach((row, index) => {
    out.push({ type: "row", row });
    if (index === lastCommitted) out.push({ type: "divider", label: "this week", amount: totals.committed });
    if (index === lastStretch) out.push({ type: "divider", label: "stretch", amount: totals.stretch });
  });
  return out;
}
