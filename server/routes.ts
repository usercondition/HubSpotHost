import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import multer from "multer";
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
import {
  fetchPrintOrderDeals,
  fetchPrintOrderPipelineStages,
  HubSpotError,
  patchDealPrintFileMetrics,
} from "./lib/hubspot";
import { buildPerformanceSnapshot } from "./lib/performance";
import { CtbParseError } from "./lib/ctb";
import { PRINT_FILE_MAX_BYTES } from "./lib/print-file-limits";
import {
  attachedPrintFileDealIds,
  buildPrintFileOrderSummary,
  createPrintFileRecord,
  getStagedPrintFile,
  listPrintFileRecords,
  markPrintFileAnalysisUsed,
  stagePrintFile,
} from "./lib/print-files";
import { buildSupplySpendSummary, createSupplyPurchase, listSupplyPurchases } from "./lib/supplies";
import {
  refreshResinPriceFromAmazon,
  resinProfileView,
  upsertActiveResinProfile,
} from "./lib/resin-pricing";
import { getLatestWebhookDiagnostic, recordWebhookDiagnostic } from "./lib/webhook-diagnostics";
import {
  analyzeMarketplaceConversation,
  type PaidOrderDraft,
  validatePaidOrderDraft,
} from "./lib/intake";
import { createPaidOrder } from "./lib/paid-orders";
import {
  applyReviewEdits,
  clientLinkPath,
  createOrderLink,
  expireOrderLink,
  getOrderLink,
  listOrderLinks,
  lookupClientOrder,
  markOrderLinkCreated,
  orderLinkCounts,
  submitClientOrder,
} from "./lib/order-links";
import {
  ORDER_INTAKE_STATUSES,
  clientOrderSubmissionSchema,
  createOrderLinkSchema,
  createSupplyPurchaseSchema,
  attachPrintFileSchema,
  upsertResinProfileSchema,
  reviewEditSchema,
  type PrintFileCandidateDeal,
  type OrderIntakeLink,
  type OrderIntakeStatus,
} from "../shared/schema";

const WEBHOOK_PATH = "/api/webhooks/hubspot";
const INTAKE_BUILD_ID = "intake-auth-v6-20260803";
const printFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRINT_FILE_MAX_BYTES, files: 1 },
});

function isProductionDeployment(): boolean {
  return process.env.NODE_ENV === "production";
}

function internalAdminEnabled(): boolean {
  return (
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") &&
    process.env.ENABLE_INTERNAL_ADMIN === "true"
  );
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
  return process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH?.trim() || "";
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

function firstIssue(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Some details are missing or invalid";
}

function stageIsClosed(stage: { metadata: Record<string, unknown> } | undefined): boolean {
  const value = stage?.metadata?.isClosed;
  return value === true || value === "true";
}

/** The owner-side representation. `tokenHash` never leaves the server. */
function ownerLinkView(link: OrderIntakeLink): Omit<OrderIntakeLink, "tokenHash"> {
  const { tokenHash: _tokenHash, ...safe } = link;
  return safe;
}

function tokenFromBody(body: unknown): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = typeof record.token === "string" ? record.token.trim() : "";
  return /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : "";
}

/**
 * Small in-memory throttle. The token space is 256 bits, so this exists to blunt
 * automated probing rather than to be a complete rate limiter.
 */
const clientAttempts = new Map<string, { count: number; resetAt: number }>();
const CLIENT_ATTEMPT_WINDOW_MS = 60_000;
const CLIENT_ATTEMPT_LIMIT = 40;

