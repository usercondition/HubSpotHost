import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { CodeLine } from "@/components/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
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
  {
    name: "TELEGRAM_BOT_TOKEN",
    required: "Optional",
    note: "BotFather token for morning digests and health nudges",
  },
  {
    name: "TELEGRAM_CHAT_ID",
    required: "Optional",
    note: "Numeric Telegram chat id that receives digests and nudges",
  },
  {
    name: "OWNER_DIGEST_SCHEDULE_ENABLED",
    required: "Optional",
    note: "true to send the morning briefing once per day",
  },
  {
    name: "OWNER_HEALTH_NUDGE_SCHEDULE_ENABLED",
    required: "Optional",
    note: "true to ping missing plates/costs/stale/intake on a schedule",
  },
  {
    name: "OWNER_HEALTH_NUDGE_HOURS",
    required: "Optional",
    note: "Comma-separated local hours (default 12). Example: 9,12,17",
  },
  {
    name: "OWNER_DIGEST_CRON_SECRET",
    required: "Optional",
    note: "Shared secret for POST /api/cron/owner-digest and /api/cron/health-nudge",
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
  { method: "GET", path: "/api/production-queue", note: "Next print / ship-ready buckets (owner code)" },
  { method: "GET", path: "/api/deal-ops/:dealId", note: "Costs, stage, packing slip, failures (owner code)" },
  { method: "GET", path: "/api/prints", note: "Print-file candidates and plate history (owner code)" },
  { method: "GET", path: "/api/supplies", note: "Supply ledger (owner code)" },
  { method: "GET", path: "/api/performance", note: "Daily performance snapshot (owner code)" },
  { method: "POST", path: "/api/buyers/lookup", note: "Returning-buyer prefill from HubSpot + intake" },
  { method: "GET", path: "/api/contacts", note: "Browse HubSpot contacts (query + recent)" },
  { method: "GET", path: "/api/contacts/:id", note: "Single HubSpot contact card" },
  { method: "GET", path: "/api/resin-reorder", note: "Resin burn-rate buy cues (owner code)" },
];

const DAILY_ROUTES = [
  { path: "/#/", note: "Floor workspace — icon rail is Run → Take → Keep → Office" },
  { path: "/#/queue", note: "Production queue — next print, ops panel, ship checklist" },
  { path: "/#/orders", note: "Paid order intake links and review queue" },
  { path: "/#/prints", note: "Attach Chitubox plates; deep-link with ?dealId=" },
  { path: "/#/supplies", note: "Amazon/receipt supply ledger" },
  { path: "/#/performance", note: "Margins, workload, and attention with next-step links" },
];

type SetupSection =
  | "overview"
  | "telegram"
  | "routes"
  | "environment"
  | "webhooks"
  | "signatures"
  | "endpoints";

const SETUP_NAV: Array<{ id: SetupSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "telegram", label: "Telegram" },
  { id: "routes", label: "Daily routes" },
  { id: "environment", label: "Environment" },
  { id: "webhooks", label: "Webhooks" },
  { id: "signatures", label: "Signatures" },
  { id: "endpoints", label: "Endpoints" },
];

function SettingsCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="settings-card" data-testid={testId}>
      <h2 className="settings-card-title">{title}</h2>
      {children}
    </section>
  );
}

