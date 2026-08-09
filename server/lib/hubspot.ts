/**
 * Minimal direct HTTPS client for the HubSpot CRM API.
 *
 * Uses global fetch with a Bearer token taken from injected environment
 * variables. No connector bridge, no SDK, and the token is never logged.
 */
import { INPUT_PROPERTIES, OUTPUT_PROPERTIES, getConfig, getToken } from "./config";
import type { PrintFileOrderSummary } from "../../shared/schema";

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
  "hs_is_closed",
  "hs_is_closed_won",
  ...INPUT_PROPERTIES,
  ...OUTPUT_PROPERTIES,
] as const;

/**
 * Production-planning fields populated from an attached slice plate (.ctb / .ultx).
 * They intentionally describe the full plate and remain separate from actual
 * costs, which the owner records when the order's real production costs are known.
 */
const PRINT_FILE_DEAL_PROPERTIES = [
  {
    name: "print_slice_file_name",
    label: "Print slice file name",
    description: "Most recently attached slice plate filename (.ctb / .ultx) from Print Operations.",
    type: "string",
    fieldType: "text",
  },
  {
    name: "print_slice_format",
    label: "Print slice format",
    description: "Slice format revision and details (Chitubox CTB or HeyGears ULTX).",
    type: "string",
    fieldType: "text",
  },
  {
    name: "print_estimated_time_hours",
    label: "Estimated print time (hours)",
    description: "Total estimated print time across all attached slice plates.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_resin_volume_ml",
    label: "Estimated resin volume (ml)",
    description: "Total estimated resin volume across all attached slice plates.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_resin_mass_g",
    label: "Estimated resin mass (g)",
    description: "Total estimated resin mass across all attached slice plates.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_estimated_resin_cost",
    label: "Estimated resin cost (slicer)",
    description:
      "Total slicer resin cost estimate across attached plates. Separate from actual print_material_cost.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_layer_count",
    label: "Print layer count",
    description: "Total layers across all attached slice plates.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_bottom_layer_count",
    label: "Print bottom layer count",
    description: "Bottom layer count from the most recently attached slice plate.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_exposure_seconds",
    label: "Normal exposure (s)",
    description: "Normal-layer exposure time from the most recently attached slice plate.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_bottom_exposure_seconds",
    label: "Bottom exposure (s)",
    description: "Bottom-layer exposure time from the most recently attached slice plate.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_model_height_mm",
    label: "Model height (mm)",
    description: "Model height from the most recently attached slice plate.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_layer_height_mm",
    label: "Print layer height (mm)",
    description: "Layer height extracted from the slice plate.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_plate_count",
    label: "Print plate count",
    description: "Number of slice plates attached to this Print Order.",
    type: "number",
    fieldType: "number",
  },
  {
    name: "print_printer_profile",
    label: "Print printer profile",
    description: "Printer or machine profile reported by the slice file.",
    type: "string",
    fieldType: "text",
  },
  {
    name: "print_slice_attached_at",
    label: "Print slice attached at",
    description: "UTC time when Print Operations attached this slice metadata.",
    type: "string",
    fieldType: "text",
  },
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

export async function hubspotRequest(
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

/** @deprecated Prefer hubspotRequest — kept as internal alias for existing call sites. */
async function request(
  path: string,
  init: { method: string; body?: string },
): Promise<any> {
  return hubspotRequest(path, init);
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

function numericString(value: number | null, digits = 3): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function compactText(value: string | null, maxLength = 1_000): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function printFileProperties(summary: PrintFileOrderSummary, attachedAt: string): Record<string, string> {
  const { latest } = summary;
  const properties: Record<string, string> = {
    print_slice_file_name: latest.fileName.slice(0, 260),
    print_slice_format: latest.formatRevision.slice(0, 500),
    print_slice_attached_at: attachedAt,
    print_plate_count: String(summary.plateCount),
  };
  const assign = (name: string, value: string | null) => {
    if (value !== null) properties[name] = value;
  };

  assign(
    "print_estimated_time_hours",
    summary.totalPrintTimeSeconds === null
      ? null
      : numericString(summary.totalPrintTimeSeconds / 3_600, 2),
  );
  assign("print_resin_volume_ml", numericString(summary.totalResinVolumeMl));
  assign("print_resin_mass_g", numericString(summary.totalResinMassG));
  assign("print_estimated_resin_cost", numericString(summary.totalResinCost, 2));
  assign("print_layer_count", numericString(summary.totalLayerCount, 0));
  assign("print_bottom_layer_count", numericString(latest.bottomLayerCount, 0));
  assign("print_exposure_seconds", numericString(latest.exposureSeconds, 3));
  assign("print_bottom_exposure_seconds", numericString(latest.bottomExposureSeconds, 3));
  assign("print_model_height_mm", numericString(latest.modelHeightMm, 3));
  assign("print_layer_height_mm", numericString(latest.layerHeightMm, 4));
  assign("print_printer_profile", compactText(latest.printerProfile, 500));
  return properties;
}

/**
 * Create the custom deal properties only when they are missing. The operation
 * is deliberately server-side so the private app token never enters the UI.
 */
export async function ensurePrintFileDealProperties(): Promise<void> {
  const data = await request("/crm/v3/properties/deals", { method: "GET" });
  const existing = new Set(
    (Array.isArray(data?.results) ? data.results : [])
      .map((property: unknown) =>
        property &&
        typeof property === "object" &&
        "name" in property &&
        typeof (property as { name?: unknown }).name === "string"
          ? (property as { name: string }).name
          : "",
      )
      .filter(Boolean),
  );

  for (const property of PRINT_FILE_DEAL_PROPERTIES) {
    if (existing.has(property.name)) continue;
    try {
      await request("/crm/v3/properties/deals", {
        method: "POST",
        body: JSON.stringify({ ...property, groupName: "dealinformation" }),
      });
    } catch (error) {
      // A concurrent operator or workflow may have created the property after
      // this check. That is safe to treat as success; any other HubSpot error
      // is surfaced to the owner before the local record is written.
      if (!(error instanceof HubSpotError) || error.status !== 409) throw error;
    }
  }
}

/**
 * Attach calculated slice-plate metadata to one deal. This never writes material,
 * labor, packaging, shipping, gross-profit, or margin fields.
 */
export async function patchDealPrintFileMetrics(
  dealId: string,
  summary: PrintFileOrderSummary,
  attachedAt: string,
): Promise<void> {
  await ensurePrintFileDealProperties();
  await request(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: printFileProperties(summary, attachedAt) }),
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

let cachedPortalId: { value: string; fetchedAt: number } | null = null;
const PORTAL_ID_CACHE_MS = 60 * 60 * 1000;

/**
 * Resolve the HubSpot portal/account id for deep links into CRM records.
 * Cached for an hour — the id does not change for a given access token.
 */
export async function fetchHubSpotPortalId(): Promise<string | null> {
  if (cachedPortalId && Date.now() - cachedPortalId.fetchedAt < PORTAL_ID_CACHE_MS) {
    return cachedPortalId.value;
  }
  try {
    const data = await request("/account-info/v3/details", { method: "GET" });
    const raw = data?.portalId;
    const portalId =
      typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
    if (!portalId) return cachedPortalId?.value ?? null;
    cachedPortalId = { value: portalId, fetchedAt: Date.now() };
    return portalId;
  } catch {
    return cachedPortalId?.value ?? null;
  }
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
