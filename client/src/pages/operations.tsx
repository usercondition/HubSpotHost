import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Zap,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { PageHeader, ThemeToggle } from "@/components/shell";
import { Panel, StatCard, StatusPill } from "@/components/primitives";
import {
  INPUT_PROPERTY_LABELS,
  OUTPUT_PROPERTY_LABELS,
  type CalculationsResponse,
  type HealthResponse,
  type RecalcOutcome,
} from "@shared/schema";

const CHECKLIST = [
  "Deploy this service to a public HTTPS URL.",
  "Inject CUSTOM_CRED_API_HUBAPI_COM_URL and CUSTOM_CRED_API_HUBAPI_COM_TOKEN.",
  "Set HUBSPOT_WEBHOOK_SECRET to the private app client secret.",
  "Subscribe Deal property changed events for the five source fields.",
  "Run a dry-run recalculation on one test deal and read the audit row.",
  "Set DRY_RUN=false and ALLOW_HUBSPOT_WRITES=true to start writing.",
];

function money(value: number | undefined) {
  if (value === undefined || value === null) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Operations() {
  const { toast } = useToast();
  const [liveWrite, setLiveWrite] = useState(false);
  const [lastResult, setLastResult] = useState<RecalcOutcome | null>(null);

  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const calculations = useQuery<CalculationsResponse>({ queryKey: ["/api/calculations"] });

  const form = useForm<{ dealId: string }>({ defaultValues: { dealId: "" } });

  const recalc = useMutation({
    mutationFn: async (dealId: string) => {
      const res = await apiRequest(
        "POST",
        `/api/recalculate/${dealId}?dryRun=${liveWrite ? "false" : "true"}`,
      );
      return (await res.json()) as RecalcOutcome;
    },
    onSuccess: (data) => {
      setLastResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/calculations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/health"] });
      toast({
        title: data.status === "written" ? "Deal updated" : "Dry run complete",
        description: `Gross profit ${money(data.grossProfit)} · margin ${money(data.marginPercentage)}%`,
      });
    },
    onError: (error: Error) => {
      setLastResult(null);
      toast({
        title: "Recalculation failed",
        description: error.message.slice(0, 160),
        variant: "destructive",
      });
    },
  });

  const live = health.data?.safety.liveWriteReady === true;
  const signing = health.data?.webhook.verification === "configured";
  const tokenReady = health.data?.credentials.tokenConfigured === true;
  const entries = calculations.data?.entries ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Print Orders margin operations"
        subtitle="Recalculate deal profitability, review attempts, confirm write readiness."
        actions={
          <>
            <StatusPill
              tone={live ? "warn" : "neutral"}
              icon={live ? Zap : CircleDashed}
              label={live ? "Live writes armed" : "Dry run"}
              testId="status-mode"
            />
            <Button
              variant="outline"
              size="sm"
              data-testid="button-refresh"
              onClick={() => {
                health.refetch();
                calculations.refetch();
              }}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh
            </Button>
            <ThemeToggle />
          </>
        }
      />

      <div className="space-y-5 px-4 py-5 md:px-6">
        {/* KPI row */}
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {health.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[5.5rem] w-full rounded-lg" />
            ))
          ) : (
            <>
              <StatCard
                label="Write mode"
                value={live ? "Live write" : "Dry run"}
                hint={health.data?.readiness ?? "Health unavailable"}
                icon={live ? Zap : CircleDashed}
                tone={live ? "warn" : "neutral"}
                testId="card-write-mode"
              />
              <StatCard
                label="Webhook signing"
                value={signing ? "Configured" : "Not configured"}
                hint={
                  signing
                    ? "v1 and v3 signatures enforced"
                    : "No secret set — signatures are not enforced"
                }
                icon={signing ? ShieldCheck : ShieldOff}
                tone={signing ? "good" : "bad"}
                testId="card-webhook-signing"
              />
              <StatCard
                label="Credentials"
                value={tokenReady ? "Token injected" : "Missing token"}
                hint={
                  tokenReady
                    ? `Source: ${health.data?.credentials.tokenSource}`
                    : "Inject CUSTOM_CRED_API_HUBAPI_COM_TOKEN"
                }
                icon={KeyRound}
                tone={tokenReady ? "good" : "bad"}
                testId="card-credentials"
              />
              <StatCard
                label="Attempts retained"
                value={`${health.data?.audit.retained ?? 0} / ${health.data?.audit.limit ?? 100}`}
                hint="Rolling local audit file, 100 most recent attempts"
                icon={CheckCircle2}
                tone="neutral"
                testId="card-audit-count"
              />
            </>
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          {/* Manual recalculation */}
          <Panel
            title="Manual recalculation"
            description="Runs the same path as a webhook event, for one deal."
          >
            <form
              className="space-y-4"
              onSubmit={form.handleSubmit(({ dealId }) => recalc.mutate(dealId.trim()))}
            >
              <div className="space-y-1.5">
                <Label htmlFor="dealId">HubSpot deal record ID</Label>
                <Input
                  id="dealId"
                  inputMode="numeric"
                  placeholder="34567890123"
                  autoComplete="off"
                  data-testid="input-deal-id"
                  className="numeric"
                  {...form.register("dealId", {
                    required: "Deal ID is required",
                    pattern: { value: /^[0-9]{1,20}$/, message: "Digits only" },
                  })}
                />
                {form.formState.errors.dealId && (
                  <p className="text-xs text-destructive" data-testid="text-deal-id-error">
                    {form.formState.errors.dealId.message}
                  </p>
                )}
              </div>

              <div
                className={`flex items-start justify-between gap-4 rounded-md border p-3 ${
                  liveWrite ? "border-primary/60 bg-primary/5" : "border-border bg-muted/40"
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {liveWrite ? "Request live write" : "Dry run (no HubSpot write)"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {liveWrite
                      ? live
                        ? "Server gates open. This will PATCH the deal."
                        : "Server still blocks writes: DRY_RUN or ALLOW_HUBSPOT_WRITES."
                      : "Calculates and logs the result without touching HubSpot."}
                  </p>
                </div>
                <Switch
                  checked={liveWrite}
                  onCheckedChange={setLiveWrite}
                  aria-label="Request a live write"
                  data-testid="switch-live-write"
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={recalc.isPending}
                data-testid="button-recalculate"
              >
                {recalc.isPending ? "Calculating…" : "Recalculate deal"}
              </Button>
            </form>

            {lastResult && (
              <div
                className="mt-4 rounded-md border border-border bg-muted/30 p-3"
                data-testid="panel-last-result"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="rule-label">Deal {lastResult.dealId}</p>
                  <StatusPill
                    tone={lastResult.status === "written" ? "warn" : "neutral"}
                    icon={lastResult.status === "written" ? Zap : CircleDashed}
                    label={lastResult.status}
                    testId="status-last-result"
                  />
                </div>
                <dl className="mt-2 grid grid-cols-3 gap-3">
                  <div>
                    <dt className="rule-label">Cost total</dt>
                    <dd className="numeric text-sm" data-testid="text-result-cost-total">
                      {money(lastResult.costTotal)}
                    </dd>
                  </div>
                  <div>
                    <dt className="rule-label">Gross profit</dt>
                    <dd className="numeric text-sm" data-testid="text-result-gross-profit">
                      {money(lastResult.grossProfit)}
                    </dd>
                  </div>
                  <div>
                    <dt className="rule-label">Margin</dt>
                    <dd className="numeric text-sm" data-testid="text-result-margin">
                      {money(lastResult.marginPercentage)}%
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">Gate: {lastResult.gate}</p>
              </div>
            )}
          </Panel>

          {/* Formula + mapping */}
          <Panel
            title="Formula and field mapping"
            description="Inputs read from the deal, outputs written back."
          >
            <div className="rounded-md border border-border bg-muted/30 p-3 numeric text-xs leading-relaxed">
              <p data-testid="text-formula-profit">
                print_gross_profit = amount − material − labor − packaging − shipping
              </p>
              <p className="mt-1.5" data-testid="text-formula-margin">
                print_margin_percentage = amount &gt; 0 ? (gross_profit / amount) * 100 : 0
              </p>
              <p className="mt-1.5 font-sans text-muted-foreground">
                Blank inputs count as zero. Both outputs round to 2 decimals.
              </p>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="rule-label pb-1.5 font-normal">Role</th>
                    <th className="rule-label pb-1.5 font-normal">HubSpot label</th>
                    <th className="rule-label pb-1.5 font-normal">Internal name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {Object.entries(INPUT_PROPERTY_LABELS).map(([name, label]) => (
                    <tr key={name} data-testid={`row-input-${name}`}>
                      <td className="py-1.5 text-muted-foreground">Input</td>
                      <td className="py-1.5">{label}</td>
                      <td className="numeric py-1.5">{name}</td>
                    </tr>
                  ))}
                  {Object.entries(OUTPUT_PROPERTY_LABELS).map(([name, label]) => (
                    <tr key={name} data-testid={`row-output-${name}`}>
                      <td className="py-1.5 text-primary">Output</td>
                      <td className="py-1.5">{label}</td>
                      <td className="numeric py-1.5">{name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              Output property events are ignored, so a write never triggers another write.
            </p>
          </Panel>
        </div>

        {/* Audit log */}
        <Panel
          title="Recent attempts"
          description={`Newest first · last ${calculations.data?.limit ?? 100} retained`}
        >
          {calculations.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div
              className="rounded-md border border-dashed border-border px-4 py-8 text-center"
              data-testid="empty-audit-log"
            >
              <p className="text-sm font-medium">No attempts yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Run a manual recalculation or send a test webhook from HubSpot.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-left text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border">
                    {["Time", "Deal", "Origin", "Amount", "Costs", "Profit", "Margin", "Result"].map(
                      (h) => (
                        <th key={h} className="rule-label pb-1.5 font-normal">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {entries.map((entry) => (
                    <tr key={entry.id} data-testid={`row-audit-${entry.id}`}>
                      <td className="numeric py-2 text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="numeric py-2" data-testid={`text-audit-deal-${entry.id}`}>
                        {entry.dealId}
                      </td>
                      <td className="py-2 text-muted-foreground">{entry.origin}</td>
                      <td className="numeric py-2">{money(entry.inputs?.amount)}</td>
                      <td className="numeric py-2">{money(entry.inputs?.costTotal)}</td>
                      <td className="numeric py-2">{money(entry.outputs?.print_gross_profit)}</td>
                      <td className="numeric py-2">
                        {entry.outputs ? `${money(entry.outputs.print_margin_percentage)}%` : "—"}
                      </td>
                      <td className="py-2">
                        <StatusPill
                          tone={
                            entry.status === "error"
                              ? "bad"
                              : entry.status === "written"
                                ? "warn"
                                : "neutral"
                          }
                          icon={
                            entry.status === "error"
                              ? AlertTriangle
                              : entry.status === "written"
                                ? Zap
                                : CircleDashed
                          }
                          label={entry.status}
                          testId={`status-audit-${entry.id}`}
                        />
                        {entry.error && (
                          <p className="mt-1 max-w-[16rem] text-[0.6875rem] text-destructive">
                            {entry.error}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Activation checklist */}
        <Panel
          title="Activation checklist"
          description="Everything required before HubSpot deals change."
        >
          <ol className="space-y-2">
            {CHECKLIST.map((item, index) => (
              <li key={item} className="flex gap-2.5 text-sm" data-testid={`item-checklist-${index}`}>
                <span className="numeric mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-[0.6875rem] text-muted-foreground">
                  {index + 1}
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            This console holds no token and no customer data. Access control comes from the
            deployment's privacy setting.
          </p>
        </Panel>
      </div>
    </div>
  );
}
