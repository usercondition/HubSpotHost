import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import Supplies from "@/pages/supplies";
import Expenses from "@/pages/expenses";
import { spendingTabFor } from "@/lib/spending-tabs";

type BottomLine = {
  revenue: number; orderCosts: number; grossProfit: number; supplies: number; overhead: number; bottomLine: number;
  ordersCounted: number; ordersMissingCost: number; supplyReceipts: number; estimated: boolean;
};
type SummaryResponse = { ok: true; period: { id: string; label: string }; bottomLine: BottomLine };

const PERIODS = [
  { id: "7", label: "7d" },
  { id: "30", label: "30d" },
  { id: "90", label: "90d" },
  { id: "ytd", label: "YTD" },
  { id: "all", label: "All" },
] as const;

const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function Spending() {
  const [location, setLocation] = useLocation();
  const tab = spendingTabFor(location.split("?")[0] || "/");
  const { isUnlocked } = useOwnerSession();
  const unlock = useOwnerUnlock({ successTitle: "Spending unlocked", successDescription: "Supplies, overhead and the bottom line." });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Spending" subtitle="What the shop spends — supply receipts and overhead — against order profit." />
      {!isUnlocked ? (
        <OwnerUnlockPanel
          title="Unlock spending"
          description="Enter the owner code to see supplies, overhead and the bottom line."
          buttonLabel="Unlock spending"
          testIdPrefix="spending"
          pending={unlock.isPending}
          onUnlock={(code) => unlock.mutate(code)}
        />
      ) : (
        <div className="page-stack">
          <BottomLinePanel />
          <div role="tablist" aria-label="Spending" className="flex gap-1 border-b" data-testid="tabs-spending">
            {([
              ["supplies", "Supplies", "/spending"],
              ["overhead", "Overhead", "/spending/overhead"],
            ] as const).map(([id, label, href]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                data-testid={`tab-spending-${id}`}
                onClick={() => setLocation(href)}
                className={cn(
                  "min-h-11 border-b-2 px-4 text-sm",
                  tab === id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel">{tab === "supplies" ? <Supplies embedded /> : <Expenses embedded />}</div>
        </div>
      )}
    </div>
  );
}

function BottomLinePanel() {
  const { headers, ownerCode } = useOwnerSession();
  const [period, setPeriod] = useState("30");
  const summary = useQuery<SummaryResponse>({
    queryKey: ["/api/spending/summary", period, ownerCode],
    queryFn: async () => (await apiRequest("GET", `/api/spending/summary?period=${period}`, undefined, { headers })).json(),
  });
  const line = summary.data?.bottomLine;
  const rows: Array<[string, number, string]> = line
    ? [
        ["Order revenue", line.revenue, `${line.ordersCounted} order${line.ordersCounted === 1 ? "" : "s"} with full costs (HubSpot)`],
        ["− Order costs", -line.orderCosts, line.estimated ? "material, packaging, postage · includes slicer estimates" : "material, packaging, postage"],
        ["− Supplies", -line.supplies, `${line.supplyReceipts} receipt${line.supplyReceipts === 1 ? "" : "s"} · Supplies tab`],
        ["− Overhead", -line.overhead, "prorated subscriptions + charges · Overhead tab"],
      ]
    : [];
  return (
    <Panel
      title="Bottom line"
      description="Revenue − order costs − supplies − overhead. Each dollar is counted once."
      testId="panel-spending-bottom-line"
      actions={
        <div className="flex items-center gap-1" role="group" aria-label="Period">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              onClick={() => setPeriod(item.id)}
              aria-pressed={period === item.id}
              data-testid={`button-spending-period-${item.id}`}
              className={cn("min-h-9 rounded px-2 text-xs", period === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {item.label}
            </button>
          ))}
        </div>
      }
    >
      {summary.isLoading ? (
        <Skeleton className="h-40 rounded-md" />
      ) : !line ? (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>HubSpot order money is unavailable right now.</span>
          <Button size="sm" variant="outline" onClick={() => summary.refetch()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Retry</Button>
        </div>
      ) : (
        <div className="space-y-1" data-testid="list-spending-bottom-line">
          {rows.map(([label, value, hint]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5">
              <span className="min-w-0"><span className="block text-sm">{label}</span><small className="block truncate text-xs text-muted-foreground">{hint}</small></span>
              <span className="numeric shrink-0 text-sm">{money(value)}</span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 pt-2" data-testid="row-spending-bottom-line">
            <span className="text-base font-semibold">= Bottom line</span>
            <span className={cn("numeric text-lg font-semibold", line.bottomLine < 0 ? "text-destructive" : "text-chart-4")}>{money(line.bottomLine)}</span>
          </div>
          {line.ordersMissingCost > 0 ? (
            <p className="pt-1 text-xs text-muted-foreground">{line.ordersMissingCost} order{line.ordersMissingCost === 1 ? "" : "s"} in this period left out until amount, material and postage are entered.</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
