import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
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
  findMatchingV3UriProfile,
  verifyWebhookRequest,
} from "./lib/signature";
import { getLatestWebhookDiagnostic, recordWebhookDiagnostic } from "./lib/webhook-diagnostics";

const WEBHOOK_PATH = "/api/webhooks/hubspot";

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

    if (!verification.valid) {
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
        reason: diagnosticReason,
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
      reason: verification.reason,
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
      signature: verification.enforced ? verification.reason : "verification not configured",
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
