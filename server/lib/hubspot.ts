/**
 * Minimal direct HTTPS client for the HubSpot CRM API.
 *
 * Uses global fetch with a Bearer token taken from injected environment
 * variables. No connector bridge, no SDK, and the token is never logged.
 */
import { INPUT_PROPERTIES, OUTPUT_PROPERTIES, getConfig, getToken } from "./config";

const REQUEST_TIMEOUT_MS = 15_000;
const PERFORMANCE_DEAL_LIMIT = 1_000;

export const PRINT_ORDERS_PIPELINE = "default";

export const PERFORMANCE_PROPERTIES = [
  "dealname",
  "amount",
  "pipeline",
  "dealstage",
  "createdate",
  "hs_lastmodifieddate",
  "closedate",
  ...INPUT_PROPERTIES,
  ...OUTPUT_PROPERTIES,
] as const;

export class HubSpotError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HubSpotError";
    this.status = status;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function request(
  path: string,
  init: { method: string; body?: string },
): Promise<any> {
  const config = getConfig();
  const token = getToken();
  if (!token) {
    throw new HubSpotError("HubSpot token not configured", 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.apiBase}${path}`, {
      method: init.method,
      headers: authHeaders(token),
      body: init.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Surface status + HubSpot's short message only.
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        detail = typeof parsed?.message === "string" ? parsed.message : "";
      } catch {
        detail = "";
      }
      throw new HubSpotError(
        `HubSpot API ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err instanceof HubSpotError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new HubSpotError("HubSpot API request timed out", 504);
    }
    throw new HubSpotError("HubSpot API request failed", 502);
  } finally {
    clearTimeout(timer);
  }
}

export interface DealProperties {
  [key: string]: unknown;
}

export interface HubSpotDealRecord {
  id: string;
  properties: Record<string, string | null>;
}

export interface HubSpotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata: Record<string, unknown>;
}

export async function fetchDealInputs(dealId: string): Promise<DealProperties> {
  const query = new URLSearchParams({ properties: INPUT_PROPERTIES.join(",") });
  const data = await request(
    `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?${query.toString()}`,
    { method: "GET" },
  );
  return (data?.properties ?? {}) as DealProperties;
}

export async function patchDealOutputs(
  dealId: string,
  properties: Record<string, string>,
): Promise<void> {
  await request(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/**
 * Read the Print Orders pipeline in pages of 100. This is intentionally
 * read-only and capped to keep one dashboard refresh bounded.
 */
export async function fetchPrintOrderDeals(): Promise<HubSpotDealRecord[]> {
  const deals: HubSpotDealRecord[] = [];
  let after: string | undefined;

  do {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [{ propertyName: "pipeline", operator: "EQ", value: PRINT_ORDERS_PIPELINE }],
        },
      ],
      properties: [...PERFORMANCE_PROPERTIES],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: Math.min(100, PERFORMANCE_DEAL_LIMIT - deals.length),
    };
    if (after) body.after = after;

    const data = await request("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const result of results) {
      if (!result || typeof result.id !== "string") continue;
      const properties =
        result.properties && typeof result.properties === "object"
          ? (result.properties as Record<string, string | null>)
          : {};
      deals.push({ id: result.id, properties });
      if (deals.length >= PERFORMANCE_DEAL_LIMIT) break;
    }

    const next = data?.paging?.next?.after;
    after = typeof next === "string" && next.length > 0 ? next : undefined;
  } while (after && deals.length < PERFORMANCE_DEAL_LIMIT);

  return deals;
}

/** Read the stage labels and closure metadata used to make the workload readable. */
export async function fetchPrintOrderPipelineStages(): Promise<HubSpotPipelineStage[]> {
  const data = await request(`/crm/v3/pipelines/deals/${encodeURIComponent(PRINT_ORDERS_PIPELINE)}`, {
    method: "GET",
  });
  const stages: unknown[] = Array.isArray(data?.stages) ? data.stages : [];
  return stages
    .filter((stage): stage is Record<string, unknown> => Boolean(stage && typeof stage === "object"))
    .map((stage) => ({
      id: typeof stage.id === "string" ? stage.id : "",
      label: typeof stage.label === "string" ? stage.label : "Unnamed stage",
      displayOrder: Number.isFinite(Number(stage.displayOrder)) ? Number(stage.displayOrder) : 0,
      metadata:
        stage.metadata && typeof stage.metadata === "object"
          ? (stage.metadata as Record<string, unknown>)
          : {},
    }))
    .filter((stage) => stage.id.length > 0)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));
}
