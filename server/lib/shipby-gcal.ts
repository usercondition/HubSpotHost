/**
 * Sync production-queue ship-by dates → Google Calendar all-day FREE events.
 *
 * Source of truth: Print Ops queue projection. Local JSON maps dealId → eventId
 * so HubSpot writes are not required. Skips cleanly when Google env is unset.
 */

import { createSign, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProductionQueueItem, ProductionQueueResponse } from "../../shared/schema";
import {
  formatShipByCalendarDescription,
  formatShipByCalendarTitle,
  shipByAllDayEndDate,
  type ShipByCalendarDeal,
} from "../../shared/shipby-gcal-format";

export type { ShipByCalendarDeal };

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ShipByGcalMappedEvent = {
  eventId: string;
  shipBy: string;
  title: string;
  updatedAt: string;
};

export type ShipByGcalState = {
  events: Record<string, ShipByGcalMappedEvent>;
  lastSyncedAt?: string;
  lastError?: string | null;
  updatedAt?: string;
};

export type ShipByGcalSyncResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  errors: string[];
  lastError?: string | null;
};

export type GoogleCalendarEventInput = {
  summary: string;
  description: string;
  startDate: string;
  endDate: string;
  dealId: string;
};

export type GoogleCalendarClient = {
  listManagedEventIds: () => Promise<Map<string, string>>;
  createEvent: (input: GoogleCalendarEventInput) => Promise<string>;
  updateEvent: (eventId: string, input: GoogleCalendarEventInput) => Promise<void>;
  deleteEvent: (eventId: string) => Promise<void>;
};

function envTrim(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() || "";
}

export function shipByGcalStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SHIPBY_GCAL_STATE_FILE?.trim();
  if (override) return resolve(override);
  const digestState = env.OWNER_DIGEST_STATE_FILE?.trim();
  if (digestState) return resolve(dirname(digestState), "shipby-gcal-state.json");
  const dbFile = env.ORDER_LINKS_DB_FILE?.trim();
  if (dbFile) return resolve(dirname(dbFile), "shipby-gcal-state.json");
  return resolve(process.cwd(), "data", "shipby-gcal-state.json");
}

export function readShipByGcalState(env: NodeJS.ProcessEnv = process.env): ShipByGcalState {
  const path = shipByGcalStatePath(env);
  if (!existsSync(path)) return { events: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ShipByGcalState;
    return {
      events: parsed.events && typeof parsed.events === "object" ? parsed.events : {},
      lastSyncedAt: parsed.lastSyncedAt,
      lastError: parsed.lastError ?? null,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { events: {} };
  }
}

export function writeShipByGcalState(state: ShipByGcalState, env: NodeJS.ProcessEnv = process.env): void {
  const path = shipByGcalStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
  );
}

export function getShipByGcalConfig(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  calendarId: string;
  scheduleEnabled: boolean;
  intervalMinutes: number;
  timeZone: string;
  authMode: "service_account" | "oauth" | "none";
} {
  const calendarId = envTrim(env, "GOOGLE_SHIP_CALENDAR_ID") || envTrim(env, "GOOGLE_CALENDAR_ID") || "primary";
  const hasSa =
    Boolean(envTrim(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL")) &&
    Boolean(envTrim(env, "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") || envTrim(env, "CUSTOM_CRED_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_TOKEN"));
  const hasOauth =
    Boolean(envTrim(env, "GOOGLE_OAUTH_CLIENT_ID")) &&
    Boolean(envTrim(env, "GOOGLE_OAUTH_CLIENT_SECRET")) &&
    Boolean(envTrim(env, "GOOGLE_OAUTH_REFRESH_TOKEN"));
  const authMode = hasSa ? "service_account" : hasOauth ? "oauth" : "none";
  const scheduleEnabled =
    (env.SHIPBY_GCAL_SCHEDULE_ENABLED || "").trim().toLowerCase() === "true" ||
    (env.SHIPBY_GCAL_SCHEDULE_ENABLED || "").trim() === "1";
  const parsed = Number.parseInt(env.SHIPBY_GCAL_INTERVAL_MINUTES?.trim() || "20", 10);
  const intervalMinutes = Number.isFinite(parsed) && parsed >= 5 && parsed <= 120 ? parsed : 20;
  return {
    configured: authMode !== "none",
    calendarId,
    scheduleEnabled,
    intervalMinutes,
    timeZone: envTrim(env, "SHIPBY_GCAL_TZ") || "America/Los_Angeles",
    authMode,
  };
}

export function googleCalendarConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getShipByGcalConfig(env).configured;
}

function privateKeyFromEnv(env: NodeJS.ProcessEnv): string {
  const raw =
    envTrim(env, "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY") ||
    envTrim(env, "CUSTOM_CRED_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_TOKEN");
  return raw.replace(/\\n/g, "\n");
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function fetchServiceAccountAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  const email = envTrim(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const key = privateKeyFromEnv(env);
  if (!email || !key) throw new Error("Google service account credentials are incomplete");

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: email,
      scope: CALENDAR_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(createPrivateKey(key)).toString("base64url");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google token response missing access_token");
  return data.access_token;
}

async function fetchOAuthAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  const clientId = envTrim(env, "GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = envTrim(env, "GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = envTrim(env, "GOOGLE_OAUTH_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Google OAuth credentials are incomplete");
  }
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google OAuth refresh failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google OAuth response missing access_token");
  return data.access_token;
}

export async function getGoogleCalendarAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = getShipByGcalConfig(env);
  if (config.authMode === "service_account") return fetchServiceAccountAccessToken(env);
  if (config.authMode === "oauth") return fetchOAuthAccessToken(env);
  throw new Error("Google Calendar is not configured");
}

