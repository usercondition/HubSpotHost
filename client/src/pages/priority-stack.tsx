import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { stackDrawerDealId } from "@/lib/deal-link";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readHashQueryParam, stripDealIdFromLocation } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsDrawer } from "@/components/deal-ops-panel";
import { Panel } from "@/components/primitives";
import { formatMoney } from "@/lib/format";
import {
  StackCommitLine,
  StackRow,
  StackTotalsBar,
  rowsWithDividers,
  type StackView,
} from "@/components/priority-stack-list";
import { OffbookEntryDialog } from "@/components/offbook-entry-dialog";
import { StackBundleDialog } from "@/components/stack-bundle-dialog";

function useDesktopDrag(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(pointer: fine) and (min-width: 768px)");
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return desktop;
}

export default function PriorityStackPage() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const unlock = useOwnerUnlock({
    successTitle: "Stack unlocked",
    successDescription: "This week's cash, in the order it leaves the shop.",
  });
  const desktopDrag = useDesktopDrag();
  // Capture before effects run. A tab click only changes the hash, so a stale
  // `/?dealId=` must be remembered once and then removed from search and hash.
  const pendingDealId = useRef<string | null | undefined>(undefined);
  if (pendingDealId.current === undefined) {
    pendingDealId.current = readHashQueryParam("dealId");
  }
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);

  useEffect(() => {
    stripDealIdFromLocation();
  }, []);

  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [offbookOpen, setOffbookOpen] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);

  const stack = useQuery<StackView>({
    queryKey: ["/api/priority-stack", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/priority-stack", undefined, { headers });
      return (await response.json()) as StackView;
    },
  });

  useEffect(() => {
    const id = pendingDealId.current;
    if (!id || !stack.data) return;
    pendingDealId.current = null;
    const openId = stackDrawerDealId(id, { rows: stack.data.rows, outTheDoor: stack.data.outTheDoor });
    if (openId) setSelectedDealId(openId);
  }, [stack.data]);

  async function persistOrder(keys: string[]) {
    const previous = stack.data;
    queryClient.setQueryData<StackView>(["/api/priority-stack", ownerCode], (current) => {
      if (!current) return current;
      const byKey = new Map(current.rows.map((row) => [row.key, row]));
      const rows = keys.flatMap((key, index) => {
        const row = byKey.get(key);
        return row ? [{ ...row, rank: index + 1, manual: true }] : [];
      });
      return { ...current, rows };
    });
    try {
      await apiRequest("PUT", "/api/priority-stack/order", { keys }, { headers });
    } finally {
      if (!previous) void stack.refetch();
      else void queryClient.invalidateQueries({ queryKey: ["/api/priority-stack", ownerCode] });
    }
  }

  function move(key: string, direction: -1 | 1 | "top") {
    const rows = stack.data?.rows ?? [];
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    const keys = rows.map((row) => row.key);
    const [moved] = keys.splice(index, 1);
    if (direction === "top") keys.unshift(moved);
    else {
      const next = Math.min(keys.length, Math.max(0, index + direction));
      keys.splice(next, 0, moved);
    }
    void persistOrder(keys);
  }

  function dropOn(targetKey: string) {
    if (!draggingKey || draggingKey === targetKey) return;
    const keys = (stack.data?.rows ?? []).map((row) => row.key);
    const from = keys.indexOf(draggingKey);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    keys.splice(from, 1);
    keys.splice(to, 0, draggingKey);
    setDraggingKey(null);
    void persistOrder(keys);
  }

  const data = stack.data;
  const lines = data ? rowsWithDividers(data.rows, data.totals) : [];

  return (
    <div className="mx-auto flex max-w-6xl flex-col">
      <PageHeader
        title="Stack"
        subtitle=""
        actions={
          isUnlocked ? (
            <div className="flex w-full min-w-0 flex-wrap justify-end gap-1.5 sm:w-auto">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void apiRequest("DELETE", "/api/priority-stack/order", undefined, { headers }).then(() => stack.refetch());
                }}
                data-testid="button-reset-stack"
              >
                Reset to auto
              </Button>
              <Button size="sm" variant="outline" onClick={() => setOffbookOpen(true)} data-testid="button-add-offbook">
                + Off-book
              </Button>
              {selected.length >= 2 ? (
                <Button size="sm" variant="outline" onClick={() => setBundleOpen(true)} data-testid="button-bundle-selected">
                  Bundle…
                </Button>
              ) : (
                <span className="hidden self-center text-xs text-muted-foreground sm:inline" data-testid="text-bundle-hint">
                  Select 2+ to bundle
                </span>
              )}
              <Button size="sm" variant="outline" onClick={() => stack.refetch()} disabled={stack.isFetching} data-testid="button-refresh-stack">
                {stack.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                Refresh
              </Button>
            </div>
          ) : null
        }
      />
      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock the priority stack"
            description="Same owner code as Floor. What gets out the door this week."
            buttonLabel="Unlock Stack"
            testIdPrefix="stack"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : stack.isLoading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : stack.isError || !data ? (
          <Panel title="Stack could not be loaded">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {(stack.error as Error | null)?.message?.replace(/^\d+:\s*/, "") || "Check HubSpot connectivity."}
              </p>
            </div>
          </Panel>
        ) : (
          <>
            <StackTotalsBar view={data} />
            <div className="overflow-hidden rounded-lg border border-border" data-testid="stack-list">
              {lines.map((line) =>
                line.type === "divider" ? (
                  <StackCommitLine key={line.label} label={line.label} amount={line.amount} />
                ) : (
                  <StackRow
                    key={line.row.key}
                    row={line.row}
                    today={data.today}
                    headers={headers}
                    desktopDrag={desktopDrag}
                    dragging={draggingKey === line.row.key}
                    selected={line.row.dealId != null && selected.includes(line.row.dealId)}
                    expanded={expanded === line.row.key}
                    onToggleSelect={() => {
                      const id = line.row.dealId;
                      if (!id) return;
                      setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
                    }}
                    onToggleExpand={() => setExpanded((current) => (current === line.row.key ? null : line.row.key))}
                    onUngroup={() => {
                      if (!line.row.bundleId) return;
                      void apiRequest("DELETE", `/api/priority-stack/bundles/${line.row.bundleId}`, undefined, { headers }).then(() => stack.refetch());
                    }}
                    onDone={() => {
                      void apiRequest("POST", "/api/priority-stack/done", { key: line.row.key }, { headers }).then(() => stack.refetch());
                    }}
                    onOpen={() => setSelectedDealId(line.row.dealId)}
                    onMove={(direction) => move(line.row.key, direction)}
                    onDragStart={() => setDraggingKey(line.row.key)}
                    onDragEnd={() => setDraggingKey(null)}
                    onDropOn={() => dropOn(line.row.key)}
                    onSaved={() => void stack.refetch()}
                  />
                ),
              )}
              {data.rows.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing open on the stack.</p>
              ) : null}
            </div>
            {data.outTheDoor.length > 0 ? (
              <details className="overflow-hidden rounded-lg border border-border" data-testid="stack-out-the-door">
                <summary className="stack-commit-line cursor-pointer">
                  <span>Out the door</span>
                  <span className="numeric">{formatMoney(data.totals.outTheDoor)}</span>
                </summary>
                <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  Undo only clears the local done mark. HubSpot stage is not reverted.
                </p>
                {data.outTheDoor.map((row) => (
                  <div
                    key={row.key}
                    className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-sm"
                    data-testid={`stack-done-${row.key}`}
                  >
                    <span className="min-w-0 truncate">{row.contactName || row.name}</span>
                    <span className="shrink-0 text-muted-foreground">{row.shippingRequired ? "Shipped" : "Picked up"}</span>
                    <span className="numeric shrink-0">{row.amount == null ? "—" : formatMoney(row.amount)}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`button-undo-done-${row.key}`}
                      onClick={() => {
                        void apiRequest("DELETE", "/api/priority-stack/done", { key: row.key }, { headers }).then(() => stack.refetch());
                      }}
                    >
                      Undo
                    </Button>
                  </div>
                ))}
              </details>
            ) : null}
            <DealOpsDrawer dealId={selectedDealId} headers={headers} onClose={() => setSelectedDealId(null)} />
            {offbookOpen ? (
              <OffbookEntryDialog headers={headers} onClose={() => setOffbookOpen(false)} onSaved={() => void stack.refetch()} />
            ) : null}
            {bundleOpen ? (
              <StackBundleDialog
                dealIds={selected}
                headers={headers}
                onClose={() => setBundleOpen(false)}
                onSaved={() => {
                  setSelected([]);
                  void stack.refetch();
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
