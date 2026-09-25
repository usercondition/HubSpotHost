import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readHashQueryParam } from "@/lib/workflow";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { DealOpsDrawer } from "@/components/deal-ops-panel";
import { Panel } from "@/components/primitives";
import {
  StackCommitLine,
  StackRow,
  StackTotalsBar,
  rowsWithDividers,
  type StackView,
} from "@/components/priority-stack-list";

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
  const [selectedDealId, setSelectedDealId] = useState<string | null>(() => readHashQueryParam("dealId"));
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  const stack = useQuery<StackView>({
    queryKey: ["/api/priority-stack", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/priority-stack", undefined, { headers });
      return (await response.json()) as StackView;
    },
  });

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
            <div className="flex gap-2">
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
            <DealOpsDrawer dealId={selectedDealId} headers={headers} onClose={() => setSelectedDealId(null)} />
          </>
        )}
      </div>
    </div>
  );
}
