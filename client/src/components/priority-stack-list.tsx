import { useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronUp, MoreHorizontal } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { shopDateLabel } from "@shared/ship-by";
import { orderTitle as orderTitleFromName } from "@/lib/order-title";
import type { FulfillmentChecklistView } from "@shared/schema";
import type { StackTier } from "@shared/priority-stack";
import { cn } from "@/lib/utils";
import { stagePresentation } from "@/lib/stage-chip";

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
  warning?: string;
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

function orderTitle(row: Pick<StackRowModel, "name" | "contactName">): string {
  return orderTitleFromName(row.name, row.contactName);
}

function rowSubtitle(row: Pick<StackRowModel, "contactName" | "shippingRequired">): string {
  const who = row.contactName?.trim();
  const mode = row.shippingRequired ? "Ships" : "Pickup";
  return who ? `${who} · ${mode}` : mode;
}

function PhoneSub({ row }: { row: Pick<StackRowModel, "contactName" | "shippingRequired"> }) {
  const who = row.contactName?.trim();
  const mode = row.shippingRequired ? "Ships" : "Pickup";
  return (
    <span className="stack-phone-sub">
      {who ? <span className="stack-phone-client">{who}</span> : null}
      <span className="stack-phone-mode">{who ? ` · ${mode}` : mode}</span>
    </span>
  );
}

export function targetLabel(
  row: Pick<StackRowModel, "targetDate" | "targetSource" | "tentative">,
  today: string,
): string {
  return shopDateLabel({
    date: row.targetDate,
    today,
    source: row.targetSource,
    tentative: row.tentative,
  });
}

