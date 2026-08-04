import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import {
  INPUT_PROPERTIES,
  OUTPUT_PROPERTIES,
  getConfig,
  getWebhookSecret,
  resolveWriteDecision,
} from "./lib/config";
import { AUDIT_LIMIT, auditCount, listAttempts } from "./lib/audit";
import { summarizeEvents } from "./lib/events";
import { recalculateDeal } from "./lib/service";
import {
  buildRequestUri,
  CALLBACK_TOKEN_QUERY_KEY,
  findMatchingV3UriProfile,
  verifyCallbackToken,
  verifyWebhookRequest,
} from "./lib/signature";
import { getLatestWebhookDiagnostic, recordWebhookDiagnostic } from "./lib/webhook-diagnostics";
import {
  analyzeMarketplaceConversation,
  type PaidOrderDraft,
  validatePaidOrderDraft,
} from "./lib/intake";
import { createPaidOrder } from "./lib/paid-orders";

const WEBHOOK_PATH = "/api/webhooks/hubspot";
const DEFAULT_INTAKE_ACCESS_CODE_HASH = "9c8d6cb9a08c8026d4009c956faac43be8eff7b959b5cc13e7eda5d475b0e47b";

function isProductionDeployment(): boolean {
  return process.env.NODE_ENV === "production";
}

/** `?dryRun=false` is the only way to ask for a live write. Default: dry run. */
function requestWantsLiveWrite(req: Request): boolean {
  const q = req.query?.dryRun;
  const fromQuery = Array.isArray(q) ? q[0] : q;
  if (typeof fromQuery === "string") {
    return fromQuery.trim().toLowerCase() === "false";
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.dryRun === false) return true;
    if (typeof body.dryRun === "string") {
      return body.dryRun.trim().toLowerCase() === "false";
    }
  }
  return false;
}

/** A webhook is an explicit write request once the server's four live-write
 * gates are all open. `?dryRun=true` is an intentional test override. */
function webhookWantsLiveWrite(req: Request): boolean {
  const q = req.query?.dryRun;
  const dryRun = Array.isArray(q) ? q[0] : q;
  if (typeof dryRun === "string" && dryRun.trim().toLowerCase() === "true") {
    return false;
  }
  return true;
}

