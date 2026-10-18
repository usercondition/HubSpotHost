/**
 * Sentry error tracking + default tracing for the Print Ops server.
 *
 * Loaded before the app via `node --import ./dist/instrument.mjs` (see
 * package.json "start") so Sentry's OpenTelemetry hooks see express/http
 * before they are required. Does nothing unless SENTRY_DSN is set.
 *
 * Privacy: no default PII, and request bodies, cookies, query strings, most
 * headers, user info and console breadcrumbs are stripped before sending so
 * buyer names, emails, addresses, access codes and tokens never leave the box.
 */
import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";

const KEPT_HEADERS = new Set(["user-agent", "content-type", "content-length", "accept"]);

function scrubRequest(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.split("?")[0];
    if (event.request.headers) {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (KEPT_HEADERS.has(k.toLowerCase()) && typeof v === "string") kept[k] = v;
      }
      event.request.headers = kept;
    }
  }
  return event;
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // App console output can mention buyers; keep it out of Sentry.
  if (crumb.category === "console") return null;
  const url = crumb.data?.url;
  if (typeof url === "string") crumb.data = { ...crumb.data, url: url.split("?")[0] };
  return crumb;
}

const dsn = process.env.SENTRY_DSN?.trim();
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || "production",
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // No PII (SDK v11 replacement for sendDefaultPii: false): no user info,
    // cookies, bodies, query params, DB query data, or non-allowlisted headers.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: [...KEPT_HEADERS] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
      queues: false,
      stackFrameVariables: false,
    },
    // Default tracing, sampled low for a single-owner production app.
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubRequest(event),
    beforeSendSpan: (span) => {
      // Streamed spans carry `attributes`; static spans carry `data`.
      const loose = span as unknown as { attributes?: Record<string, unknown>; data?: Record<string, unknown> };
      const attrs = loose.attributes ?? loose.data;
      for (const key of ["url.full", "http.url", "http.target"]) {
        const v = attrs?.[key];
        if (typeof v === "string") attrs![key] = v.split("?")[0];
      }
      return span;
    },
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  });
}