function progressLabel(row: StackRowModel): string {
  if (row.kind === "bundle") {
    const shipped = row.members.filter((member) => member.doneAt).length;
    if (row.shippingRequired && shipped > 0) return `${shipped} of ${row.members.length} shipped`;
    const ready = row.members.filter((member) => member.fulfillment?.shipReady || member.fulfillment?.packingDone).length;
    return `${ready}/${row.members.length} ready`;
  }
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
  const goal = Math.round((view.totals.committed + view.totals.outTheDoor) * 100) / 100;
  const offBook =
    view.totals.offBookUnpriced > 0 ? `+${view.totals.offBookUnpriced} off-book, no amount` : "";
  return (
    <div className="stack-kpis" data-testid="stack-totals">
      <article>
        <p className="stack-kpi-label">Cash this week</p>
        <p className="stack-kpi-value numeric">{money(view.totals.committed)}</p>
        {offBook ? <p className="stack-kpi-note">{offBook}</p> : null}
      </article>
      <article>
        <p className="stack-kpi-label">Out the door</p>
        <p className="stack-kpi-value numeric">
          {money(view.totals.outTheDoor)} <small>/ {money(goal)}</small>
        </p>
      </article>
      <article>
        <p className="stack-kpi-label">Stretch</p>
        <p className="stack-kpi-value numeric">{money(view.totals.stretch)}</p>
      </article>
      <article>
        <p className="stack-kpi-label">Later</p>
        <p className="stack-kpi-value numeric">{money(view.totals.later)}</p>
      </article>
    </div>
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

  const blockerLabel = row.blocker || "Add blocker";
  if (!editing) {
    return (
      <button
        type="button"
        title={blockerLabel}
        className={cn("stack-clip text-left text-sm", row.blockerSource === "auto" && "text-muted-foreground")}
        onClick={() => {
          setDraft(row.blockerSource === "manual" ? row.blocker : "");
          setEditing(true);
        }}
        data-testid={`button-blocker-${row.key}`}
      >
        {row.blockerSource === "auto" && row.blocker ? <span className="stack-auto">auto</span> : null}
        {blockerLabel}
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

  const progress = progressLabel(row);
  const presentation = stagePresentation(row.stage || row.name);
  const done = steps.filter((step) => step.done).length;
  const chip = (
    <span className={cn("stage-chip", `stage-${presentation.tone}`)} title={presentation.label}>
      <i />
      <span className="stack-stage-full">{presentation.label}</span>
      <span className="stack-stage-short">{presentation.short}</span>
    </span>
  );
  if (row.kind === "bundle") {
    const ready = row.members.filter((member) => member.fulfillment?.shipReady || member.fulfillment?.packingDone).length;
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={progress}>
        {chip}
        <span className="numeric stack-prog" data-testid={`text-bundle-progress-${row.key}`}>
          {ready}/{row.members.length}
        </span>
      </span>
    );
  }
  const fraction = row.fulfillment
    ? `${row.fulfillment.completedCount}/${row.fulfillment.totalCount}`
    : steps.length > 0
      ? `${done}/${steps.length}`
      : null;
  if (!fraction) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2" title={progress}>
        {chip}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title={progress} className="inline-flex min-w-0 items-center gap-2 text-left" data-testid={`button-checklist-${row.key}`}>
          {chip}
          <span className="numeric stack-prog" data-testid={`text-checklist-progress-${row.key}`}>{fraction}</span>
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

  if (row.kind === "bundle") {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" title={targetLabel(row, today)} className="stack-clip text-left text-sm" data-testid={`button-target-${row.key}`}>
            {targetLabel(row, today)}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-3">
          <label className="text-xs text-muted-foreground" htmlFor={`target-${row.key}`}>
            Pickup date for every piece
          </label>
          <input
            id={`target-${row.key}`}
            type="date"
            defaultValue={row.targetDate}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            data-testid={`input-target-${row.key}`}
            onChange={(event) => {
              if (!event.target.value) return;
              void (async () => {
                for (const member of row.members) {
                  if (!member.dealId) continue;
                  await apiRequest(
                    "PATCH",
                    `/api/deal-ops/${encodeURIComponent(member.dealId)}/ship-by`,
                    { shipBy: event.target.value, liveWrite: true },
                    { headers },
                  );
                }
                setOpen(false);
                void queryClient.invalidateQueries({ queryKey: ["/api/production-queue"] });
                onSaved();
              })();
            }}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={targetLabel(row, today)}
          className={cn("stack-clip text-left text-sm", row.targetDate < today && "text-destructive", row.targetDate === today && "text-chart-4")}
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
  selected,
  expanded,
  onToggleSelect,
  onToggleExpand,
  onUngroup,
  onDone,
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
  selected: boolean;
  expanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onUngroup: () => void;
  onDone: () => void;
  onOpen: () => void;
  onMove: (direction: -1 | 1 | "top") => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOn: () => void;
  onSaved: () => void;
}) {
  const who = row.contactName ? `${row.name} · ${row.contactName}` : row.name;
  const title = orderTitle(row);
  return (
    <>
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
      <span className="stack-rank">
        {row.kind === "deal" ? (
          <input type="checkbox" className="h-4 w-4" checked={selected} onChange={onToggleSelect} aria-label={`Select ${row.name}`} data-testid={`check-select-${row.key}`} />
        ) : (
          <input type="checkbox" className="h-4 w-4" disabled aria-hidden="true" tabIndex={-1} />
        )}
        <span>{row.rank}</span>
      </span>
      <button type="button" title={who} className="stack-name text-left" onClick={row.kind === "bundle" ? onToggleExpand : onOpen} data-testid={`button-open-${row.key}`}>
        <span className="stack-clip text-sm font-medium">
          {title}
          {row.isNew ? <span className="ml-1 text-xs text-primary">new</span> : null}
          {row.kind === "offbook" ? <span className="stack-auto">off-book</span> : null}
          {row.kind === "bundle" ? <span className="ml-1 text-xs text-muted-foreground">{expanded ? "▾" : "▸"} {row.members.length}</span> : null}
        </span>
        <span className="stack-clip stack-sub">{rowSubtitle(row)}</span>
      </button>
      <div className="stack-facts min-w-0">
        <div className="stack-stage stack-desktop-only min-w-0">
          <ChecklistPopover row={row} headers={headers} onSaved={onSaved} />
        </div>
        <div className="stack-blocker min-w-0">
          {row.warning ? <p className="stack-clip text-xs text-destructive" title={row.warning} data-testid={`text-stack-warning-${row.key}`}>{row.warning}</p> : null}
          <div className="stack-blocker-line">
            <PhoneSub row={row} />
            <InlineBlocker row={row} headers={headers} onSaved={onSaved} />
          </div>
          {row.nextStep ? <p className="stack-clip text-xs text-muted-foreground" title={row.nextStep}>{row.nextStep}</p> : null}
        </div>
        <div className="stack-date stack-desktop-only min-w-0">
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
      <span className="stack-money stack-clip text-sm font-medium">{money(row.amount)}</span>
      <div className="stack-actions stack-desktop-only flex items-center justify-end gap-0.5">
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move up" onClick={() => onMove(-1)} data-testid={`button-up-${row.key}`}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move down" onClick={() => onMove(1)} data-testid={`button-down-${row.key}`}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="Move to top" onClick={() => onMove("top")} data-testid={`button-top-${row.key}`}>
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" title="More" data-testid={`button-more-${row.key}`}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.kind === "bundle" ? (
              <DropdownMenuItem onClick={onUngroup} data-testid={`button-ungroup-${row.key}`}>Ungroup</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onDone} data-testid={`button-done-${row.key}`}>
              {row.shippingRequired ? "Done" : "Picked up"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
    {expanded && row.members.length > 0 ? (
      <div data-testid={`bundle-members-${row.key}`}>
        {row.members.map((member) => (
          <article key={member.key} className="stack-row stack-member" data-lane={member.lane} data-testid={`stack-row-${member.key}`}>
            <span className="stack-rank" />
            <span className="stack-name" title={member.contactName ? `${member.name} · ${member.contactName}` : member.name}>
              <span className="stack-clip text-sm">{orderTitle(member)}</span>
            </span>
            <div className="stack-facts">
              <span className="stack-stage stack-desktop-only stack-clip text-sm" title={member.stage}>{member.stage}</span>
              <div className="stack-blocker min-w-0">
                <div className="stack-blocker-line">
                  <PhoneSub row={member} />
                  <span className="stack-clip text-sm text-muted-foreground" title={member.blocker || member.stage}>{member.blocker || member.stage}</span>
                </div>
              </div>
              <span
                className={cn(
                  "stack-date stack-desktop-only stack-clip text-sm",
                  member.targetDate < today && "text-destructive",
                  member.targetDate === today && "text-chart-4",
                )}
                title={targetLabel(member, today)}
              >
                {targetLabel(member, today)}
              </span>
              <div className="stack-mobile-actions items-center gap-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground">{member.stage}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap text-xs">{targetLabel(member, today)}</span>
              </div>
            </div>
            <span className="stack-money stack-clip text-sm">{money(member.amount)}</span>
            <span className="stack-actions" />
          </article>
        ))}
      </div>
    ) : null}
    </>
  );
}

export function StackCommitLine({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="stack-row stack-commit-line" data-testid={`stack-divider-${label}`}>
      <span className="stack-commit-label">{label}</span>
      <span className="stack-money numeric">{money(amount)}</span>
      <span className="stack-actions" aria-hidden="true" />
    </div>
  );
}

export function StackColumnHead() {
  return (
    <div className="stack-row stack-head" aria-hidden="true">
      <span>#</span>
      <span>Order</span>
      <span>Status</span>
      <span>Blocker</span>
      <span>Target</span>
      <span>Amount</span>
      <span />
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
    out.push({ type: "row", row: { ...row, rank: index + 1 } });
    if (index === lastCommitted) out.push({ type: "divider", label: "This week", amount: totals.committed });
    if (index === lastStretch) out.push({ type: "divider", label: "Stretch", amount: totals.stretch });
  });
  return out;
}
