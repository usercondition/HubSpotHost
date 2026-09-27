import { lazy, Suspense, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { OwnerUnlockPanel, useOwnerSession, useOwnerUnlock } from "@/hooks/use-owner-session";
import { PageHeader } from "@/components/shell";
import { Panel } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { PerformanceResponse } from "@shared/schema";
import { SHOP_PERIODS, type ShopDashboard, type ShopMetric, type ShopPeriodId } from "@shared/shop-dashboard";
const OrderOriginMap = lazy(async () => import("@/components/order-origin-map").then((module) => ({ default: module.OrderOriginMap })));

type DashboardResponse = PerformanceResponse & { dashboard?: ShopDashboard };

const PERIOD_LABEL: Record<ShopPeriodId, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  ytd: "Year to date",
  all: "All time",
};

function money(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatValue(metric: ShopMetric): string {
  if (metric.value == null) return "—";
  if (metric.unit === "usd") return money(metric.value);
  if (metric.unit === "percent") return `${metric.value.toFixed(1)}%`;
  if (metric.unit === "hours") return `${metric.value.toFixed(1)} h`;
  if (metric.unit === "ml") return `${metric.value.toFixed(0)} ml`;
  if (metric.unit === "days") return `${metric.value.toFixed(metric.value % 1 === 0 ? 0 : 1)} d`;
  return String(metric.value);
}

function formatDelta(metric: ShopMetric): string | null {
  if (!metric.compare || metric.value == null || metric.previous == null) return null;
  const delta = Math.round((metric.value - metric.previous) * 100) / 100;
  const sign = delta > 0 ? "+" : "";
  if (metric.unit === "usd") return `${sign}${money(delta)}`;
  if (metric.unit === "percent") return `${sign}${delta.toFixed(1)} pt`;
  if (metric.unit === "hours") return `${sign}${delta.toFixed(1)} h`;
  if (metric.unit === "ml") return `${sign}${delta.toFixed(0)} ml`;
  if (metric.unit === "days") return `${sign}${delta.toFixed(1)} d`;
  return `${sign}${delta}`;
}

function Spark({ series }: { series: number[] }) {
  const max = Math.max(...series, 0);
  if (series.length < 2 || max <= 0) return null;
  return (
    <span className="mt-2 flex h-6 items-end gap-1" aria-hidden="true">
      {series.map((value, index) => (
        <span key={index} className="w-2 rounded-sm bg-primary/70" style={{ height: `${Math.max(8, Math.round((value / max) * 100))}%` }} />
      ))}
    </span>
  );
}

function MetricRow({ metric, open, onToggle }: { metric: ShopMetric; open: boolean; onToggle: () => void }) {
  const delta = formatDelta(metric);
  const up = metric.previous != null && metric.value != null && metric.value >= metric.previous;
  return (
    <div className="border-b border-border/70 py-2 last:border-b-0" data-testid={`metric-${metric.id}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_7.25rem] items-baseline gap-3">
        <button type="button" className="min-w-0 truncate text-left text-sm text-foreground" title={metric.formula} aria-expanded={open} onClick={onToggle}>
          {metric.label}
        </button>
        <p className="numeric text-right text-sm font-semibold">{formatValue(metric)}</p>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">{metric.note ?? (metric.compare ? "" : "Right now")}</p>
        {delta ? (
          <p className={cn("numeric inline-flex w-[7.25rem] shrink-0 items-center justify-end gap-0.5 text-xs", up ? "text-accent" : "text-destructive")}>
            {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {delta}
          </p>
        ) : (
          <span className="w-[7.25rem] shrink-0" />
        )}
      </div>
      {open ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{metric.formula}</p> : null}
    </div>
  );
}

function MetricList({ metrics, openId, setOpenId }: { metrics: ShopMetric[]; openId: string | null; setOpenId: (id: string | null) => void }) {
  return (
    <div>
      {metrics.map((item) => (
        <MetricRow key={item.id} metric={item} open={openId === item.id} onToggle={() => setOpenId(openId === item.id ? null : item.id)} />
      ))}
    </div>
  );
}

export default function Performance() {
  const { ownerCode, isUnlocked, headers } = useOwnerSession();
  const [period, setPeriod] = useState<ShopPeriodId>("30");
  const [openId, setOpenId] = useState<string | null>(null);
  const unlock = useOwnerUnlock({
    successTitle: "Stats unlocked",
    successDescription: "Shop figures for the period you pick.",
  });

  const performance = useQuery<DashboardResponse>({
    queryKey: ["/api/performance", "dashboard", period, ownerCode],
    enabled: isUnlocked,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/performance?dashboard=1&period=${period}`, undefined, { headers });
      return (await response.json()) as DashboardResponse;
    },
    placeholderData: keepPreviousData,
  });

  const dashboard = performance.data?.dashboard;
  const headlineIds = new Set(dashboard?.headlines.map((item) => item.id) ?? []);
  const maxStage = Math.max(1, ...(dashboard?.pipeline.map((stage) => stage.count) ?? [0]));
  const maxPrinter = Math.max(1, ...(dashboard?.printers.map((printer) => printer.hours) ?? [0]));

  return (
    <div className="mx-auto max-w-6xl pb-24 md:pb-6">
      <PageHeader
        title="Stats"
        subtitle="How the shop did in the period you pick. Tap a figure to see how it is counted."
        actions={
          ownerCode ? (
            <Button size="sm" variant="outline" onClick={() => performance.refetch()} disabled={performance.isFetching} data-testid="button-refresh-performance">
              {performance.isFetching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
              Refresh
            </Button>
          ) : null
        }
      />

      <div className="page-stack">
        {!isUnlocked ? (
          <OwnerUnlockPanel
            title="Unlock shop stats"
            description="Enter your owner access code to read orders, plates, labels, and postage already in Print Ops."
            buttonLabel="Unlock stats"
            testIdPrefix="performance"
            pending={unlock.isPending}
            onUnlock={(code) => unlock.mutate(code)}
          />
        ) : performance.isLoading ? (
          <div className="space-y-4" data-testid="skeleton-performance">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-24 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : performance.isError || !dashboard ? (
          <Panel title="Stats are not available right now" testId="panel-performance-error">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm leading-6 text-muted-foreground">The shop figures could not be read. Refresh after checking the HubSpot connection.</p>
                <Button className="mt-4" size="sm" onClick={() => performance.refetch()} data-testid="button-retry-performance">
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Try again
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 pb-1" role="tablist" aria-label="Period" data-testid="stats-period">
              {SHOP_PERIODS.map((id) => (
                <Button key={id} size="sm" className="shrink-0" variant={period === id ? "default" : "outline"} onClick={() => setPeriod(id)} data-testid={`button-period-${id}`}>
                  {PERIOD_LABEL[id]}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="stats-compare">
              {dashboard.period.label}. {dashboard.period.compareLabel}.
            </p>

            <section className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Headline figures" data-testid="stats-headlines">
              {dashboard.headlines.map((item) => {
                const delta = formatDelta(item);
                const up = item.previous != null && item.value != null && item.value >= item.previous;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="metric-tile min-w-0 text-left"
                    title={item.formula}
                    data-testid={`headline-${item.id}`}
                    onClick={() => setOpenId(openId === item.id ? null : item.id)}
                  >
                    <p className="rule-label truncate">{item.label}</p>
                    <p className="numeric mt-1 text-right text-lg font-semibold">{formatValue(item)}</p>
                    <p className={cn("numeric mt-1 text-right text-xs", delta ? (up ? "text-accent" : "text-destructive") : "text-muted-foreground")}>
                      {delta ?? item.note ?? (dashboard.period.id === "all" ? "" : "Right now")}
                    </p>
                    {item.id === "revenue-booked" ? <Spark series={item.series} /> : null}
                    {openId === item.id ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.formula}</p> : null}
                  </button>
                );
              })}
            </section>

            <Panel
              title="Where orders come from"
              description="Ship-to city and state for orders opened in this period. Pickup counts as San Diego. Streets are not shown."
              testId="stats-origin-map"
            >
              <Suspense fallback={<Skeleton className="h-64 rounded-md" />}><OrderOriginMap origins={dashboard.origins} /></Suspense>
            </Panel>

            <section className="grid gap-4 lg:grid-cols-2">
              <Panel title="Money" description={dashboard.period.compareLabel}>
                <MetricList metrics={dashboard.money.filter((item) => !headlineIds.has(item.id))} openId={openId} setOpenId={setOpenId} />
              </Panel>
              <Panel title="Speed and reliability">
                <MetricList metrics={dashboard.speed.filter((item) => !headlineIds.has(item.id))} openId={openId} setOpenId={setOpenId} />
              </Panel>
              <Panel title="Production">
                <MetricList metrics={dashboard.production} openId={openId} setOpenId={setOpenId} />
                <div className="mt-3 space-y-2" data-testid="stats-printers">
                  {dashboard.printers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No plates in this period have a print time and a printer.</p>
                  ) : (
                    dashboard.printers.map((printer) => (
                      <div key={printer.label} className="grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{printer.label}</p>
                          <span className="mt-1 block h-1.5 rounded-full bg-muted">
                            <span className="block h-1.5 rounded-full bg-primary/70" style={{ width: `${Math.max(6, (printer.hours / maxPrinter) * 100)}%` }} />
                          </span>
                        </div>
                        <p className="numeric text-right text-sm">{printer.hours.toFixed(1)} h</p>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-3" data-testid="stats-fep">
                  {dashboard.fep.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No printers are on the fleet list.</p>
                  ) : (
                    dashboard.fep.map((printer) => (
                      <div key={printer.name} className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-baseline gap-3 border-b border-border/70 py-1.5 last:border-b-0">
                        <p className="min-w-0 truncate text-sm">{printer.hours == null ? `${printer.name} · no FEP change logged` : printer.name}</p>
                        <p className="numeric text-right text-sm">{printer.hours == null ? "—" : printer.percent == null ? `${printer.hours.toFixed(0)} h` : `${printer.percent.toFixed(0)}%`}</p>
                      </div>
                    ))
                  )}
                </div>
              </Panel>
              <Panel title="Pipeline">
                <div className="mb-3 space-y-2" data-testid="stats-stages">
                  {dashboard.pipeline.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No open orders.</p>
                  ) : (
                    dashboard.pipeline.map((stage) => (
                      <div key={stage.label} className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{stage.label}</p>
                          <span className="mt-1 block h-1.5 rounded-full bg-muted">
                            <span className="block h-1.5 rounded-full bg-chart-4/80" style={{ width: `${Math.max(6, (stage.count / maxStage) * 100)}%` }} />
                          </span>
                        </div>
                        <p className="numeric text-right text-sm">{stage.count}</p>
                      </div>
                    ))
                  )}
                </div>
                <MetricList metrics={dashboard.pipelineMetrics.filter((item) => !headlineIds.has(item.id))} openId={openId} setOpenId={setOpenId} />
              </Panel>
              <Panel title="Customers" className="lg:col-span-2">
                <MetricList metrics={dashboard.channelMetrics} openId={openId} setOpenId={setOpenId} />
                <div className="mt-2" data-testid="stats-customers">
                  {dashboard.customers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No named customers in this period.</p>
                  ) : (
                    dashboard.customers.map((customer) => (
                      <div key={customer.name} className="grid grid-cols-[minmax(0,1fr)_2.5rem_6.5rem] items-baseline gap-3 border-b border-border/70 py-1.5 last:border-b-0">
                        <p className="truncate text-sm">{customer.name}</p>
                        <p className="numeric text-right text-sm text-muted-foreground">{customer.orders}</p>
                        <p className="numeric text-right text-sm font-semibold">{money(customer.revenue)}</p>
                      </div>
                    ))
                  )}
                </div>
              </Panel>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
