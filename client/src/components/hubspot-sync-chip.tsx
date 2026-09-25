import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useOwnerSession } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import type { HealthResponse, HubspotSyncSummary } from "@shared/schema";

interface SyncDriftItem {
  kind: string;
  dealId: string | null;
  field: string | null;
  local: string | null;
  hubspot: string | null;
  repairable: boolean;
  suggestedFix: string;
}

interface SyncHealthDetail {
  ok: true;
  summary: HubspotSyncSummary;
  items: SyncDriftItem[];
}

const KIND_LABEL: Record<string, string> = {
  missingInOps: "Missing from Queue",
  orphans: "Orphan row",
  tracking: "Tracking",
  shipNotes: "Ship notes",
  shipBy: "Ship-by",
  costs: "Cost",
  amount: "Amount",
  doneStillOpen: "Done, still open in HubSpot",
  closedNotDone: "Closed in HubSpot",
  failedWrites: "Failed write",
  webhook: "Webhooks",
  token: "HubSpot connection",
};

export function syncIssueLabel(count: number): string {
  return `HubSpot sync: ${count} ${count === 1 ? "issue" : "issues"}`;
}

export function syncChipLabel(summary: HubspotSyncSummary | undefined): string {
  const issues = summary?.issueCount ?? 0;
  const pending = summary?.writes?.pending ?? 0;
  const failed = summary?.writes?.failed ?? 0;
  const parts: string[] = [];
  if (issues > 0) parts.push(`${issues} ${issues === 1 ? "issue" : "issues"}`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? `HubSpot sync: ${parts.join(" · ")}` : "HubSpot sync";
}

export function HubspotSyncChip() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const summary = health.data?.hubspotSync;
  const count = summary?.issueCount ?? 0;
  const pending = summary?.writes?.pending ?? 0;
  const failed = summary?.writes?.failed ?? 0;
  if (count < 1 && pending < 1 && failed < 1) return null;
  return (
    <HubspotSyncDialog
      trigger={
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-chart-4/10 px-2 py-1 text-[0.8125rem] font-semibold text-chart-4"
          data-testid="button-hubspot-sync"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {syncChipLabel(summary)}
        </button>
      }
    />
  );
}

export function HubspotSyncDialog({ trigger }: { trigger: ReactNode }) {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const count = health.data?.hubspotSync?.issueCount ?? 0;
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg" data-testid="panel-hubspot-sync">
        <DialogHeader>
          <DialogTitle>{count > 0 ? syncIssueLabel(count) : "HubSpot sync"}</DialogTitle>
          <DialogDescription>
            {health.data?.hubspotSync?.webhook.note || "Deals that drifted between HubSpot and Print Ops."}
          </DialogDescription>
        </DialogHeader>
        <SyncHealthBody />
      </DialogContent>
    </Dialog>
  );
}

function SyncHealthBody() {
  const { isUnlocked, headers, ownerCode } = useOwnerSession();
  const detail = useQuery<SyncHealthDetail>({
    queryKey: ["/api/sync-health", ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/sync-health", undefined, { headers });
      return (await response.json()) as SyncHealthDetail;
    },
  });

  if (!isUnlocked) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-sync-health-locked">
        Unlock Print Ops to see which deals drifted.
      </p>
    );
  }
  if (detail.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking HubSpot…
      </div>
    );
  }
  if (detail.isError || !detail.data?.ok) {
    return <p className="text-sm text-destructive">Could not load the sync detail.</p>;
  }
  const items = detail.data.items;
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="text-sync-health-clear">
        HubSpot and Print Ops match.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item.kind}-${item.dealId ?? "none"}-${item.field ?? index}`}
          className="rounded-md bg-muted/45 px-3 py-2"
          data-testid={`row-sync-health-${item.kind}-${item.dealId ?? "none"}`}
        >
          <p className="text-xs font-semibold text-chart-4">{KIND_LABEL[item.kind] ?? item.kind}</p>
          {item.dealId ? <p className="mt-0.5 font-mono text-xs text-muted-foreground">Deal {item.dealId}</p> : null}
          <p className="mt-1 text-sm leading-5">{item.suggestedFix}</p>
          {item.local || item.hubspot ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Print Ops: {item.local || "blank"} · HubSpot: {item.hubspot || "blank"}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
