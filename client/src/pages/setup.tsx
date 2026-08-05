import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shell";
import { CodeLine, Panel } from "@/components/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import type { HealthResponse } from "@shared/schema";

const ENV_VARS: { name: string; required: string; note: string }[] = [
  {
    name: "CUSTOM_CRED_API_HUBAPI_COM_URL",
    required: "Primary",
    note: "HubSpot API base, normally https://api.hubapi.com",
  },
  {
    name: "CUSTOM_CRED_API_HUBAPI_COM_TOKEN",
    required: "Primary",
    note: "Private app access token, sent as a Bearer header",
  },
  { name: "HUBSPOT_API_BASE", required: "Fallback", note: "Used when the custom cred URL is absent" },
  {
    name: "HUBSPOT_ACCESS_TOKEN",
    required: "Fallback",
    note: "Used when the custom cred token is absent",
  },
  {
    name: "HUBSPOT_WEBHOOK_SECRET",
    required: "Optional",
    note: "Private app client secret. Signatures are enforced only when set",
  },
  { name: "DRY_RUN", required: "Default true", note: "Set to false as the first write unlock" },
  {
    name: "ALLOW_HUBSPOT_WRITES",
    required: "Default false",
    note: "Set to true as the second write unlock",
  },
  {
    name: "PAID_ORDER_INTAKE_ACCESS_CODE_HASH",
    required: "Required for Daily work",
    note: "SHA-256 hex of the owner access code used by Orders, Prints, Supplies, and Performance",
  },
  {
    name: "ORDER_LINKS_DB_FILE",
    required: "Strongly recommended",
    note: "Absolute SQLite path on a persistent volume (e.g. /data/hubspot.db). Without this, intakes/plates/supplies can vanish on redeploy",
  },
  {
    name: "PUBLIC_BASE_URL",
    required: "Optional",
    note: "Signed URI base for v3 when running behind a proxy",
  },
];

const WEBHOOK_STEPS = [
  "Open HubSpot Settings > Integrations > Private Apps.",
  "Use a standalone legacy private app — webhooks are not available on developer-project apps.",
  "Open the Webhooks tab and set Target URL to the deployed https URL plus /api/webhooks/hubspot.",
  "Create subscriptions: Deal > Property changed, one per source field.",
  "Subscribe amount, print_material_cost, print_labor_cost, print_packaging_cost, print_actual_shipping_cost.",
  "Do not subscribe print_gross_profit or print_margin_percentage — that would loop.",
  "Commit changes, then use Test to send a sample event and check the audit log.",
];

const ENDPOINTS = [
  { method: "GET", path: "/api/health", note: "Safety gates, credential presence, storage durability, signing status" },
  { method: "POST", path: "/api/webhooks/hubspot", note: "HubSpot event receiver, accepts ?dryRun=" },
  { method: "POST", path: "/api/recalculate/:dealId", note: "Manual recalculation, accepts ?dryRun=" },
  { method: "GET", path: "/api/calculations", note: "Last 100 audited attempts" },
  { method: "GET", path: "/api/order-links", note: "Owner intake queue (owner code)" },
  { method: "GET", path: "/api/prints", note: "Print-file candidates and plate history (owner code)" },
  { method: "GET", path: "/api/supplies", note: "Supply ledger (owner code)" },
  { method: "GET", path: "/api/performance", note: "Daily performance snapshot (owner code)" },
];

const DAILY_ROUTES = [
  { path: "/#/", note: "Command center — today’s work strip and daily path" },
  { path: "/#/orders", note: "Paid order intake links and review queue" },
  { path: "/#/prints", note: "Attach Chitubox plates; deep-link with ?dealId=" },
  { path: "/#/supplies", note: "Amazon/receipt supply ledger" },
  { path: "/#/performance", note: "Margins, workload, and attention with next-step links" },
];