function eventBody(input: GoogleCalendarEventInput) {
  return {
    summary: input.summary,
    description: input.description,
    start: { date: input.startDate },
    end: { date: input.endDate },
    transparency: "transparent",
    visibility: "private",
    extendedProperties: {
      private: {
        printOpsDealId: input.dealId,
        printOpsSource: "shipby-gcal",
      },
    },
  };
}

export function createGoogleCalendarClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): GoogleCalendarClient {
  const config = getShipByGcalConfig(env);
  const calendarId = encodeURIComponent(config.calendarId);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;

  async function authed(path: string, init?: RequestInit) {
    const token = await getGoogleCalendarAccessToken(env);
    const response = await fetchImpl(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    return response;
  }

  return {
    async listManagedEventIds() {
      const map = new Map<string, string>();
      let pageToken = "";
      do {
        const url = new URL(base);
        url.searchParams.set("privateExtendedProperty", "printOpsSource=shipby-gcal");
        url.searchParams.set("showDeleted", "false");
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("singleEvents", "true");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await authed(url.toString());
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Google Calendar list failed (${response.status}): ${text.slice(0, 200)}`);
        }
        const data = (await response.json()) as {
          items?: Array<{ id?: string; extendedProperties?: { private?: Record<string, string> } }>;
          nextPageToken?: string;
        };
        for (const item of data.items ?? []) {
          const dealId = item.extendedProperties?.private?.printOpsDealId;
          if (dealId && item.id) map.set(dealId, item.id);
        }
        pageToken = data.nextPageToken || "";
      } while (pageToken);
      return map;
    },

    async createEvent(input) {
      const response = await authed(base, {
        method: "POST",
        body: JSON.stringify(eventBody(input)),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google Calendar create failed (${response.status}): ${text.slice(0, 200)}`);
      }
      const data = (await response.json()) as { id?: string };
      if (!data.id) throw new Error("Google Calendar create response missing event id");
      return data.id;
    },

    async updateEvent(eventId, input) {
      const response = await authed(`${base}/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        body: JSON.stringify(eventBody(input)),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google Calendar update failed (${response.status}): ${text.slice(0, 200)}`);
      }
    },

    async deleteEvent(eventId) {
      const response = await authed(`${base}/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
      });
      // 404/410 = already gone — treat as success for idempotency.
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        const text = await response.text();
        throw new Error(`Google Calendar delete failed (${response.status}): ${text.slice(0, 200)}`);
      }
    },
  };
}

export function queueItemsForShipByGcal(queue: ProductionQueueResponse): ShipByCalendarDeal[] {
  const seen = new Set<string>();
  const deals: ShipByCalendarDeal[] = [];
  for (const item of [...queue.nextPrint, ...queue.inProduction, ...queue.blocked, ...queue.shipReady]) {
    if (seen.has(item.dealId)) continue;
    seen.add(item.dealId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.shipBy)) continue;
    deals.push(toShipByCalendarDeal(item));
  }
  return deals;
}

export function toShipByCalendarDeal(item: ProductionQueueItem): ShipByCalendarDeal {
  return {
    dealId: item.dealId,
    dealName: item.dealName,
    contactName: item.contactName,
    amount: item.amount,
    stage: item.stage,
    shipBy: item.shipBy,
    shipBySource: item.shipBySource,
  };
}

function publicAppBase(env: NodeJS.ProcessEnv): string {
  return (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

function eventInputForDeal(deal: ShipByCalendarDeal, env: NodeJS.ProcessEnv): GoogleCalendarEventInput {
  return {
    summary: formatShipByCalendarTitle(deal),
    description: formatShipByCalendarDescription(deal, { publicBaseUrl: publicAppBase(env) }),
    startDate: deal.shipBy,
    endDate: shipByAllDayEndDate(deal.shipBy),
    dealId: deal.dealId,
  };
}

/**
 * Upsert/delete Google Calendar all-day FREE events from open-queue ship-by rows.
 * Idempotent via local dealId→eventId map (+ private extended property on events).
 */
export async function syncShipByGoogleCalendar(
  deals: ShipByCalendarDeal[],
  env: NodeJS.ProcessEnv = process.env,
  client?: GoogleCalendarClient,
): Promise<ShipByGcalSyncResult> {
  const config = getShipByGcalConfig(env);
  if (!config.configured) {
    return {
      ok: true,
      skipped: true,
      reason: "Google Calendar is not configured",
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      errors: [],
    };
  }

  const state = readShipByGcalState(env);
  const desired = new Map(deals.map((deal) => [deal.dealId, deal]));
  const api = client ?? createGoogleCalendarClient(env);
  const result: ShipByGcalSyncResult = {
    ok: true,
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    errors: [],
  };

  try {
    // Prefer local map; fall back to calendar private props for recovery.
    let remoteByDeal = new Map<string, string>();
    try {
      remoteByDeal = await api.listManagedEventIds();
    } catch (error) {
      // Listing is best-effort; local map still drives sync.
      result.errors.push(error instanceof Error ? error.message : "Could not list Google Calendar events");
    }

    for (const [dealId, deal] of desired) {
      const mapped = state.events[dealId];
      const remoteId = mapped?.eventId || remoteByDeal.get(dealId);
      const title = formatShipByCalendarTitle(deal);
      const input = eventInputForDeal(deal, env);
      try {
        if (!remoteId) {
          const eventId = await api.createEvent(input);
          state.events[dealId] = {
            eventId,
            shipBy: deal.shipBy,
            title,
            updatedAt: new Date().toISOString(),
          };
          result.created += 1;
          continue;
        }
        if (mapped && mapped.shipBy === deal.shipBy && mapped.title === title && mapped.eventId === remoteId) {
          result.unchanged += 1;
          continue;
        }
        await api.updateEvent(remoteId, input);
        state.events[dealId] = {
          eventId: remoteId,
          shipBy: deal.shipBy,
          title,
          updatedAt: new Date().toISOString(),
        };
        result.updated += 1;
      } catch (error) {
        result.ok = false;
        result.errors.push(
          `${dealId}: ${error instanceof Error ? error.message : "sync failed"}`,
        );
      }
    }

    for (const dealId of Object.keys(state.events)) {
      if (desired.has(dealId)) continue;
      const mapped = state.events[dealId];
      if (!mapped) continue;
      try {
        await api.deleteEvent(mapped.eventId);
        delete state.events[dealId];
        result.deleted += 1;
      } catch (error) {
        result.ok = false;
        result.errors.push(
          `${dealId} delete: ${error instanceof Error ? error.message : "delete failed"}`,
        );
      }
    }

    state.lastSyncedAt = new Date().toISOString();
    state.lastError = result.errors.length > 0 ? result.errors[0]! : null;
    writeShipByGcalState(state, env);
    result.lastError = state.lastError;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Calendar sync failed";
    state.lastError = message;
    writeShipByGcalState(state, env);
    return {
      ok: false,
      created: result.created,
      updated: result.updated,
      deleted: result.deleted,
      unchanged: result.unchanged,
      errors: [...result.errors, message],
      lastError: message,
    };
  }
}

let gcalTimer: ReturnType<typeof setInterval> | null = null;

export function startShipByGcalScheduler(
  loadQueue: () => Promise<ProductionQueueResponse>,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): void {
  if (gcalTimer) return;
  const config = getShipByGcalConfig(env);
  if (!config.scheduleEnabled) {
    log("Ship-by Google Calendar schedule off (set SHIPBY_GCAL_SCHEDULE_ENABLED=true to enable).");
    return;
  }
  if (!config.configured) {
    log("Ship-by Google Calendar schedule enabled but Google credentials are incomplete.");
    return;
  }

  log(
    `Ship-by Google Calendar schedule on: every ${config.intervalMinutes}m → ${config.calendarId}.`,
  );

  const tick = async () => {
    try {
      const queue = await loadQueue();
      const result = await syncShipByGoogleCalendar(queueItemsForShipByGcal(queue), env);
      if (result.skipped) {
        log(`Ship-by GCal skipped: ${result.reason}`);
        return;
      }
      if (!result.ok) {
        log(`Ship-by GCal sync errors: ${result.errors.join(" · ")}`);
        return;
      }
      log(
        `Ship-by GCal sync ok: +${result.created} ~${result.updated} -${result.deleted} =${result.unchanged}`,
      );
    } catch (error) {
      log(`Ship-by GCal tick error: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };

  void tick();
  gcalTimer = setInterval(() => void tick(), config.intervalMinutes * 60_000);
  if (typeof gcalTimer.unref === "function") gcalTimer.unref();
}
