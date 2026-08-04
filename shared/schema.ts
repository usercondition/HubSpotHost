/**
 * Shared contracts between the Express API and the React dashboard.
 * The audit log is a small local file kept server-side.
 */

export const INPUT_PROPERTY_LABELS: Record<string, string> = {
  amount: "Amount",
  print_material_cost: "Actual material cost",
  print_labor_cost: "Labor cost",
  print_packaging_cost: "Packaging cost",
  print_actual_shipping_cost: "Actual shipping cost",
};

export const OUTPUT_PROPERTY_LABELS: Record<string, string> = {
  print_gross_profit: "Gross Profit",
  print_margin_percentage: "Margin Percentage",
};

export type TriggerOrigin = "webhook" | "manual";
export type AttemptStatus = "written" | "dry-run" | "error";

export interface AuditEntry {
  id: number;
  timestamp: string;
  dealId: string;
  origin: TriggerOrigin;
  status: AttemptStatus;
  dryRun: boolean;
  gate: string;
  inputs: {
    amount: number;
    material: number;
    labor: number;
    packaging: number;
    shipping: number;
    costTotal: number;
  } | null;
  outputs: {
    print_gross_profit: number;
    print_margin_percentage: number;
  } | null;
  error?: string;
}

export interface HealthResponse {
  status: "ok";
  mode: "dry-run" | "live-write";
  readiness: string;
  safety: {
    dryRun: boolean;
    allowHubspotWrites: boolean;
    liveWriteReady: boolean;
    blockedBy: string | null;
  };
  credentials: {
    apiBaseConfigured: boolean;
    apiBaseSource: "environment" | "default";
    tokenConfigured: boolean;
    tokenSource: "custom_cred" | "hubspot_access_token" | null;
  };
  webhook: {
    verification: "configured" | "not-configured";
    supportedVersions: string[];
    path: string;
  };
  admin: {
    /** Public deployments expose only the webhook and safe readiness status. */
    publicControlsEnabled: boolean;
  };
  properties: {
    inputs: string[];
    outputs: string[];
  };
  audit: {
    retained: number;
    limit: number;
  };
  serverTime: string;
}

export interface RecalcOutcome {
  dealId: string;
  status: AttemptStatus;
  dryRun: boolean;
  gate: string;
  grossProfit?: number;
  marginPercentage?: number;
  costTotal?: number;
  error?: string;
}

export interface CalculationsResponse {
  count: number;
  limit: number;
  entries: AuditEntry[];
}

export interface WebhookSummary {
  ok: boolean;
  received: number;
  matched: number;
  ignoredOutputEvents: number;
  ignoredOther: number;
  deals: number;
  written: number;
  dryRun: number;
  errors: number;
  results: RecalcOutcome[];
}
