/**
 * Runtime configuration. Credentials are read ONLY from injected environment
 * variables. Nothing here is ever logged or returned to the client verbatim.
 */

export const INPUT_PROPERTIES = [
  "amount",
  "print_material_cost",
  "print_labor_cost",
  "print_packaging_cost",
  "print_actual_shipping_cost",
] as const;

export const OUTPUT_PROPERTIES = [
  "print_gross_profit",
  "print_margin_percentage",
] as const;

export type InputProperty = (typeof INPUT_PROPERTIES)[number];
export type OutputProperty = (typeof OUTPUT_PROPERTIES)[number];

const DEFAULT_BASE = "https://api.hubapi.com";

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  return fallback;
}

function normalizeBase(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return DEFAULT_BASE;
  return value.replace(/\/+$/, "");
}

export interface RuntimeConfig {
  /** HubSpot API base URL, no trailing slash. */
  apiBase: string;
  /** Whether an access token was injected. The token itself is never exposed. */
  hasToken: boolean;
  /** Whether a base URL was explicitly injected (vs. falling back to default). */
  baseFromEnv: boolean;
  /** Which env var supplied the token, for diagnostics only. */
  tokenSource: "custom_cred" | "hubspot_access_token" | null;
  /** Safety: dry run defaults to true. */
  dryRun: boolean;
  /** Safety: explicit opt-in required for any HubSpot PATCH. */
  allowWrites: boolean;
  /** Webhook signing secret configured? */
  webhookSecretConfigured: boolean;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const customBase = env.CUSTOM_CRED_API_HUBAPI_COM_URL;
  const customToken = env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN;
  const fallbackBase = env.HUBSPOT_API_BASE;
  const fallbackToken = env.HUBSPOT_ACCESS_TOKEN;

  const rawBase = customBase?.trim() || fallbackBase?.trim() || "";
  const token = customToken?.trim() || fallbackToken?.trim() || "";

  return {
    apiBase: normalizeBase(rawBase),
    hasToken: token.length > 0,
    baseFromEnv: rawBase.length > 0,
    tokenSource: customToken?.trim()
      ? "custom_cred"
      : fallbackToken?.trim()
        ? "hubspot_access_token"
        : null,
    dryRun: envFlag(env.DRY_RUN, true),
    allowWrites: envFlag(env.ALLOW_HUBSPOT_WRITES, false),
    webhookSecretConfigured: (env.HUBSPOT_WEBHOOK_SECRET || "").trim().length > 0,
  };
}

/** Returns the token. Callers must never log or serialize the result. */
export function getToken(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN?.trim() ||
    env.HUBSPOT_ACCESS_TOKEN?.trim() ||
    ""
  );
}

export function getWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HUBSPOT_WEBHOOK_SECRET || "").trim();
}

/**
 * The single safety gate. A HubSpot PATCH runs only when the caller asked for a
 * live write AND DRY_RUN=false AND ALLOW_HUBSPOT_WRITES=true AND a token exists.
 */
export function resolveWriteDecision(
  config: Pick<RuntimeConfig, "dryRun" | "allowWrites" | "hasToken">,
  requestWantsLiveWrite: boolean,
): { write: boolean; reason: string } {
  if (!requestWantsLiveWrite) {
    return { write: false, reason: "request requested dry run" };
  }
  if (config.dryRun) {
    return { write: false, reason: "DRY_RUN is enabled" };
  }
  if (!config.allowWrites) {
    return { write: false, reason: "ALLOW_HUBSPOT_WRITES is not true" };
  }
  if (!config.hasToken) {
    return { write: false, reason: "no HubSpot token configured" };
  }
  return { write: true, reason: "live write permitted" };
}

export function liveWriteReady(config: RuntimeConfig): boolean {
  return resolveWriteDecision(config, true).write;
}