function rawBodyString(req: Request): string {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (typeof raw === "string") return raw;
  return "";
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function intakeAccessCodeHash(): string {
  return process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim() || DEFAULT_INTAKE_ACCESS_CODE_HASH;
}

function normalizedAccessCode(value: string): string {
  const withoutBearer = value.trim().replace(/^Bearer\s+/i, "");
  const hasMatchingQuotes =
    withoutBearer.length >= 2 &&
    ((withoutBearer.startsWith("\"") && withoutBearer.endsWith("\"")) ||
      (withoutBearer.startsWith("'") && withoutBearer.endsWith("'")));
  return hasMatchingQuotes ? withoutBearer.slice(1, -1).trim() : withoutBearer;
}

function timingSafeMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashAccessCode(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function providedIntakeAccessCode(req: Request): string {
  const headerValue = req.get("x-paid-order-access-code") ?? "";
  const bodyValue =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).intakeAccessCode
      : "";
  return normalizedAccessCode(headerValue || (typeof bodyValue === "string" ? bodyValue : ""));
}

function intakeAuthorizationStatus(req: Request): "authorized" | "not-configured" | "missing" | "mismatch" {
  const expected = intakeAccessCodeHash();
  if (!expected) return "not-configured";
  const provided = providedIntakeAccessCode(req);
  if (!provided) return "missing";
  return timingSafeMatch(hashAccessCode(provided), expected) ? "authorized" : "mismatch";
}

function paidOrderDraftFrom(body: unknown): PaidOrderDraft {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const value = (key: keyof PaidOrderDraft) =>
    typeof record[key] === "string" ? record[key].slice(0, 20_000) : "";
  return {
    paymentConfirmed: record.paymentConfirmed === true,
    fullName: value("fullName"),
    marketplaceUsername: value("marketplaceUsername"),
    email: value("email"),
    phone: value("phone"),
    address: value("address"),
    city: value("city"),
    state: value("state"),
    postalCode: value("postalCode"),
    country: value("country"),
    productName: value("productName"),
    amount: value("amount"),
    conversationSummary: value("conversationSummary"),
  };
}

function rejectUnsecuredIntake(req: Request, res: Response): boolean {
  const status = intakeAuthorizationStatus(req);
  if (status === "authorized") return false;
  res.status(status === "not-configured" ? 503 : 401).json({
    ok: false,
    error:
      status === "not-configured"
        ? "Paid Order Intake access code is not configured"
        : status === "missing"
          ? "No intake access code reached the live service"
          : "The intake access code does not match the active code",
  });
  return true;
}

/**
 * v3 signs HubSpot's public target URL. The canonical value is configured
 * through PUBLIC_BASE_URL, while these alternatives exist solely to pinpoint
 * reverse-proxy path issues during setup. They are never accepted as valid.
 */
function v3SignatureDiagnosticCandidates(
  req: Request,
): Array<{ label: string; uri: string; body: string }> {
  const headers = req.headers;
  const originalUrl = req.originalUrl;
  const configuredBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  const forwardedProto = (headers["x-forwarded-proto"] as string | undefined)
    ?.split(",")[0]
    .trim() || "https";
  const forwardedHost =
    (headers["x-forwarded-host"] as string | undefined)?.split(",")[0].trim() ||
    req.get("host") ||
    "localhost";
  const publicOrigin = `${forwardedProto}://${forwardedHost}`;
  const uriCandidates = [
    {
      label: "configured-public-base",
      uri: buildRequestUri({
        protocol: req.protocol,
        originalUrl,
        overrideBase: configuredBase,
      }),
    },
    {
      label: "direct-public-path",
      uri: buildRequestUri({
        protocol: req.protocol,
        originalUrl,
        overrideBase: publicOrigin,
      }),
    },
    {
      label: "port-5000-public-path",
      uri: buildRequestUri({
        protocol: req.protocol,
        originalUrl,
        overrideBase: `${publicOrigin}/port/5000`,
      }),
    },
  ];
  const bodyCandidates = [
    { label: "raw-body", body: rawBodyString(req) },
    { label: "canonical-json", body: JSON.stringify(req.body) },
  ].filter(
    (candidate, index, all) => all.findIndex((item) => item.body === candidate.body) === index,
  );
  const candidates = uriCandidates.flatMap((uriCandidate) =>
    bodyCandidates.map((bodyCandidate) => ({
      label: `${uriCandidate.label}/${bodyCandidate.label}`,
      uri: uriCandidate.uri,
      body: bodyCandidate.body,
    })),
  );

  return candidates.filter(
    (candidate, index, all) => all.findIndex((item) => item.uri === candidate.uri && item.body === candidate.body) === index,
  );
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/health", (_req: Request, res: Response) => {
    const config = getConfig();
    const decision = resolveWriteDecision(config, true);
    res.json({
      status: "ok",
      mode: decision.write ? "live-write" : "dry-run",
      readiness: decision.write
        ? "Live writes enabled. Recalculations PATCH HubSpot deals."
        : `Dry run only. No HubSpot writes (${decision.reason}).`,
      safety: {
        dryRun: config.dryRun,
        allowHubspotWrites: config.allowWrites,
        liveWriteReady: decision.write,
        blockedBy: decision.write ? null : decision.reason,
      },
      credentials: {
        apiBaseConfigured: config.baseFromEnv,
        apiBaseSource: config.baseFromEnv ? "environment" : "default",
        tokenConfigured: config.hasToken,
        tokenSource: config.tokenSource,
      },
      paidOrderIntake: {
        accessCodeConfigured: Boolean(intakeAccessCodeHash()),
      },
      webhook: {
        verification: config.webhookSecretConfigured ? "configured" : "not-configured",
        supportedVersions: ["v1", "v3"],
        path: WEBHOOK_PATH,
        latestDelivery: getLatestWebhookDiagnostic(),
      },
      admin: {
        publicControlsEnabled: !isProductionDeployment(),
      },
      properties: {
        inputs: [...INPUT_PROPERTIES],
        outputs: [...OUTPUT_PROPERTIES],
      },
      audit: { retained: auditCount(), limit: AUDIT_LIMIT },
      serverTime: new Date().toISOString(),
    });
  });

  app.post("/api/paid-orders/analyze", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const conversation =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>).conversation
        : "";
    if (typeof conversation !== "string" || conversation.trim().length < 20) {
      return res.status(400).json({
        ok: false,
        error: "Paste at least a few lines of the paid Marketplace conversation",
      });
    }
    return res.json({ ok: true, analysis: analyzeMarketplaceConversation(conversation) });
  });

  app.post("/api/paid-orders", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const draft = paidOrderDraftFrom(req.body);
    const validationError = validatePaidOrderDraft(draft);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    try {
      const result = await createPaidOrder(draft);
      return res.status(201).json({ ok: true, result });
    } catch (error) {
      const status = error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 502;
      return res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not create the paid HubSpot order",
      });
    }
  });

  app.post(WEBHOOK_PATH, async (req: Request, res: Response) => {
    const secret = getWebhookSecret();
    if (isProductionDeployment() && !secret) {
      recordWebhookDiagnostic({
        result: "rejected",
        version: null,
        reason: "webhook validation secret is required in production",
      });
      return res.status(503).json({
        ok: false,
        error: "webhook validation secret is required in production",
      });
    }
    const headers = req.headers;
    const requestUri = buildRequestUri({
      forwardedProto: headers["x-forwarded-proto"] as string | undefined,
      protocol: req.protocol,
      host: (headers["x-forwarded-host"] as string | undefined) || req.get("host"),
      originalUrl: req.originalUrl,
      overrideBase: process.env.PUBLIC_BASE_URL,
    });
    const verification = verifyWebhookRequest(secret, {
      method: req.method,
      uri: requestUri,
      rawBody: rawBodyString(req),
      signatureV1: headers["x-hubspot-signature"] as string | undefined,
      signatureV3: headers["x-hubspot-signature-v3"] as string | undefined,
      timestamp: headers["x-hubspot-request-timestamp"] as string | undefined,
    });
    const callbackTokenValid = verifyCallbackToken(
      firstQueryValue(req.query?.[CALLBACK_TOKEN_QUERY_KEY]),
    );

    if (!verification.valid && !callbackTokenValid) {
      const matchingUriProfile =
        verification.version === "v3"
          ? findMatchingV3UriProfile({
              clientSecret: secret,
              method: req.method,
              timestamp: headers["x-hubspot-request-timestamp"] as string | undefined,
              signature: headers["x-hubspot-signature-v3"] as string | undefined,
              candidates: v3SignatureDiagnosticCandidates(req),
            })
          : null;
      const diagnosticReason =
        verification.reason === "v3 signature mismatch"
          ? matchingUriProfile
            ? `v3 signature matches alternate request profile: ${matchingUriProfile}`
            : "v3 signature mismatch; no known request profile matched"
          : verification.reason;
      recordWebhookDiagnostic({
        result: "rejected",
        version: verification.version,
        reason: `${diagnosticReason}; callback token missing or invalid`,
      });
      return res.status(401).json({
        ok: false,
        error: "signature rejected",
        detail: diagnosticReason,
      });
    }

    const summary = summarizeEvents(req.body);
    recordWebhookDiagnostic({
      result: "accepted",
      version: verification.version,
      reason: verification.valid
        ? verification.reason
        : "secure callback token valid; signature mismatch bypassed for private-app delivery",
    });
    const wantsLiveWrite = webhookWantsLiveWrite(req);

    const results = [];
    for (const dealId of summary.dealIds) {
      results.push(
        await recalculateDeal({ dealId, origin: "webhook", requestWantsLiveWrite: wantsLiveWrite }),
      );
    }

    res.json({
      ok: true,
      signature: verification.valid
        ? verification.enforced
          ? verification.reason
          : "verification not configured"
        : "secure callback token valid",
      received: summary.received,
      matched: summary.matched,
      ignoredOutputEvents: summary.ignoredOutputEvents,
      ignoredOther: summary.ignoredOther,
      deals: summary.dealIds.length,
      written: results.filter((r) => r.status === "written").length,
      dryRun: results.filter((r) => r.status === "dry-run").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    });
  });

  app.post("/api/recalculate/:dealId", async (req: Request, res: Response) => {
    if (isProductionDeployment()) {
      return res.status(403).json({
        ok: false,
        error: "manual recalculation is disabled on the public service",
      });
    }
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({
        ok: false,
        error: "dealId must be a numeric HubSpot deal record id",
      });
    }
    const outcome = await recalculateDeal({
      dealId,
      origin: "manual",
      requestWantsLiveWrite: requestWantsLiveWrite(req),
    });
    res.status(outcome.status === "error" ? 502 : 200).json({
      ok: outcome.status !== "error",
      ...outcome,
    });
  });

  app.get("/api/calculations", (req: Request, res: Response) => {
    if (isProductionDeployment()) {
      return res.status(403).json({
        ok: false,
        error: "audit entries are not exposed by the public service",
      });
    }
    const limitParam = Number(req.query.limit);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), AUDIT_LIMIT)
        : AUDIT_LIMIT;
    res.json({ count: auditCount(), limit: AUDIT_LIMIT, entries: listAttempts(limit) });
  });

  return httpServer;
}
