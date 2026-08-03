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
import { buildRequestUri, verifyWebhookRequest } from "./lib/signature";

const WEBHOOK_PATH = "/api/webhooks/hubspot";

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

function rawBodyString(req: Request): string {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (typeof raw === "string") return raw;
  return "";
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
    const headers = req.headers;
    const verification = verifyWebhookRequest(secret, {
      method: req.method,
      uri: buildRequestUri({
        forwardedProto: headers["x-forwarded-proto"] as string | undefined,
        protocol: req.protocol,
        host: (headers["x-forwarded-host"] as string | undefined) || req.get("host"),
        originalUrl: req.originalUrl,
        overrideBase: process.env.PUBLIC_BASE_URL,
      }),
      rawBody: rawBodyString(req),
      signatureV1: headers["x-hubspot-signature"] as string | undefined,
      signatureV3: headers["x-hubspot-signature-v3"] as string | undefined,
      timestamp: headers["x-hubspot-request-timestamp"] as string | undefined,
    });

    if (!verification.valid) {
      return res.status(401).json({
        ok: false,
        error: "signature rejected",
        detail: verification.reason,
      });
    }

    const summary = summarizeEvents(req.body);
    const wantsLiveWrite = requestWantsLiveWrite(req);

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
    const limitParam = Number(req.query.limit);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), AUDIT_LIMIT)
        : AUDIT_LIMIT;
    res.json({ count: auditCount(), limit: AUDIT_LIMIT, entries: listAttempts(limit) });
  });

  return httpServer;
}