function tooManyClientAttempts(req: Request, res: Response): boolean {
  const key = req.ip || "unknown";
  const now = Date.now();
  const entry = clientAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    clientAttempts.set(key, { count: 1, resetAt: now + CLIENT_ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  if (entry.count > CLIENT_ATTEMPT_LIMIT) {
    res.status(429).json({ ok: false, reason: "throttled" });
    return true;
  }
  return false;
}

/**
 * Maps a reviewed intake onto the existing paid-order draft shape so the
 * approval path reuses `createPaidOrder` unchanged. Only structured fields and
 * a short summary are sent — never a raw conversation.
 */
function draftFromIntake(link: OrderIntakeLink): PaidOrderDraft {
  const item = link.confirmedItem || link.itemDescription;
  const summary = [
    "Source: Facebook Marketplace one-time client details link.",
    `Internal reference: ${link.internalLabel}.`,
    `Agreed item: ${item}${link.quantity > 1 ? ` (qty ${link.quantity})` : ""}.`,
    link.paymentMethod ? `Payment method: ${link.paymentMethod}.` : "",
    link.paymentReference ? `Payment reference: ${link.paymentReference}.` : "",
    link.clientPaymentConfirmed ? "Buyer confirmed payment on the client form." : "",
    "Owner verified payment before HubSpot creation.",
    link.shippingRequired ? "Shipping required." : "Local pickup / no shipping required.",
    link.clientNotes ? `Buyer notes: ${link.clientNotes}` : "",
    link.ownerNotes ? `Owner notes: ${link.ownerNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    paymentConfirmed: true,
    fullName: link.clientFullName,
    marketplaceUsername: link.clientUsername || link.buyerUsernameHint,
    email: link.clientEmail,
    phone: link.clientPhone,
    address: link.shippingRequired ? link.shippingStreet : "",
    city: link.shippingRequired ? link.shippingCity : "",
    state: link.shippingRequired ? link.shippingState : "",
    postalCode: link.shippingRequired ? link.shippingPostalCode : "",
    country: link.shippingRequired ? link.shippingCountry : "",
    productName: link.quantity > 1 ? `${item} (x${link.quantity})` : item,
    amount: link.agreedAmount,
    conversationSummary: summary,
  };
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
        buildId: INTAKE_BUILD_ID,
        clientLinkWorkflow: "enabled",
      },
      webhook: {
        verification: config.webhookSecretConfigured ? "configured" : "not-configured",
        callbackToken: process.env.HUBSPOT_CALLBACK_TOKEN_SHA256?.trim()
          ? "configured"
          : "not-configured",
        supportedVersions: ["v1", "v3"],
        path: WEBHOOK_PATH,
        latestDelivery: getLatestWebhookDiagnostic(),
      },
      admin: {
        internalControlsEnabled: internalAdminEnabled(),
      },
      properties: {
        inputs: [...INPUT_PROPERTIES],
        outputs: [...OUTPUT_PROPERTIES],
      },
      audit: { retained: auditCount(), limit: AUDIT_LIMIT },
      serverTime: new Date().toISOString(),
    });
  });

  /* ---------------------------------------------------------------- */
  /* Client order links — the primary paid-order intake workflow.       */
  /*                                                                   */
  /* Owner routes are gated by the intake access code. The two public   */
  /* routes take the link token in the request BODY (never the path or  */
  /* query string) so the token can never appear in request logs.       */
  /*                                                                   */
  /* PRODUCTION HARDENING: the owner gate is one shared app-owned       */
  /* access code, not real authentication. A production pass should     */
  /* replace it with per-user accounts, sessions, and per-user audit    */
  /* attribution before more than one person needs owner access.        */
  /* ---------------------------------------------------------------- */

  app.post("/api/order-links", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = createOrderLinkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const created = createOrderLink(parsed.data);
    // `token` and `path` are returned exactly once. Nothing here is logged.
    return res.status(201).json({
      ok: true,
      link: ownerLinkView(created.link),
      token: created.token,
      path: clientLinkPath(created.token),
    });
  });

  app.get("/api/order-links", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const statusParam = firstQueryValue(req.query?.status);
    const status = ORDER_INTAKE_STATUSES.includes(statusParam as OrderIntakeStatus)
      ? (statusParam as OrderIntakeStatus)
      : undefined;
    return res.json({
      ok: true,
      counts: orderLinkCounts(),
      links: listOrderLinks(status).map(ownerLinkView),
    });
  });

  /**
   * Owner-only supply ledger. Regular Amazon accounts have no clean, official
   * order-feed integration, so the owner records receipt totals here. This
   * remains independent from actual cost fields on a HubSpot deal to prevent
   * double-counting the same spend in gross-profit calculations.
   */
  app.get("/api/supplies", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({
      ok: true,
      purchases: listSupplyPurchases(),
      summary: buildSupplySpendSummary(),
    });
  });

  app.post("/api/supplies", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = createSupplyPurchaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const purchase = createSupplyPurchase(parsed.data);
    return res.status(201).json({
      ok: true,
      purchase,
      summary: buildSupplySpendSummary(),
    });
  });

  /**
   * Active resin used to estimate plate cost when a CTB has no slicer price.
   * Amazon refresh is best-effort and never required for manual pricing.
   */
  app.get("/api/resin-profile", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({ ok: true, ...resinProfileView() });
  });

  app.put("/api/resin-profile", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = upsertResinProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    try {
      const profile = upsertActiveResinProfile(parsed.data);
      return res.json({ ok: true, ...resinProfileView(profile) });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not save the resin profile",
      });
    }
  });

  app.post("/api/resin-profile/refresh-amazon", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      const refreshed = await refreshResinPriceFromAmazon();
      return res.json({
        ok: true,
        cached: refreshed.cached,
        price: refreshed.price,
        ...resinProfileView(refreshed.profile),
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Amazon live price could not be refreshed. Enter the bottle price manually.",
        ...resinProfileView(),
      });
    }
  });

  /**
   * Owner-only, read-only performance summary. The API token remains server
   * side and this route deliberately performs no HubSpot writes.
   */
  app.get("/api/performance", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      const [deals, stages] = await Promise.all([
        fetchPrintOrderDeals(),
        fetchPrintOrderPipelineStages(),
      ]);
      return res.json(
        buildPerformanceSnapshot({
          deals,
          stages,
          intakeCounts: orderLinkCounts(),
          supplySpend: buildSupplySpendSummary(),
        }),
      );
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load HubSpot performance data",
      });
    }
  });

  /**
   * Owner-only view for attaching production metrics from a sliced CTB file.
   * The HubSpot portion is read-only here. A later explicit attach action is
   * required before any CRM property is written.
   */
  app.get("/api/prints", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const includeAttached = firstQueryValue(req.query?.includeAttached) === "true";

    try {
      const [deals, stages] = await Promise.all([
        fetchPrintOrderDeals(),
        fetchPrintOrderPipelineStages(),
      ]);
      const stageById = new Map(stages.map((stage) => [stage.id, stage]));
      const attachedDealIds = attachedPrintFileDealIds();
      const candidates: PrintFileCandidateDeal[] = deals
        .filter((deal) => {
          const pipeline = deal.properties.pipeline ?? "";
          const stage = stageById.get(deal.properties.dealstage ?? "");
          return pipeline === "default" && !stageIsClosed(stage);
        })
        .map((deal) => {
          const stageId = deal.properties.dealstage ?? "";
          const stage = stageById.get(stageId);
          return {
            dealId: deal.id,
            dealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}`,
            stage: stage?.label || stageId || "No stage",
            hasPrintFile: attachedDealIds.has(deal.id),
          };
        })
        .filter((deal) => includeAttached || !deal.hasPrintFile)
        .sort((a, b) => a.stage.localeCompare(b.stage) || a.dealName.localeCompare(b.dealName));

      return res.json({
        ok: true,
        candidates,
        records: listPrintFileRecords(),
        includeAttached,
        resin: resinProfileView(),
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load active Print Orders",
      });
    }
  });

  /**
   * The CTB bytes only exist for the duration of this request. The response
   * contains a short-lived analysis ID; no file binary is ever written to
   * Railway storage or sent to HubSpot.
   */
  app.post(
    "/api/prints/analyze",
    (req: Request, res: Response, next) => {
      if (rejectUnsecuredIntake(req, res)) return;
      next();
    },
    printFileUpload.single("file"),
    (req: Request, res: Response) => {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "Choose one Chitubox .ctb slice file to analyze" });
      }
      if (!/\.ctb$/i.test(file.originalname)) {
        return res.status(400).json({ ok: false, error: "Only Chitubox .ctb slice files can be analyzed here" });
      }

      try {
        const staged = stagePrintFile(file.originalname, file.buffer);
        return res.status(201).json({ ok: true, ...staged });
      } catch (error) {
        const message =
          error instanceof CtbParseError
            ? error.message
            : "The CTB file could not be read. Re-export the slice file from Chitubox and try again.";
        return res.status(400).json({ ok: false, error: message });
      }
    },
  );

  /**
   * This is the only CTB route that writes to HubSpot. It requires the owner
   * code and an explicit deal selection. HubSpot succeeds first; only then is
   * the durable local production record created.
   */
  app.post("/api/prints/attach", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = attachPrintFileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }

    const staged = getStagedPrintFile(parsed.data.analysisId);
    if (!staged) {
      return res.status(410).json({
        ok: false,
        error: "This CTB analysis has expired or was already attached. Analyze the file again before attaching it.",
      });
    }

    try {
      const [deals, stages] = await Promise.all([
        fetchPrintOrderDeals(),
        fetchPrintOrderPipelineStages(),
      ]);
      const deal = deals.find(
        (candidate) =>
          candidate.id === parsed.data.dealId && candidate.properties.pipeline === "default",
      );
      if (!deal) {
        return res.status(404).json({ ok: false, error: "That Print Order is no longer available" });
      }

      const stage = stages.find((candidate) => candidate.id === (deal.properties.dealstage ?? ""));
      if (stageIsClosed(stage)) {
        return res.status(409).json({
          ok: false,
          error: "That Print Order is closed. Choose an outstanding or in-work order instead.",
        });
      }

      const attachedAt = new Date().toISOString();
      const summary = buildPrintFileOrderSummary(deal.id, staged.metrics);
      await patchDealPrintFileMetrics(parsed.data.dealId, summary, attachedAt);
      const record = createPrintFileRecord({
        analysisId: parsed.data.analysisId,
        hubspotDealId: deal.id,
        hubspotDealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}`,
        dealStage: stage?.label || deal.properties.dealstage || "No stage",
        metrics: staged.metrics,
      });
      markPrintFileAnalysisUsed(parsed.data.analysisId);

      return res.status(201).json({
        ok: true,
        record,
        summary,
        message: `Plate ${summary.plateCount} is attached to this HubSpot deal and the running production totals are updated.`,
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not attach CTB production metrics to the Print Order",
      });
    }
  });

  app.get("/api/order-links/:id", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const link = getOrderLink(Number(req.params.id));
    if (!link) return res.status(404).json({ ok: false, error: "That intake no longer exists" });
    return res.json({ ok: true, link: ownerLinkView(link) });
  });

  app.patch("/api/order-links/:id", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = reviewEditSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const link = applyReviewEdits(Number(req.params.id), parsed.data);
    if (!link) return res.status(404).json({ ok: false, error: "That intake no longer exists" });
    if (link.status !== "pending_review") {
      return res.status(409).json({
        ok: false,
        error: "Only an intake that is pending review can be edited",
        link: ownerLinkView(link),
      });
    }
    return res.json({ ok: true, link: ownerLinkView(link) });
  });

  app.post("/api/order-links/:id/expire", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const link = expireOrderLink(Number(req.params.id));
    if (!link) return res.status(404).json({ ok: false, error: "That intake no longer exists" });
    if (link.status === "created") {
      return res.status(409).json({
        ok: false,
        error: "An intake that already produced HubSpot records cannot be expired",
        link: ownerLinkView(link),
      });
    }
    return res.json({ ok: true, link: ownerLinkView(link) });
  });

  /**
   * The ONLY route in this workflow that talks to HubSpot. It requires the
   * owner's access code plus an explicit `paymentVerified: true`, and it can
   * run once per intake because the status guard is part of the UPDATE.
   */
  app.post("/api/order-links/:id/create-order", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    if (body.paymentVerified !== true) {
      return res.status(400).json({
        ok: false,
        error: "Confirm that you verified the payment before creating HubSpot records",
      });
    }
    const link = getOrderLink(Number(req.params.id));
    if (!link) return res.status(404).json({ ok: false, error: "That intake no longer exists" });
    if (link.status === "created") {
      return res.status(409).json({
        ok: false,
        error: "This intake already created a Contact and Print Order",
        link: ownerLinkView(link),
      });
    }
    if (link.status !== "pending_review") {
      return res.status(409).json({
        ok: false,
        error: "Only an intake with submitted client details can be approved",
        link: ownerLinkView(link),
      });
    }

    const draft = draftFromIntake(link);
    const validationError = validatePaidOrderDraft(draft);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    try {
      const result = await createPaidOrder(draft);
      const updated = markOrderLinkCreated(link.id, {
        contactId: result.contactId,
        dealId: result.dealId,
        dealName: result.dealName,
      });
      return res.status(201).json({ ok: true, result, link: updated ? ownerLinkView(updated) : null });
    } catch (error) {
      const status =
        error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 502;
      return res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not create the paid HubSpot order",
      });
    }
  });

  /** Public: validate a client link. Reveals nothing owner-side. */
  app.post("/api/client-order/lookup", (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const result = lookupClientOrder(token);
    if (!result.ok) return res.status(result.reason === "invalid" ? 404 : 410).json(result);
    return res.json(result);
  });

  /**
   * Public: one buyer submission per link. This writes ONLY to the local
   * SQLite queue — it never calls HubSpot.
   */
  app.post("/api/client-order/submit", (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const parsed = clientOrderSubmissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, reason: "invalid-details", error: firstIssue(parsed.error) });
    }
    const result = submitClientOrder(token, parsed.data);
    if (!result.ok) return res.status(result.reason === "invalid" ? 404 : 410).json(result);
    return res.status(201).json({ ok: true });
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
    if (!internalAdminEnabled()) {
      return res.status(403).json({
        ok: false,
        error: "manual recalculation is disabled outside explicitly enabled local development",
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
    if (!internalAdminEnabled()) {
      return res.status(403).json({
        ok: false,
        error: "audit entries are disabled outside explicitly enabled local development",
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
