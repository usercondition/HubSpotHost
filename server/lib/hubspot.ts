/**
 * Minimal direct HTTPS client for the HubSpot CRM API.
 *
 * Uses global fetch with a Bearer token taken from injected environment
 * variables. No connector bridge, no SDK, and the token is never logged.
 */
import { INPUT_PROPERTIES, getConfig, getToken } from "./config";

const REQUEST_TIMEOUT_MS = 15_000;

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