export default function Setup() {
  const health = useQuery<HealthResponse>({ queryKey: ["/api/health"] });
  const [section, setSection] = useState<SetupSection>("overview");

  const title = useMemo(
    () => SETUP_NAV.find((item) => item.id === section)?.label ?? "Setup",
    [section],
  );

  return (
    <div className="settings-shell" data-testid="page-setup-settings">
      <aside className="settings-nav" aria-label="Setup sections">
        <p className="settings-nav-title">Settings</p>
        <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {SETUP_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="settings-nav-link shrink-0"
              data-active={section === item.id}
              data-testid={`button-setup-nav-${item.id}`}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="settings-main">
        <h1 className="settings-title" data-testid="text-page-title">
          {title}
        </h1>

        {section === "overview" ? (
          <div className="space-y-4">
            {health.data?.storage?.warning ? (
              <SettingsCard title="Production data durability" testId="panel-setup-storage">
                <p className="text-sm text-muted-foreground" data-testid="text-storage-warning">
                  {health.data.storage.warning}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  On Railway, mount a volume at <CodeLine>/data</CodeLine> and set{" "}
                  <CodeLine>ORDER_LINKS_DB_FILE=/data/hubspot.db</CodeLine>.
                </p>
              </SettingsCard>
            ) : (
              <SettingsCard title="System reference" testId="panel-setup-overview">
                <p className="text-sm text-muted-foreground">
                  Connection details, webhook setup, and technical reference for this order system.
                  Credentials stay in the environment — never in the UI.
                </p>
              </SettingsCard>
            )}
          </div>
        ) : null}

        {section === "telegram" ? (
          <SettingsCard title="Telegram nudges" testId="panel-telegram-nudges">
            <div className="space-y-3 text-sm">
              <p>
                Telegram:{" "}
                <span
                  className={
                    health.data?.healthNudge?.telegramConfigured ? "text-chart-4" : "text-destructive"
                  }
                >
                  {health.data?.healthNudge?.telegramConfigured ||
                  health.data?.ownerDigest?.telegramConfigured
                    ? "configured"
                    : "not configured"}
                </span>
              </p>
              <p className="text-muted-foreground">
                Morning digest schedule:{" "}
                {health.data?.ownerDigest?.schedule?.enabled
                  ? `on · ${health.data.ownerDigest.schedule.hour}:00 ${health.data.ownerDigest.schedule.timeZone}`
                  : "off"}
              </p>
              <p className="text-muted-foreground">
                Health nudge schedule:{" "}
                {health.data?.healthNudge?.schedule?.enabled
                  ? `on · ${health.data.healthNudge.schedule.hours.join(":00, ")}:00 ${health.data.healthNudge.schedule.timeZone}`
                  : "off"}
              </p>
              <p className="text-xs text-muted-foreground">
                Manual send from Floor → Ask the tracker. Cron:{" "}
                <CodeLine>POST /api/cron/health-nudge</CodeLine>
              </p>
            </div>
          </SettingsCard>
        ) : null}

        {section === "routes" ? (
          <SettingsCard
            title="Daily production routes"
            testId="panel-setup-routes"
          >
            <p className="mb-4 text-xs text-muted-foreground">
              Owner tools share one unlock session in this browser tab.
            </p>
            <div className="space-y-3">
              {DAILY_ROUTES.map((route) => (
                <div
                  key={route.path}
                  className="flex flex-col gap-1 border-b border-border/70 pb-3 text-xs last:border-0 last:pb-0"
                  data-testid={`row-daily-route-${route.path}`}
                >
                  <CodeLine>{route.path}</CodeLine>
                  <span className="text-muted-foreground">{route.note}</span>
                </div>
              ))}
            </div>
          </SettingsCard>
        ) : null}

        {section === "environment" ? (
          <SettingsCard title="Environment variables" testId="panel-setup-env">
            <p className="mb-4 text-xs text-muted-foreground">
              Credentials are read from the environment only — never stored in code or shown here.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="rule-label pb-2 font-normal">Variable</th>
                    <th className="rule-label pb-2 font-normal">Status</th>
                    <th className="rule-label pb-2 font-normal">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {ENV_VARS.map((v) => (
                    <tr key={v.name} data-testid={`row-env-${v.name}`}>
                      <td className="numeric py-2.5 pr-3 align-top">{v.name}</td>
                      <td className="py-2.5 pr-3 align-top text-muted-foreground">{v.required}</td>
                      <td className="py-2.5 align-top text-muted-foreground">{v.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsCard>
        ) : null}

        {section === "webhooks" ? (
          <SettingsCard title="Private app webhook subscriptions" testId="panel-setup-webhooks">
            <ol className="space-y-2.5">
              {WEBHOOK_STEPS.map((step, i) => (
                <li key={step} className="flex gap-2.5 text-sm" data-testid={`item-webhook-step-${i}`}>
                  <span className="numeric mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border text-[0.6875rem] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted-foreground">
              Target path:{" "}
              <CodeLine testId="text-webhook-path">
                {health.data?.webhook.path ?? "/api/webhooks/hubspot"}
              </CodeLine>
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
          </SettingsCard>
        ) : null}

        {section === "signatures" ? (
          <SettingsCard title="Signature handling" testId="panel-setup-signatures">
            {health.isLoading ? (
              <Skeleton className="h-24 w-full rounded-xl" />
            ) : (
              <div className="space-y-3 text-sm">
                <p data-testid="text-signature-status">
                  Current state:{" "}
                  <span
                    className={
                      health.data?.webhook.verification === "configured"
                        ? "text-chart-4"
                        : "text-destructive"
                    }
                  >
                    {health.data?.webhook.verification === "configured"
                      ? "signature verification configured"
                      : "signature verification not configured"}
                  </span>
                </p>
                <div className="rounded-xl border border-border bg-muted/30 p-3.5 text-xs">
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
                  The raw request body is captured before JSON parsing. Behind a proxy, set
                  PUBLIC_BASE_URL so the v3 signed URI matches the public URL.
                </p>
              </div>
            )}
          </SettingsCard>
        ) : null}

        {section === "endpoints" ? (
          <SettingsCard title="Endpoints" testId="panel-setup-endpoints">
            <div className="space-y-3">
              {ENDPOINTS.map((e) => (
                <div
                  key={e.path}
                  className={cn(
                    "flex flex-col gap-1 border-b border-border/70 pb-3 text-xs last:border-0 last:pb-0",
                  )}
                  data-testid={`row-endpoint-${e.path}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="numeric w-12 shrink-0 text-primary">{e.method}</span>
                    <CodeLine>{e.path}</CodeLine>
                  </div>
                  <span className="text-muted-foreground">{e.note}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Local run: <CodeLine>npm run dev</CodeLine> · tests: <CodeLine>npm test</CodeLine> ·
              build: <CodeLine>npm run build</CodeLine>
            </p>
          </SettingsCard>
        ) : null}
      </div>
    </div>
  );
}