export default function Setup() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="System setup"
        subtitle="Connection details, webhook setup, and technical reference for this order system."
      />

      <div className="page-stack">
        {health.data?.storage?.warning ? (
          <Panel
            title="Production data durability"
            description="Intakes, print-plate boards, resin profiles, and supply history share one SQLite file."
          >
            <p className="text-sm text-muted-foreground" data-testid="text-storage-warning">
              {health.data.storage.warning}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              On Railway, mount a volume at <CodeLine>/data</CodeLine> and set{" "}
              <CodeLine>ORDER_LINKS_DB_FILE=/data/hubspot.db</CodeLine>.
            </p>
          </Panel>
        ) : null}

        <Panel
          title="Daily production routes"
          description="Owner tools share one unlock session in this browser tab. Seed print_material_cost only from Print files with an explicit confirm."
        >
          <div className="space-y-2">
            {DAILY_ROUTES.map((route) => (
              <div
                key={route.path}
                className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-2 text-xs last:border-0 last:pb-0"
                data-testid={`row-daily-route-${route.path}`}
              >
                <CodeLine>{route.path}</CodeLine>
                <span className="text-muted-foreground">{route.note}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Environment variables"
          description="Credentials are read from the environment only — never stored in code or shown here."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="rule-label pb-1.5 font-normal">Variable</th>
                  <th className="rule-label pb-1.5 font-normal">Status</th>
                  <th className="rule-label pb-1.5 font-normal">Purpose</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {ENV_VARS.map((v) => (
                  <tr key={v.name} data-testid={`row-env-${v.name}`}>
                    <td className="numeric py-2 pr-3">{v.name}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{v.required}</td>
                    <td className="py-2 text-muted-foreground">{v.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Private app webhook subscriptions"
          description="Webhook configuration lives in HubSpot settings, not in the API."
        >
          <ol className="space-y-2">
            {WEBHOOK_STEPS.map((step, i) => (
              <li key={step} className="flex gap-2.5 text-sm" data-testid={`item-webhook-step-${i}`}>
                <span className="numeric mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-[0.6875rem] text-muted-foreground">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted-foreground">
            Target path:{" "}
            <CodeLine testId="text-webhook-path">
              {health.data?.webhook.path ?? "/api/webhooks/hubspot"}
            </CodeLine>{" "}
            · Real webhooks need a live deployment. A preview URL is a test and control surface only.
          </p>
          <p className="mt-2 text-xs">
            <a
              href="https://developers.hubspot.com/docs/guides/api/app-management/webhooks"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              data-testid="link-hubspot-webhooks-docs"
            >
              HubSpot webhooks documentation
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </Panel>

        <Panel title="Signature handling" description="Enforced only when a secret is configured.">
          {health.isLoading ? (
            <Skeleton className="h-24 w-full rounded" />
          ) : (
            <div className="space-y-3 text-sm">
              <p data-testid="text-signature-status">
                Current state:{" "}
                <span className={health.data?.webhook.verification === "configured" ? "text-chart-4" : "text-destructive"}>
                  {health.data?.webhook.verification === "configured"
                    ? "signature verification configured"
                    : "signature verification not configured"}
                </span>
              </p>
              <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
                <p className="rule-label">v1 — X-HubSpot-Signature</p>
                <p className="numeric mt-1">sha256(client_secret + raw_body) → hex</p>
                <p className="rule-label mt-3">v3 — X-HubSpot-Signature-V3</p>
                <p className="numeric mt-1">
                  base64(hmac_sha256(client_secret, method + decoded_uri + raw_body + timestamp))
                </p>
                <p className="mt-1 text-muted-foreground">
                  X-HubSpot-Request-Timestamp must be within 5 minutes.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                The raw request body is captured before JSON parsing, so both versions verify against
                the exact bytes HubSpot signed. Behind a proxy, set PUBLIC_BASE_URL so the v3 signed
                URI matches the public URL.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Endpoints" description="Webhook and owner Daily work routes.">
          <div className="space-y-2">
            {ENDPOINTS.map((e) => (
              <div
                key={e.path}
                className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-2 text-xs last:border-0 last:pb-0"
                data-testid={`row-endpoint-${e.path}`}
              >
                <span className="numeric w-12 shrink-0 text-primary">{e.method}</span>
                <CodeLine>{e.path}</CodeLine>
                <span className="text-muted-foreground">{e.note}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Local run: <CodeLine>npm run dev</CodeLine> · tests: <CodeLine>npm test</CodeLine> ·
            build: <CodeLine>npm run build</CodeLine>
          </p>
        </Panel>
      </div>
    </div>
  );
}
