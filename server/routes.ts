import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  fetchHubSpotPortalId,
  fetchPrintOrderDeals,
  fetchPrintOrderPipelineStages,
  HubSpotError,
  clearDealPrintFileMetrics,
  patchDealPrintFileMetrics,
  type HubSpotDealRecord,
  type HubSpotPipelineStage,
} from "./lib/hubspot";
import { buildPerformanceSnapshot } from "./lib/performance";
import {
  activeAttentionOverrideKeys,
  clearAttentionOverride,
  dismissAttentionAlert,
} from "./lib/attention";
import { answerTrackerQuestion, type TrackerAssistantContext } from "./lib/tracker-assistant";
import {
  getOwnerDigestSchedule,
  sendOwnerDigest,
  startOwnerDigestScheduler,
  type OwnerDigestContext,
} from "./lib/owner-digest";
import {
  getHealthNudgeSchedule,
  sendHealthNudge,
  startHealthNudgeScheduler,
} from "./lib/health-nudge";
import { telegramConfigured } from "./lib/telegram";
import { suggestAddresses } from "./lib/address-suggest";
import { CtbParseError } from "./lib/ctb";
import { UltxParseError } from "./lib/ultx";
import { PRINT_FILE_MAX_BYTES } from "./lib/print-file-limits";
import {
  deleteKitForDeal,
  getKitForDeal,
  listKitSummaries,
  upsertKitForDeal,
} from "./lib/kits";
import {
  attachedPrintFileDealIds,
  buildPrintFileOrderSummaryFromRecords,
  buildPrintFileOrderSummary,
  createPrintFileRecord,
  deletePrintFileRecord,
  getPrintFileRecord,
  getStagedPrintFile,
  groupPrintFileRecordsByDeal,
  isSupportedSliceFileName,
  listPrintFileRecords,
  markPrintFileAnalysisUsed,
  previewAttachSummary,
  stagePrintFileFromPath,
  stageCtbFromPrefix,
  syncPrintFileDealStages,
} from "./lib/print-files";
import {
  addBitsToRecord,
  deleteBit,
  listBitsForRecord,
  listBitsForRecords,
  summarizeBits,
  updateBitStatus,
} from "./lib/plate-bits";
import {
  clearOrderParts,
  deleteOrderPart,
  getOrderPartsView,
  importOrderParts,
  listOrderPartSummaries,
  summarizeOrderParts,
  updateOrderPartStatus,
} from "./lib/order-parts";
import {
  addPrinterLifecycleEvent,
  assignPrintFilePrinter,
  assignPrinterProfile,
  buildPrinterFleetSnapshot,
  ensureDefaultPrinters,
  getPrinter,
  isSharedModelPrinterProfile,
  matchPrinterId,
  updatePrinter,
} from "./lib/printers";
import { buildSupplySpendSummary, createSupplyPurchase, listSupplyPurchases } from "./lib/supplies";
import {
  formatFromUpload,
  isSupportedSupplyReceiptUpload,
  parseSupplyReceipt,
  SUPPLY_INVOICE_MAX_BYTES,
  SUPPLY_INVOICE_MAX_LABEL,
} from "./lib/supply-invoice";
import {
  refreshResinPriceFromAmazon,
  resinProfileView,
  upsertActiveResinProfile,
} from "./lib/resin-pricing";
import {
  adjustSealedStock,
  buildResinInventorySnapshot,
  consumeResinForAttachedPlate,
  ensureDefaultResinInventory,
  openResinBottle,
  setActiveResinBottle,
  upsertResinProduct,
} from "./lib/resin-inventory";
import { getLatestWebhookDiagnostic, recordWebhookDiagnostic } from "./lib/webhook-diagnostics";
import {
  analyzeMarketplaceConversation,
  type PaidOrderDraft,
  validatePaidOrderDraft,
  validatePaidOrderLineItems,
} from "./lib/intake";
import {
  createMessengerScanBridge,
  redeemMessengerScanBridge,
} from "./lib/messenger-scan-bridge";
import { registerMessengerScanTestUi } from "./lib/messenger-scan-test-ui";
import { createMarketplaceInboxBrief, getMarketplaceInboxBrief } from "./lib/marketplace-inbox-brief-store";
import { createPaidOrder } from "./lib/paid-orders";
import {
  applyReviewEdits,
  clientLinkPath,
  createOrderLink,
  expireOrderLink,
  findPriorClientDetails,
  getOrderLink,
  listOrderLinks,
  lookupClientOrder,
  lookupClientSavedDetails,
  markOrderLinkCreated,
  orderLinkCounts,
  describeOrderLinksStorage,
  submitClientOrder,
} from "./lib/order-links";
import { applyCostDefaults, previewCostDefaults } from "./lib/cost-defaults";
import {
  ORDER_INTAKE_STATUSES,
  clientOrderSubmissionSchema,
  createOrderLinkSchema,
  createSupplyPurchaseSchema,
  dismissAttentionSchema,
  ATTENTION_ISSUE_KEYS,
  attachPrintFileSchema,
  addPrintPlateBitsSchema,
  detachPrintFileSchema,
  updatePrintPlateBitStatusSchema,
  importOrderPartsSchema,
  updateOrderPartStatusSchema,
  adjustResinSealedSchema,
  assignPrinterProfileSchema,
  assignPlatePrinterSchema,
  advanceDealStageSchema,
  assignPrintFilePrinterSchema,
  createPrinterLifecycleEventSchema,
  createProductionFailureSchema,
  openResinBottleSchema,
  setActiveResinBottleSchema,
  updateDealCostsSchema,
  updateFulfillmentChecklistSchema,
  updatePrinterSchema,
  upsertResinProductSchema,
  costDefaultsApplySchema,
  costDefaultsPreviewSchema,
  upsertResinProfileSchema,
  reviewEditSchema,
  upsertKitSchema,
  intakeLineExtendedAmount,
  lineItemsForIntake,
  normalizeOrderLineKind,
  orderLineKindSkipsPlates,
  formatShippingStreetLine,
  type PrintFileCandidateDeal,
  type OrderIntakeLink,
  type OrderIntakeStatus,
  type PerformanceResponse,
} from "../shared/schema";
import { lookupReturningBuyer } from "./lib/buyers";
import { browseHubSpotContacts, getHubSpotContact } from "./lib/contacts";
import {
  advanceDealStage,
  assignPlateToPrinter,
  buildDealOpsDetail,
  fetchDealAssociatedContact,
  seedPrintDealCosts,
  updateDealCosts,
} from "./lib/deal-ops";
import { createProductionFailure, listProductionFailures, failureSummary } from "./lib/failures";
import {
  attachedShippingLabelDealIds,
  getFulfillmentChecklist,
  upsertFulfillmentChecklist,
  listExistingTrackingAttachments,
  type HubSpotShippingSync,
} from "./lib/fulfillment";
import { buildProductionQueue } from "./lib/production-queue";
import { buildResinReorderSuggestions } from "./lib/resin-reorder";
import {
  attachShippingLabelSchema,
  buildShipNotesFromLabel,
  extractShippingLabelFromPdf,
  matchShippingLabelToDeals,
} from "./lib/shipping-label";

const WEBHOOK_PATH = "/api/webhooks/hubspot";
const INTAKE_BUILD_ID = "intake-auth-v6-20260803";
const SLICE_LOG_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const printFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const extension = path.extname(file.originalname || "").toLowerCase() || ".ctb";
      const prefix = /\.log$/i.test(extension) ? "slice-log" : "ctb-upload";
      cb(null, `${prefix}-${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: PRINT_FILE_MAX_BYTES, files: 2 },
});

function isSliceLogUploadName(fileName: string): boolean {
  const base = path.basename(fileName || "").toLowerCase();
  return base === "slice.log" || /^slice(?:-.*)?\.log$/.test(base) || base.endsWith(".log");
}

/** Read Slice.log text; if oversized, keep the newest tail (Output lines land at the end). */
function readOptionalSliceLogUpload(file: Express.Multer.File | undefined): string | null {
  if (!file?.path) return null;
  try {
    const stat = fs.statSync(file.path);
    if (stat.size <= 0) return null;
    if (!isSliceLogUploadName(file.originalname) && path.extname(file.originalname).toLowerCase() !== ".log") {
      return null;
    }
    if (stat.size <= SLICE_LOG_UPLOAD_MAX_BYTES) {
      return fs.readFileSync(file.path, "utf8");
    }
    const fd = fs.openSync(file.path, "r");
    try {
      const start = stat.size - SLICE_LOG_UPLOAD_MAX_BYTES;
      const buffer = Buffer.alloc(SLICE_LOG_UPLOAD_MAX_BYTES);
      fs.readSync(fd, buffer, 0, SLICE_LOG_UPLOAD_MAX_BYTES, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extensionForSupplyUpload(file: Express.Multer.File): string {
  const fromName = path.extname(file.originalname || "").toLowerCase();
  if (fromName) return fromName;
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "text/csv") return ".csv";
  if (mime === "text/plain") return ".txt";
  if (mime === "text/html") return ".html";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return ".xlsx";
  if (mime === "application/pdf") return ".pdf";
  return ".bin";
}

const supplyInvoiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      cb(null, `supply-invoice-${crypto.randomUUID()}${extensionForSupplyUpload(file)}`);
    },
  }),
  limits: { fileSize: SUPPLY_INVOICE_MAX_BYTES, files: 1 },
});

const SHIPPING_LABEL_MAX_BYTES = 12 * 1024 * 1024;
const shippingLabelUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".pdf";
      cb(null, `shipping-label-${crypto.randomUUID()}${ext === ".pdf" ? ext : ".pdf"}`);
    },
  }),
  limits: { fileSize: SHIPPING_LABEL_MAX_BYTES, files: 1 },
});

function removeTempUpload(filePath: string | undefined): void {
  if (!filePath) return;
  fs.unlink(filePath, () => {
    /* best-effort cleanup */
  });
}

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

/** Optional multi-item payload for Manual Entry (mirrors Intake approve). */
function paidOrderLineItemsFrom(
  body: unknown,
): Array<{ productName: string; amount: string; kind: "print" | "shipping" | "fee" }> | null {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(record.lineItems)) return null;
  const lines = record.lineItems
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const productName = typeof row.productName === "string" ? row.productName.trim().slice(0, 180) : "";
      const amount = typeof row.amount === "string" ? row.amount.trim().slice(0, 40) : "";
      if (!productName && !amount) return null;
      return {
        productName,
        amount,
        kind: normalizeOrderLineKind(row.kind),
      };
    })
    .filter(
      (line): line is { productName: string; amount: string; kind: "print" | "shipping" | "fee" } =>
        Boolean(line),
    );
  return lines.length > 0 ? lines.slice(0, 20) : null;
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

function ownerDigestCronSecret(): string {
  return process.env.OWNER_DIGEST_CRON_SECRET?.trim() || "";
}

function providedOwnerDigestCronSecret(req: Request): string {
  const header = req.get("x-owner-digest-cron-secret") ?? "";
  const auth = req.get("authorization") ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const bodyValue =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).cronSecret
      : "";
  return normalizedAccessCode(header || bearer || (typeof bodyValue === "string" ? bodyValue : ""));
}

function rejectUnsecuredOwnerDigestCron(req: Request, res: Response): boolean {
  const expected = ownerDigestCronSecret();
  if (!expected) {
    res.status(503).json({ ok: false, error: "Owner digest cron secret is not configured" });
    return true;
  }
  const provided = providedOwnerDigestCronSecret(req);
  if (!provided || !timingSafeMatch(provided, expected)) {
    res.status(401).json({ ok: false, error: "Invalid owner digest cron secret" });
    return true;
  }
  return false;
}

async function loadTrackerAssistantContext(): Promise<TrackerAssistantContext> {
  const [deals, stages, hubspotPortalId] = await Promise.all([
    fetchPrintOrderDeals(),
    fetchPrintOrderPipelineStages(),
    fetchHubSpotPortalId(),
  ]);
  refreshPrintFileStagesFromHubSpot(deals, stages);
  const snapshot = buildPerformanceSnapshot({
    deals,
    stages,
    intakeCounts: orderLinkCounts(),
    supplySpend: buildSupplySpendSummary(),
    attachedPrintDealIds: attachedPrintFileDealIds(),
    shippingLabelDealIds: attachedShippingLabelDealIds(),
    hubspotPortalId,
    dismissedAttentionKeys: activeAttentionOverrideKeys(),
  });
  const awaitingLinks = listOrderLinks("awaiting_client").map((link) => ({
    id: link.id,
    internalLabel: link.internalLabel,
    itemDescription: link.itemDescription,
    agreedAmount: link.agreedAmount,
    expiresAt: link.expiresAt,
    status: link.status,
  }));
  const pendingLinks = listOrderLinks("pending_review").map((link) => ({
    id: link.id,
    internalLabel: link.internalLabel,
    itemDescription: link.itemDescription,
    agreedAmount: link.agreedAmount,
    clientFullName: link.clientFullName,
    status: link.status,
  }));
  return { snapshot, awaitingLinks, pendingLinks };
}

async function loadOwnerDigestContext(): Promise<OwnerDigestContext> {
  const base = await loadTrackerAssistantContext();
  ensureDefaultPrinters();
  ensureDefaultResinInventory();
  return {
    ...base,
    fleet: buildPrinterFleetSnapshot(),
    resin: buildResinInventorySnapshot(),
    recentPlates: listPrintFileRecords(200),
  };
}

function firstIssue(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "Some details are missing or invalid";
}

function stageIsClosed(stage: { metadata: Record<string, unknown> } | undefined): boolean {
  const value = stage?.metadata?.isClosed;
  return value === true || value === "true";
}

/** Map live HubSpot Print Orders → stage label / name for plate-history refresh. */
function livePrintOrderStageMap(
  deals: HubSpotDealRecord[],
  stages: HubSpotPipelineStage[],
): Map<string, { stage: string; dealName: string }> {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const map = new Map<string, { stage: string; dealName: string }>();
  for (const deal of deals) {
    const stageId = deal.properties.dealstage ?? "";
    const stage = stageById.get(stageId);
    map.set(deal.id, {
      stage: stage?.label || stageId || "No stage",
      dealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}`,
    });
  }
  return map;
}

function refreshPrintFileStagesFromHubSpot(
  deals: HubSpotDealRecord[],
  stages: HubSpotPipelineStage[],
): void {
  syncPrintFileDealStages(livePrintOrderStageMap(deals, stages));
}

/** The owner-side representation. `tokenHash` never leaves the server. */
function ownerLinkView(link: OrderIntakeLink): Omit<OrderIntakeLink, "tokenHash"> & {
  priorMatch: ReturnType<typeof findPriorClientDetails>;
} {
  const { tokenHash: _tokenHash, ...safe } = link;
  const submitted = link.status === "pending_review" || link.status === "created";
  return {
    ...safe,
    priorMatch: submitted
      ? findPriorClientDetails({
          username: link.clientUsername || link.buyerUsernameHint,
          email: link.clientEmail,
          excludeId: link.id,
        })
      : null,
  };
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
 * Maps a reviewed intake onto the paid-order draft plus one HubSpot deal per
 * commercial line item. Same Contact; N Deals for individual tracking.
 */
function draftsFromIntake(link: OrderIntakeLink): {
  draft: PaidOrderDraft;
  lineItems: Array<{ productName: string; amount: string; kind: "print" | "shipping" | "fee" }>;
  orderGroup: string;
} {
  const lines = lineItemsForIntake(link);
  const summary = [
    "Source: Facebook Marketplace one-time order form link.",
    `Internal reference: ${link.internalLabel}.`,
    lines.length > 1
      ? `Line items:\n${lines
          .map((line, index) => {
            const extended = intakeLineExtendedAmount(line);
            const kindLabel = orderLineKindSkipsPlates(line.kind) ? ` [${line.kind}]` : "";
            return `  ${index + 1}. ${line.description}${kindLabel}${
              line.quantity > 1 ? ` (qty ${line.quantity} @ $${line.amount})` : ""
            } — $${extended.toFixed(2)}`;
          })
          .join("\n")}`
      : `Agreed item: ${link.confirmedItem || lines[0]?.description || link.itemDescription}${
          (lines[0]?.quantity ?? link.quantity) > 1
            ? ` (qty ${lines[0]?.quantity ?? link.quantity})`
            : ""
        }.`,
    link.paymentMethod ? `Payment method: ${link.paymentMethod}.` : "",
    link.paymentReference ? `Payment reference: ${link.paymentReference}.` : "",
    link.clientPaymentConfirmed ? "Buyer confirmed payment on the client form." : "",
    "Owner verified payment before HubSpot creation.",
    link.shippingRequired ? "Shipping required." : "Local pickup / no shipping required.",
    link.clientNotes ? `Buyer notes: ${link.clientNotes}` : "",
    link.ownerNotes ? `Owner notes: ${link.ownerNotes}` : "",
    link.confirmedItem && lines.length > 1 ? `Buyer confirmation notes: ${link.confirmedItem}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const lineItems = lines.map((line) => {
    const quantity = Math.max(1, line.quantity || 1);
    return {
      productName: quantity > 1 ? `${line.description} (x${quantity})` : line.description,
      amount: intakeLineExtendedAmount(line).toFixed(2),
      kind: normalizeOrderLineKind(line.kind),
    };
  });

  const primary = lineItems[0] ?? {
    productName: link.confirmedItem || link.itemDescription,
    amount: link.agreedAmount,
    kind: "print" as const,
  };

  return {
    draft: {
      paymentConfirmed: true,
      fullName: link.clientFullName,
      marketplaceUsername: link.clientUsername || link.buyerUsernameHint,
      email: link.clientEmail,
      phone: link.clientPhone,
      address: link.shippingRequired
        ? formatShippingStreetLine(link.shippingStreet, link.shippingStreet2)
        : "",
      city: link.shippingRequired ? link.shippingCity : "",
      state: link.shippingRequired ? link.shippingState : "",
      postalCode: link.shippingRequired ? link.shippingPostalCode : "",
      country: link.shippingRequired ? link.shippingCountry || "United States" : "",
      productName: primary.productName,
      amount: primary.amount,
      conversationSummary: summary,
    },
    lineItems,
    orderGroup: link.internalLabel,
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
  // Local / flagged mock Messenger page for extension V1 testing.
  registerMessengerScanTestUi(app);

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
      storage: describeOrderLinksStorage(),
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
      ownerDigest: {
        telegramConfigured: telegramConfigured(),
        cronSecretConfigured: Boolean(ownerDigestCronSecret()),
        schedule: getOwnerDigestSchedule(),
      },
      healthNudge: {
        telegramConfigured: telegramConfigured(),
        schedule: getHealthNudgeSchedule(),
      },
      properties: {
        inputs: [...INPUT_PROPERTIES],
        outputs: [...OUTPUT_PROPERTIES],
      },
      audit: { retained: auditCount(), limit: AUDIT_LIMIT },
      serverTime: new Date().toISOString(),
    });
  });

  /** Cheap shared unlock probe for every Daily Work page. */
  app.get("/api/owner/session", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({
      ok: true,
      unlocked: true,
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
   * Owner-only returning-buyer lookup. Matches a Marketplace username to the
   * last submitted intake so a new private link can prefill contact/shipping.
   * Registered before `/api/order-links/:id` so "prior-client" is not treated as an id.
   */
  app.get("/api/order-links/prior-client", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const username = firstQueryValue(req.query?.username) ?? "";
    const email = firstQueryValue(req.query?.email) ?? "";
    return res.json({ ok: true, match: findPriorClientDetails({ username, email }) });
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
   * Prefill the supply form from a receipt/invoice file (PDF, CSV, Excel,
   * text, HTML, or photo). Does not create a purchase — the owner still reviews
   * and saves.
   */
  app.post(
    "/api/supplies/parse-invoice",
    (req: Request, res: Response, next) => {
      if (rejectUnsecuredIntake(req, res)) return;
      next();
    },
    supplyInvoiceUpload.single("file"),
    async (req: Request, res: Response) => {
      const file = req.file;
      if (!file?.path) {
        return res.status(400).json({
          ok: false,
          error: "Drop one receipt or invoice file to extract purchase fields",
        });
      }
      if (!isSupportedSupplyReceiptUpload(file)) {
        removeTempUpload(file.path);
        return res.status(400).json({
          ok: false,
          error:
            "Use a PDF, CSV, Excel, text, HTML, or photo/screenshot receipt so nomenclature, cost, and vendor can be extracted",
        });
      }

      try {
        const format = formatFromUpload(file);
        const parseName =
          path.extname(file.originalname || "")
            ? file.originalname
            : `receipt${extensionForSupplyUpload(file)}`;
        const parsed = await parseSupplyReceipt(file.path, parseName);
        return res.json({
          ok: true,
          fields: parsed.fields,
          warnings: parsed.warnings,
          pageCount: parsed.pageCount,
          format: parsed.format || format,
          maxUploadLabel: SUPPLY_INVOICE_MAX_LABEL,
        });
      } catch (error) {
        return res.status(400).json({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "The receipt could not be read. Enter the purchase manually.",
        });
      } finally {
        removeTempUpload(file.path);
      }
    },
  );

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
   * PARKED Kits API — UI route/nav removed. Live parts/QC is Orders Parts +
   * Prints plate bits. Keep these endpoints for stored kit JSON until Kits is
   * rebuilt as a thin UI over that path (or data is migrated away).
   */
  app.get("/api/kits", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({ ok: true, kits: listKitSummaries() });
  });

  app.get("/api/kits/:dealId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const result = getKitForDeal(dealId);
    return res.json({
      ok: true,
      kit: result.kit,
      summary: result.summary,
    });
  });

  app.put("/api/kits/:dealId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const parsed = upsertKitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = upsertKitForDeal(dealId, {
      kit: parsed.data.kit,
      dealName: parsed.data.kit.hubspotDealName || undefined,
    });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, kit: result.kit, summary: result.summary });
  });

  app.delete("/api/kits/:dealId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const deleted = deleteKitForDeal(dealId);
    return res.json({ ok: true, deleted });
  });

  /** Shop-floor production queue: next print, in production, ship-ready, blocked. */
  app.get("/api/production-queue", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      const [deals, stages, portalId] = await Promise.all([
        fetchPrintOrderDeals(),
        fetchPrintOrderPipelineStages(),
        fetchHubSpotPortalId(),
      ]);
      const attachedIds = attachedPrintFileDealIds();
      const snapshot = buildPerformanceSnapshot({
        deals,
        stages,
        attachedPrintDealIds: attachedIds,
        shippingLabelDealIds: attachedShippingLabelDealIds(),
        intakeCounts: orderLinkCounts(),
        supplySpend: buildSupplySpendSummary(),
        dismissedAttentionKeys: activeAttentionOverrideKeys(),
        hubspotPortalId: portalId,
      }) as PerformanceResponse;
      return res.json({ ok: true, ...buildProductionQueue(snapshot) });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not build production queue",
      });
    }
  });

  app.get("/api/deal-ops/:dealId", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const result = await buildDealOpsDetail(String(req.params.dealId || ""));
    if ("error" in result) {
      return res.status(result.status ?? 400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, ...result });
  });

  app.patch("/api/deal-ops/:dealId/costs", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = updateDealCostsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = await updateDealCosts(String(req.params.dealId || ""), parsed.data);
    if (!result.ok) {
      return res.status(result.status ?? 400).json({ ok: false, error: result.error });
    }
    return res.json(result);
  });

  app.post("/api/deal-ops/:dealId/stage", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = advanceDealStageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = await advanceDealStage(String(req.params.dealId || ""), parsed.data);
    if (!result.ok) {
      return res.status(result.status ?? 400).json({ ok: false, error: result.error });
    }
    return res.json(result);
  });

  app.get("/api/fulfillment/:dealId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    return res.json({ ok: true, checklist: getFulfillmentChecklist(dealId) });
  });

  app.patch("/api/fulfillment/:dealId", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    const parsed = updateFulfillmentChecklistSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = await upsertFulfillmentChecklist(dealId, parsed.data);
    if ("error" in result) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, checklist: result.checklist, hubspot: result.hubspot });
  });

  /**
   * Prefill tracking from a Pirate Ship / carrier label PDF.
   * Does not write HubSpot — owner confirms the matched Print Order next.
   */
  app.post(
    "/api/shipping-labels/parse",
    (req: Request, res: Response, next) => {
      if (rejectUnsecuredIntake(req, res)) return;
      next();
    },
    shippingLabelUpload.single("file"),
    async (req: Request, res: Response) => {
      const file = req.file;
      if (!file?.path) {
        return res.status(400).json({
          ok: false,
          error: "Drop one shipping label PDF to extract tracking",
        });
      }
      const mime = String(file.mimetype || "").toLowerCase();
      const name = String(file.originalname || "").toLowerCase();
      if (mime !== "application/pdf" && !name.endsWith(".pdf")) {
        removeTempUpload(file.path);
        return res.status(400).json({
          ok: false,
          error: "Use a PDF shipping label export from Pirate Ship or the carrier",
        });
      }

      try {
        const extracted = await extractShippingLabelFromPdf(file.path, file.originalname || "label.pdf");
        const [deals, stages, hubspotPortalId] = await Promise.all([
          fetchPrintOrderDeals(),
          fetchPrintOrderPipelineStages(),
          fetchHubSpotPortalId(),
        ]);
        const snapshot = buildPerformanceSnapshot({
          deals,
          stages,
          intakeCounts: orderLinkCounts(),
          supplySpend: buildSupplySpendSummary(),
          attachedPrintDealIds: attachedPrintFileDealIds(),
            shippingLabelDealIds: attachedShippingLabelDealIds(),
          dismissedAttentionKeys: activeAttentionOverrideKeys(),
          hubspotPortalId,
        });
        const candidates = matchShippingLabelToDeals(extracted.fields, [
          ...snapshot.activeDeals.map((deal) => ({ ...deal, closed: false })),
          ...(snapshot.closedDeals ?? []).map((deal) => ({ ...deal, closed: true })),
        ]);
        const alreadyAttachedRows = listExistingTrackingAttachments(
          extracted.fields.trackingNumber,
          deals,
        );
        const alreadyAttachedDealIds = alreadyAttachedRows.map((row) => row.dealId);
        const alreadyAttached = alreadyAttachedRows[0] ?? null;
        const attachedDealName =
          alreadyAttached == null
            ? null
            : snapshot.activeDeals.find((deal) => deal.dealId === alreadyAttached.dealId)?.dealName ??
              snapshot.closedDeals?.find((deal) => deal.dealId === alreadyAttached.dealId)?.dealName ??
              deals.find((deal) => deal.id === alreadyAttached.dealId)?.properties.dealname ??
              null;
        return res.json({
          ok: true,
          fileName: file.originalname || "label.pdf",
          pageCount: extracted.pageCount,
          fields: extracted.fields,
          suggestedNotes: buildShipNotesFromLabel(extracted.fields),
          matches: candidates,
          hubspotPortalId,
          alreadyAttachedDealIds,
          alreadyAttached: alreadyAttached
            ? {
                dealId: alreadyAttached.dealId,
                dealName: attachedDealName ? String(attachedDealName) : null,
                trackingNumber: alreadyAttached.trackingNumber,
                notes: alreadyAttached.notes,
                source: alreadyAttached.source,
                updatedAt: alreadyAttached.updatedAt,
              }
            : null,
        });
      } catch (error) {
        return res.status(400).json({
          ok: false,
          error: error instanceof Error ? error.message : "Could not read that shipping label PDF",
        });
      } finally {
        removeTempUpload(file.path);
      }
    },
  );

  /** Confirm label → write tracking (+ optional postage) onto one or more Print Orders. */
  app.post("/api/shipping-labels/attach", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = attachShippingLabelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const input = parsed.data;
    const notesBase = input.notes.trim();
    const dealIds = input.dealIds;
    const sharedNote =
      dealIds.length > 1
        ? `${notesBase}${notesBase ? " · " : ""}Shared tracking across ${dealIds.length} orders`
            .trim()
            .slice(0, 2_000)
        : notesBase;

    const alreadyOn = listExistingTrackingAttachments(input.trackingNumber);
    const alreadyOnSelected = alreadyOn.filter((row) => dealIds.includes(row.dealId));
    const toAttach = dealIds.filter((id) => !alreadyOn.some((row) => row.dealId === id));

    if (toAttach.length === 0) {
      const primary = alreadyOnSelected[0] ?? alreadyOn[0]!;
      const contact = await fetchDealAssociatedContact(primary.dealId);
      return res.json({
        ok: true,
        duplicate: true,
        message:
          dealIds.length > 1
            ? "This tracking is already on every selected Print Order — nothing else to do."
            : "This tracking is already attached to that Print Order — nothing else to do.",
        attachedDealIds: [],
        skippedDealIds: dealIds,
        checklist: getFulfillmentChecklist(primary.dealId),
        hubspot: null,
        costs: null,
        costsError: null,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
        },
        alreadyAttached: {
          dealId: primary.dealId,
          trackingNumber: primary.trackingNumber,
          notes: primary.notes,
          source: primary.source,
          updatedAt: primary.updatedAt,
        },
      });
    }

    const attachedDealIds: string[] = [];
    let primaryChecklist: ReturnType<typeof getFulfillmentChecklist> | null = null;
    let primaryHubspot: HubSpotShippingSync | null = null;
    let costs: Awaited<ReturnType<typeof updateDealCosts>> | null = null;
    const postage = input.postageUsd.replace(/[$,\s]/g, "").trim();

    for (let index = 0; index < toAttach.length; index += 1) {
      const dealId = toAttach[index]!;
      const fulfillment = await upsertFulfillmentChecklist(dealId, {
        trackingNumber: input.trackingNumber,
        trackingPasted: true,
        labelBought: input.labelBought,
        packingDone: input.packingDone,
        notes: sharedNote,
        liveWrite: input.liveWrite !== false,
      });
      if ("error" in fulfillment) {
        return res.status(400).json({
          ok: false,
          error: fulfillment.error,
          attachedDealIds,
          failedDealId: dealId,
        });
      }
      attachedDealIds.push(dealId);
      if (!primaryChecklist) {
        primaryChecklist = fulfillment.checklist;
        primaryHubspot = fulfillment.hubspot;
      }

      // Copy known postage to every attached order only when that deal's field
      // is blank. This also seeds the $0 absorbed labor/free USPS packaging.
      const seeded = await seedPrintDealCosts(dealId, {
        postage,
        liveWrite: input.liveWrite !== false,
      });
      if (index === 0) {
        costs = seeded;
      }
    }

    const primaryDealId = attachedDealIds[0]!;
    const contact = await fetchDealAssociatedContact(primaryDealId);

    return res.json({
      ok: true,
      attachedDealIds,
      skippedDealIds: alreadyOnSelected.map((row) => row.dealId),
      checklist: primaryChecklist,
      hubspot: primaryHubspot,
      costs: costs && costs.ok ? costs.costs : null,
      costsError: costs && !costs.ok ? costs.error : null,
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
      },
    });
  });

  /** HubSpot contact email/name for a Print Order (Labels draft → mailto). */
  app.get("/api/shipping-labels/contact/:dealId", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    try {
      const contact = await fetchDealAssociatedContact(dealId);
      return res.json({
        ok: true,
        dealId,
        contact: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
        },
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load HubSpot contact email",
      });
    }
  });

  app.post("/api/plates/assign-printer", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = assignPlatePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = assignPlateToPrinter(parsed.data);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json(result);
  });

  app.get("/api/failures", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({ ok: true, failures: listProductionFailures(50).map(failureSummary) });
  });

  app.post("/api/failures", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = createProductionFailureSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const row = createProductionFailure(parsed.data);
    return res.status(201).json({ ok: true, failure: failureSummary(row) });
  });

  app.get("/api/resin-reorder", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      ensureDefaultResinInventory();
      const snapshot = buildResinInventorySnapshot();
      return res.json({ ok: true, ...buildResinReorderSuggestions(snapshot) });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not compute resin reorder cues",
      });
    }
  });

  /** Returning buyer prefill from HubSpot contact + local intake history. */
  app.post("/api/buyers/lookup", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const email =
      req.body && typeof req.body === "object" && typeof (req.body as { email?: unknown }).email === "string"
        ? (req.body as { email: string }).email
        : "";
    if (!email.trim() || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Enter a buyer email to look up." });
    }
    try {
      const profile = await lookupReturningBuyer(email);
      return res.json({ ok: true, buyer: profile });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Buyer lookup failed",
      });
    }
  });

  /** Browse / search HubSpot contacts for the Clients page. */
  app.get("/api/contacts", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 40;
    try {
      const result = await browseHubSpotContacts(q, limitRaw);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load HubSpot contacts",
      });
    }
  });

  app.get("/api/contacts/:id", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      const result = await getHubSpotContact(String(req.params.id ?? ""));
      if (!result.contact) return res.status(404).json({ ok: false, error: "Contact not found" });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(error instanceof HubSpotError ? error.status : 500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load that HubSpot contact",
      });
    }
  });

  /** Sealed stock + open bottles + per-bottle economics from plate consumption. */
  app.get("/api/resin-inventory", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      ensureDefaultResinInventory();
      return res.json({ ok: true, ...buildResinInventorySnapshot() });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load resin inventory",
      });
    }
  });

  app.put("/api/resin-inventory/products", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = upsertResinProductSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    try {
      const product = upsertResinProduct(parsed.data);
      return res.json({ ok: true, product, ...buildResinInventorySnapshot() });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not save resin product",
      });
    }
  });

  app.post("/api/resin-inventory/products/:id/adjust-sealed", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid resin product" });
    }
    const parsed = adjustResinSealedSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const product = adjustSealedStock(productId, parsed.data);
    if (!product) return res.status(404).json({ ok: false, error: "That resin product was not found" });
    return res.json({ ok: true, product, ...buildResinInventorySnapshot() });
  });

  app.post("/api/resin-inventory/open-bottle", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = openResinBottleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    try {
      const opened = openResinBottle(parsed.data);
      if (!opened) return res.status(404).json({ ok: false, error: "That resin product was not found" });
      return res.status(201).json({
        ok: true,
        ...opened,
        ...buildResinInventorySnapshot(),
        message: `Opened one bottle. Sealed stock is now ${opened.product.sealedCount}.`,
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not open a bottle",
      });
    }
  });

  app.post("/api/resin-inventory/set-active", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = setActiveResinBottleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    try {
      const bottle = setActiveResinBottle(parsed.data.bottleId);
      if (!bottle) return res.status(404).json({ ok: false, error: "That bottle was not found" });
      return res.json({ ok: true, bottle, ...buildResinInventorySnapshot() });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not set the active bottle",
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
      const [deals, stages, hubspotPortalId] = await Promise.all([
        fetchPrintOrderDeals(),
        fetchPrintOrderPipelineStages(),
        fetchHubSpotPortalId(),
      ]);
      refreshPrintFileStagesFromHubSpot(deals, stages);
      return res.json(
        buildPerformanceSnapshot({
          deals,
          stages,
          intakeCounts: orderLinkCounts(),
          supplySpend: buildSupplySpendSummary(),
          attachedPrintDealIds: attachedPrintFileDealIds(),
          shippingLabelDealIds: attachedShippingLabelDealIds(),
          dismissedAttentionKeys: activeAttentionOverrideKeys(),
          hubspotPortalId,
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

  /** Skip / dismiss one attention alert for an open deal (e.g. legacy order without plates). */
  app.post("/api/attention/dismiss", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = dismissAttentionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const override = dismissAttentionAlert(parsed.data);
    return res.status(201).json({ ok: true, override });
  });

  app.delete("/api/attention/dismiss/:dealId/:issueKey", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId ?? "").trim();
    const issueKey = String(req.params.issueKey ?? "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId) || !(ATTENTION_ISSUE_KEYS as readonly string[]).includes(issueKey)) {
      return res.status(400).json({ ok: false, error: "Choose a valid alert to restore" });
    }
    const cleared = clearAttentionOverride(dealId, issueKey as (typeof ATTENTION_ISSUE_KEYS)[number]);
    return res.json({ ok: true, cleared });
  });

  /**
   * Owner-only, read-only tracker assistant. Uses the same live snapshot as
   * Performance / Today’s work. Never writes to HubSpot.
   */
  app.post("/api/tracker-assistant", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const question =
      req.body && typeof req.body === "object" && typeof (req.body as { question?: unknown }).question === "string"
        ? String((req.body as { question: string }).question)
        : "";

    try {
      const ctx = await loadTrackerAssistantContext();
      const answer = await answerTrackerQuestion(question, ctx);
      return res.json(answer);
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not ask the tracker",
      });
    }
  });

  /**
   * Owner-only: send the live tracker briefing to Telegram immediately.
   * Does not require the daily schedule; useful for testing from the dashboard.
   */
  app.post("/api/owner-digest/send", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    if (!telegramConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the host.",
      });
    }

    try {
      const ctx = await loadOwnerDigestContext();
      const result = await sendOwnerDigest(ctx, process.env, {
        title: "Print Ops — briefing (manual)",
        force: true,
      });
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      if (result.skipped) {
        return res.json({ ok: true, skipped: true, reason: result.reason });
      }
      return res.json({
        ok: true,
        channel: result.channel,
        messageId: result.messageId,
        preview: result.text.slice(0, 500),
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not send owner digest",
      });
    }
  });

  /**
   * Cron / scheduler entrypoint. Secured by OWNER_DIGEST_CRON_SECRET
   * (Authorization: Bearer … or x-owner-digest-cron-secret). Skips if already
   * sent today unless { "force": true }.
   */
  app.post("/api/cron/owner-digest", async (req: Request, res: Response) => {
    if (rejectUnsecuredOwnerDigestCron(req, res)) return;
    if (!telegramConfigured()) {
      return res.status(503).json({ ok: false, error: "Telegram is not configured" });
    }

    const force =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as { force?: unknown }).force === true
        : false;

    try {
      const ctx = await loadOwnerDigestContext();
      const result = await sendOwnerDigest(ctx, process.env, {
        title: "Print Ops — morning briefing",
        force,
      });
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      if (result.skipped) {
        return res.json({ ok: true, skipped: true, reason: result.reason });
      }
      return res.json({
        ok: true,
        skipped: false,
        channel: result.channel,
        messageId: result.messageId,
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not run owner digest cron",
      });
    }
  });

  // Optional in-process daily schedule (OWNER_DIGEST_SCHEDULE_ENABLED=true).
  
  /**
   * Owner-only: send a health-check nudge (missing plates / costs / stale / intake).
   * Skips Telegram when the shop is clear unless { "force": true }.
   */
  app.post("/api/health-nudge/send", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    if (!telegramConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the host.",
      });
    }

    const force =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as { force?: unknown }).force === true
        : false;

    try {
      const ctx = await loadTrackerAssistantContext();
      const result = await sendHealthNudge(ctx, process.env, {
        title: "Print Ops — health check (manual)",
        force,
      });
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      if (result.skipped) {
        return res.json({
          ok: true,
          skipped: true,
          reason: result.reason,
          fingerprint: result.fingerprint,
          preview: result.text?.slice(0, 500),
        });
      }
      return res.json({
        ok: true,
        channel: result.channel,
        messageId: result.messageId,
        fingerprint: result.fingerprint,
        preview: result.text.slice(0, 500),
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not send health nudge",
      });
    }
  });

  /**
   * Cron / scheduler entrypoint for health nudges. Reuses OWNER_DIGEST_CRON_SECRET
   * (Authorization: Bearer … or x-owner-digest-cron-secret).
   */
  app.post("/api/cron/health-nudge", async (req: Request, res: Response) => {
    if (rejectUnsecuredOwnerDigestCron(req, res)) return;
    if (!telegramConfigured()) {
      return res.status(503).json({ ok: false, error: "Telegram is not configured" });
    }

    const force =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as { force?: unknown }).force === true
        : false;

    try {
      const ctx = await loadTrackerAssistantContext();
      const result = await sendHealthNudge(ctx, process.env, {
        title: "Print Ops — health check",
        force,
      });
      if (!result.ok) {
        return res.status(502).json({ ok: false, error: result.error });
      }
      if (result.skipped) {
        return res.json({
          ok: true,
          skipped: true,
          reason: result.reason,
          fingerprint: result.fingerprint,
        });
      }
      return res.json({
        ok: true,
        skipped: false,
        channel: result.channel,
        messageId: result.messageId,
        fingerprint: result.fingerprint,
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not run health nudge cron",
      });
    }
  });

startOwnerDigestScheduler(loadOwnerDigestContext, process.env, (message) => {
    console.log(`${new Date().toISOString()} [owner-digest] ${message}`);
  });

  startHealthNudgeScheduler(loadTrackerAssistantContext, process.env, (message) => {
    console.log(`${new Date().toISOString()} [health-nudge] ${message}`);
  });

  /**
   * Owner-only view for attaching production metrics from a sliced CTB file.
   * The HubSpot portion is read-only here. A later explicit attach action is
   * required before any CRM property is written.
   */
  app.get("/api/prints", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const includeAttached = firstQueryValue(req.query?.includeAttached) === "true";
    const previewDealId = firstQueryValue(req.query?.previewDealId)?.trim() ?? "";
    const previewAnalysisId = firstQueryValue(req.query?.previewAnalysisId)?.trim() ?? "";

    try {
      const [deals, stages] = await Promise.all([
        fetchPrintOrderDeals({ bypassCache: true }),
        fetchPrintOrderPipelineStages(),
      ]);
      refreshPrintFileStagesFromHubSpot(deals, stages);
      const stageById = new Map(stages.map((stage) => [stage.id, stage]));
      const boards = groupPrintFileRecordsByDeal();
      const boardByDealId = new Map(boards.map((board) => [board.dealId, board]));
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
            plateCount: boardByDealId.get(deal.id)?.plateCount ?? 0,
          };
        })
        .filter((deal) => includeAttached || !deal.hasPrintFile)
        .sort((a, b) => a.stage.localeCompare(b.stage) || a.dealName.localeCompare(b.dealName));

      const records = listPrintFileRecords();
      const bitsByRecord = listBitsForRecords(records.map((row) => row.id));
      const recordsWithBits = records.map((record) => {
        const bits = bitsByRecord.get(record.id) ?? [];
        return {
          ...record,
          bits,
          bitSummary: summarizeBits(bits),
        };
      });
      const staged = previewAnalysisId ? getStagedPrintFile(previewAnalysisId) : null;
      const attachPreview =
        previewDealId && deals.some((deal) => deal.id === previewDealId)
          ? previewAttachSummary(previewDealId, staged?.metrics ?? null)
          : null;

      return res.json({
        ok: true,
        candidates,
        records: recordsWithBits,
        boards,
        includeAttached,
        lastAttachedDealId: boards[0]?.dealId ?? null,
        attachPreview,
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

  /** Add .stl part names the operator says were on this attached plate. */
  app.post("/api/prints/:recordId/bits", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const recordId = Number(req.params.recordId);
    if (!Number.isInteger(recordId) || recordId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid plate." });
    }
    const parsed = addPrintPlateBitsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const parts = [
      ...(parsed.data.parts || []),
      ...(parsed.data.fileNames || []).map((fileName) => ({ fileName })),
    ];
    const result = addBitsToRecord(recordId, parts);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json({
      ok: true,
      bits: result.bits,
      added: result.added,
      bitSummary: summarizeBits(result.bits),
    });
  });

  app.patch("/api/prints/:recordId/bits/:bitId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const recordId = Number(req.params.recordId);
    const bitId = Number(req.params.bitId);
    if (!Number.isInteger(recordId) || recordId < 1 || !Number.isInteger(bitId) || bitId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid plate part." });
    }
    const parsed = updatePrintPlateBitStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = updateBitStatus(recordId, bitId, parsed.data.status);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    const bits = listBitsForRecords([recordId]).get(recordId) ?? [];
    return res.json({ ok: true, bit: result.bit, bits, bitSummary: summarizeBits(bits) });
  });

  app.delete("/api/prints/:recordId/bits/:bitId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const recordId = Number(req.params.recordId);
    const bitId = Number(req.params.bitId);
    if (!Number.isInteger(recordId) || recordId < 1 || !Number.isInteger(bitId) || bitId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid plate part." });
    }
    const result = deleteBit(recordId, bitId);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    const bits = listBitsForRecords([recordId]).get(recordId) ?? [];
    return res.json({ ok: true, deleted: result.deleted, bits, bitSummary: summarizeBits(bits) });
  });

  /** Master parts checklist for a Print Order (Orders board → Parts). */
  app.get("/api/order-parts/summaries", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    return res.json({ ok: true, summaries: listOrderPartSummaries() });
  });

  app.get("/api/orders/:dealId/parts", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const view = getOrderPartsView(dealId);
    return res.json({ ok: true, ...view });
  });

  app.post("/api/orders/:dealId/parts/import", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const parsed = importOrderPartsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = importOrderParts(dealId, parsed.data);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json({
      ok: true,
      dealId,
      parts: result.parts,
      added: result.added,
      summary: result.summary,
    });
  });

  app.patch("/api/orders/:dealId/parts/:partId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    const partId = Number(req.params.partId);
    if (!/^[0-9]{1,20}$/.test(dealId) || !Number.isInteger(partId) || partId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid order part." });
    }
    const parsed = updateOrderPartStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = updateOrderPartStatus(dealId, partId, parsed.data.status);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
    return res.json({
      ok: true,
      dealId,
      part: result.part,
      parts: result.parts,
      summary: result.summary,
    });
  });

  app.delete("/api/orders/:dealId/parts/:partId", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    const partId = Number(req.params.partId);
    if (!/^[0-9]{1,20}$/.test(dealId) || !Number.isInteger(partId) || partId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid order part." });
    }
    const result = deleteOrderPart(dealId, partId);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json({
      ok: true,
      dealId,
      deleted: result.deleted,
      parts: result.parts,
      summary: result.summary,
    });
  });

  app.delete("/api/orders/:dealId/parts", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const dealId = String(req.params.dealId || "").trim();
    if (!/^[0-9]{1,20}$/.test(dealId)) {
      return res.status(400).json({ ok: false, error: "Select a valid Print Order." });
    }
    const deleted = clearOrderParts(dealId);
    return res.json({
      ok: true,
      dealId,
      deleted,
      parts: [],
      summary: summarizeOrderParts([]),
    });
  });

  /**
   * Slice bytes only exist for the duration of this request. Optional
   * `sliceLog` is a Blueprint Slice.log used to recover sealed ULTX estimates.
   * Mega/Mighty 8K CTBs may send only a sampled prefix (`mode=ctb-prefix` +
   * `fullFileSize`) so reverse proxies do not time out with "upstream error".
   * The response contains a short-lived analysis ID; no plate binary is kept.
   */
  app.post(
    "/api/prints/analyze",
    (req: Request, res: Response, next) => {
      if (rejectUnsecuredIntake(req, res)) return;
      next();
    },
    printFileUpload.fields([
      { name: "file", maxCount: 1 },
      { name: "sliceLog", maxCount: 1 },
    ]),
    (req: Request, res: Response) => {
      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const file = files?.file?.[0];
      const sliceLogFile = files?.sliceLog?.[0];
      if (!file?.path) {
        removeTempUpload(sliceLogFile?.path);
        return res.status(400).json({
          ok: false,
          error: "Choose one Chitubox .ctb or HeyGears .ultx slice file to analyze",
        });
      }
      if (!isSupportedSliceFileName(file.originalname)) {
        removeTempUpload(file.path);
        removeTempUpload(sliceLogFile?.path);
        return res.status(400).json({
          ok: false,
          error: "Only Chitubox .ctb and HeyGears .ultx slice files can be analyzed here",
        });
      }

      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const mode = typeof body.mode === "string" ? body.mode.trim() : "";
      const fullFileSizeRaw =
        typeof body.fullFileSize === "string"
          ? body.fullFileSize
          : typeof body.fullFileSize === "number"
            ? String(body.fullFileSize)
            : "";
      const fullFileSize = Number(fullFileSizeRaw);

      try {
        const sliceLogText = readOptionalSliceLogUpload(sliceLogFile);
        if (sliceLogFile?.path && !sliceLogText) {
          return res.status(400).json({
            ok: false,
            error: "Slice.log upload was empty or not a .log file. Re-import Blueprint logs and try again.",
          });
        }
        const staged =
          mode === "ctb-prefix"
            ? stageCtbFromPrefix(file.originalname, file.path, fullFileSize)
            : stagePrintFileFromPath(file.originalname, file.path, { sliceLogText });
        const fleet = ensureDefaultPrinters().filter((printer) => printer.status !== "retired");
        const matchedPrinterId = matchPrinterId(staged.metrics.printerProfile, fleet);
        // Shared model names (Mighty 8K without NEWX#) do not auto-match after
        // matchTokens was tightened — operator must pick the physical unit.
        const requiresPrinterChoice = matchedPrinterId == null;
        return res.status(201).json({
          ok: true,
          ...staged,
          uploadMode: mode === "ctb-prefix" ? "ctb-prefix" : "full",
          sliceLogApplied: Boolean(sliceLogText),
          printerMatch: {
            matchedPrinterId,
            requiresPrinterChoice,
            sharedModelProfile: isSharedModelPrinterProfile(staged.metrics.printerProfile, fleet),
            slicerProfile: staged.metrics.printerProfile,
            printers: fleet.map((printer) => ({
              id: printer.id,
              name: printer.name,
              model: printer.model,
            })),
          },
        });
      } catch (error) {
        const message =
          error instanceof CtbParseError || error instanceof UltxParseError
            ? error.message
            : "The slice file could not be read. Re-export it from Chitubox or Blueprint Studio and try again.";
        return res.status(400).json({ ok: false, error: message });
      } finally {
        removeTempUpload(file.path);
        removeTempUpload(sliceLogFile?.path);
      }
    },
  );

  /**
   * Fleet usage + lifecycle for each named printer. Plate hours/layers/resin
   * roll up from attached CTB/ULTX metrics matched by machine name aliases.
   */
  app.get("/api/printers", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    try {
      ensureDefaultPrinters();
      return res.json({ ok: true, ...buildPrinterFleetSnapshot() });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not load printer fleet",
      });
    }
  });

  app.patch("/api/printers/:id", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const printerId = Number(req.params.id);
    if (!Number.isInteger(printerId) || printerId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    }
    const parsed = updatePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const printer = updatePrinter(printerId, parsed.data);
    if (!printer) return res.status(404).json({ ok: false, error: "That printer was not found" });
    return res.json({ ok: true, printer, fleet: buildPrinterFleetSnapshot() });
  });

  app.post("/api/printers/:id/events", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const printerId = Number(req.params.id);
    if (!Number.isInteger(printerId) || printerId < 1) {
      return res.status(400).json({ ok: false, error: "Choose a valid printer" });
    }
    if (!getPrinter(printerId)) {
      return res.status(404).json({ ok: false, error: "That printer was not found" });
    }
    const parsed = createPrinterLifecycleEventSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const event = addPrinterLifecycleEvent(printerId, parsed.data);
    if (!event) return res.status(404).json({ ok: false, error: "That printer was not found" });
    return res.status(201).json({ ok: true, event, fleet: buildPrinterFleetSnapshot() });
  });

  /**
   * Manually map an unmatched CTB/ULTX machine-name string onto a fleet printer.
   * Unique labels become a lasting map; shared model names (Mighty 8K) only stamp
   * existing plates so NEWX1/2/3 are not collapsed onto one machine.
   */
  app.post("/api/printers/assign-profile", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = assignPrinterProfileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = assignPrinterProfile(parsed.data);
    if (!result) {
      return res.status(404).json({ ok: false, error: "That fleet printer was not found" });
    }
    const label = parsed.data.profile.trim();
    const message = result.map
      ? `Assigned “${label}” to that printer. Matching plates now count toward its usage.`
      : `Assigned ${result.stamped} existing plate(s) with “${label}” to that printer. Future plates still need a per-plate choice (shared model name).`;
    return res.json({
      ok: true,
      map: result.map,
      stamped: result.stamped,
      fleet: result.fleet,
      message,
    });
  });

  /** Assign one historical plate to a physical fleet printer (per-plate, not global). */
  app.post("/api/printers/assign-plate", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = assignPrintFilePrinterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const result = assignPrintFilePrinter(parsed.data);
    if (!result) {
      return res.status(404).json({ ok: false, error: "That plate or fleet printer was not found" });
    }
    return res.json({
      ok: true,
      record: result.record,
      fleet: result.fleet,
      message: "Plate assigned to that printer. Its hours now count in the fleet breakdown.",
    });
  });

  /**
   * Reapply safe defaults to historical attached plates. This only fills blank
   * HubSpot cost fields from local plate totals; it never invents postage.
   */
  app.post("/api/prints/seed-costs", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;

    const estimates = new Map<string, { total: number; hasEstimate: boolean }>();
    for (const record of listPrintFileRecords(500)) {
      const summary = estimates.get(record.hubspotDealId) ?? { total: 0, hasEstimate: false };
      const resinCost = Number(record.resinCost);
      if (Number.isFinite(resinCost) && resinCost >= 0) {
        summary.total += resinCost;
        summary.hasEstimate = true;
      }
      estimates.set(record.hubspotDealId, summary);
    }

    const results = [];
    for (const [dealId, estimate] of estimates) {
      const seeded = await seedPrintDealCosts(dealId, {
        materialEstimate: estimate.hasEstimate ? estimate.total : null,
        liveWrite: true,
      });
      results.push({
        dealId,
        status: seeded === null ? "current" : seeded.ok ? (seeded.dryRun ? "dry-run" : "seeded") : "error",
        error: seeded && !seeded.ok ? seeded.error : undefined,
      });
    }
    return res.json({
      ok: true,
      processed: results.length,
      seeded: results.filter((result) => result.status === "seeded").length,
      results,
    });
  });

  /**
   * Attach a CTB/ULTX plate to an explicit order. HubSpot succeeds first; only
   * then is the durable local production record created.
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

      const fleet = ensureDefaultPrinters();
      const autoMatchedId = matchPrinterId(staged.metrics.printerProfile, fleet);
      const requestedPrinterId = parsed.data.printerId ?? null;
      if (requestedPrinterId != null && !getPrinter(requestedPrinterId)) {
        return res.status(404).json({ ok: false, error: "That fleet printer was not found" });
      }
      if (autoMatchedId == null && requestedPrinterId == null) {
        return res.status(400).json({
          ok: false,
          error:
            "Choose which physical printer ran this plate. Chitubox only embedded a shared model name (e.g. Mighty 8K), not NEWX1/NEWX2/NEWX3.",
        });
      }
      const fleetPrinterId = requestedPrinterId ?? autoMatchedId;

      const attachedAt = new Date().toISOString();
      const summary = buildPrintFileOrderSummary(deal.id, staged.metrics);
      await patchDealPrintFileMetrics(parsed.data.dealId, summary, attachedAt);
      const seededCosts = await seedPrintDealCosts(deal.id, {
        materialEstimate: summary.totalResinCost,
        liveWrite: true,
      });
      if (seededCosts && !seededCosts.ok) {
        return res.status(seededCosts.status ?? 502).json(seededCosts);
      }
      const record = createPrintFileRecord({
        analysisId: parsed.data.analysisId,
        hubspotDealId: deal.id,
        hubspotDealName: deal.properties.dealname?.trim() || `Print Order ${deal.id}`,
        dealStage: stage?.label || deal.properties.dealstage || "No stage",
        metrics: staged.metrics,
        fleetPrinterId,
      });
      markPrintFileAnalysisUsed(parsed.data.analysisId);

      let resinConsumption: {
        bottleId: number;
        consumedMassG: number;
        remainingMassG: number;
      } | null = null;
      try {
        const consumed = consumeResinForAttachedPlate({
          record,
          metrics: staged.metrics,
          dealAmount: deal.properties.amount ?? null,
        });
        if (consumed) {
          resinConsumption = {
            bottleId: consumed.bottle.id,
            consumedMassG: consumed.consumedMassG,
            remainingMassG: consumed.remainingMassG,
          };
        }
      } catch {
        /* Inventory should never block plate attach. */
      }

      return res.status(201).json({
        ok: true,
        record,
        summary,
        resinConsumption,
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

  /**
   * Explicitly detach one plate, then rebuild (or clear) only HubSpot's
   * production-planning fields. Actual cost fields remain untouched.
   */
  app.post("/api/prints/detach", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = detachPrintFileSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }
    const existing = getPrintFileRecord(parsed.data.recordId);
    if (!existing) return res.status(404).json({ ok: false, error: "That plate record was not found" });

    try {
      const remaining = buildPrintFileOrderSummaryFromRecords(existing.hubspotDealId, {
        excludeRecordId: existing.id,
      });
      if (remaining) {
        await patchDealPrintFileMetrics(existing.hubspotDealId, remaining, new Date().toISOString());
      } else {
        await clearDealPrintFileMetrics(existing.hubspotDealId);
      }

      // Preserve plate-bit/order-part consistency when the plate is removed.
      for (const bit of listBitsForRecord(existing.id)) {
        deleteBit(existing.id, bit.id);
      }
      deletePrintFileRecord(existing.id);
      return res.json({
        ok: true,
        removed: existing,
        summary: remaining,
        remainingPlateCount: remaining?.plateCount ?? 0,
        message: remaining
          ? `Plate detached. HubSpot totals rebuilt for ${remaining.plateCount} remaining plate${remaining.plateCount === 1 ? "" : "s"}.`
          : "Last plate detached. HubSpot print planning fields were cleared.",
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not update HubSpot after detaching the plate",
      });
    }
  });

  /**
   * Preview proposed material/labor/packaging/shipping values before any write.
   * Owner-gated. Never writes HubSpot.
   */
  app.post("/api/prints/cost-defaults/preview", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = costDefaultsPreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }

    try {
      const preview = await previewCostDefaults({
        dealId: parsed.data.dealId,
        laborRatePerHour: parsed.data.laborRatePerHour ?? undefined,
        packagingAmount: parsed.data.packagingAmount ?? undefined,
        shippingAmount: parsed.data.shippingAmount,
        includeMaterial: parsed.data.includeMaterial,
        includeLabor: parsed.data.includeLabor,
        includePackaging: parsed.data.includePackaging,
        includeShipping: parsed.data.includeShipping,
        overwriteExisting: parsed.data.overwriteExisting,
      });
      return res.json({ ok: true, preview });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not preview cost defaults",
      });
    }
  });

  /**
   * Confirm-write cost defaults onto a deal, then recalculate profit outputs.
   * Requires confirm:true. Never auto-runs from attach or intake.
   */
  app.post("/api/prints/cost-defaults/apply", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const parsed = costDefaultsApplySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: firstIssue(parsed.error) });
    }

    try {
      const result = await applyCostDefaults({
        dealId: parsed.data.dealId,
        confirm: true,
        laborRatePerHour: parsed.data.laborRatePerHour ?? undefined,
        packagingAmount: parsed.data.packagingAmount ?? undefined,
        shippingAmount: parsed.data.shippingAmount,
        includeMaterial: parsed.data.includeMaterial,
        includeLabor: parsed.data.includeLabor,
        includePackaging: parsed.data.includePackaging,
        includeShipping: parsed.data.includeShipping,
        overwriteExisting: parsed.data.overwriteExisting,
      });
      return res.json({
        ok: true,
        ...result,
        message: `Wrote ${result.written.length} cost field${result.written.length === 1 ? "" : "s"} to HubSpot${result.recalculated ? " and recalculated profit" : ""}.`,
      });
    } catch (error) {
      const status = error instanceof HubSpotError ? error.status : 502;
      return res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not apply cost defaults",
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

    const { draft, lineItems, orderGroup } = draftsFromIntake(link);
    const validationError = validatePaidOrderDraft(draft);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    try {
      const result = await createPaidOrder(draft, { lineItems, orderGroup });
      const updated = markOrderLinkCreated(link.id, {
        contactId: result.contactId,
        deals: result.deals,
      });
      return res.status(201).json({
        ok: true,
        result,
        link: updated ? ownerLinkView(updated) : null,
        message:
          result.deals.length > 1
            ? `Created ${result.deals.length} Print Orders on one Contact — attach plates per item next.`
            : `Created Contact and Print Order — attach the first plate next.`,
      });
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
   * Public: returning-buyer contact/shipping for a valid unused token, using
   * the email or username the buyer typed. Never a directory search.
   */
  app.post("/api/client-order/saved-details", (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const token = tokenFromBody(req.body);
    if (!token) return res.status(404).json({ ok: false, reason: "invalid" });
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
    const result = lookupClientSavedDetails(token, {
      email: typeof body.clientEmail === "string" ? body.clientEmail : "",
      username: typeof body.clientUsername === "string" ? body.clientUsername : "",
    });
    if (!result.ok) return res.status(result.reason === "invalid" ? 404 : 410).json(result);
    return res.json(result);
  });

  /**
   * Public address suggestions for the buyer order form. Proxies Photon so the
   * browser never needs a maps API key. Throttled with the other client routes.
   */
  app.post("/api/address-suggest", async (req: Request, res: Response) => {
    if (tooManyClientAttempts(req, res)) return;
    const query =
      req.body && typeof req.body === "object" && typeof (req.body as { query?: unknown }).query === "string"
        ? String((req.body as { query: string }).query)
        : "";
    try {
      const suggestions = await suggestAddresses(query);
      return res.json({ ok: true, suggestions });
    } catch {
      return res.json({ ok: true, suggestions: [] });
    }
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

  /**
   * Chrome extension → Manual entry bridge.
   * Create requires owner access code. Redeem is consume-once via capability id.
   */
  app.post("/api/paid-orders/messenger-bridge", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    try {
      const created = createMessengerScanBridge({
        conversation: typeof body.conversation === "string" ? body.conversation : "",
        title: typeof body.title === "string" ? body.title : "",
        source: typeof body.source === "string" ? body.source : "messenger-extension",
      });
      return res.status(201).json({ ok: true, ...created });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not create messenger bridge",
      });
    }
  });

  app.get("/api/paid-orders/messenger-bridge/:id", (req: Request, res: Response) => {
    const payload = redeemMessengerScanBridge(String(req.params.id || ""));
    if (!payload) {
      return res.status(404).json({
        ok: false,
        error: "Messenger scan expired or already used. Run Send to Print Ops again.",
      });
    }
    return res.json({
      ok: true,
      conversation: payload.conversation,
      title: payload.title,
      source: payload.source,
    });
  });

  /**
   * Marketplace secretary brief — batch of scanned threads → prioritized next actions.
   * The current brief is a single owner-gated persistent slot.
   */
  app.post("/api/marketplace-brief", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const threadsRaw = body.threads;
    if (!Array.isArray(threadsRaw)) {
      return res.status(400).json({ ok: false, error: "Expected { threads: [...] }" });
    }
    try {
      const threads = threadsRaw.map((row, index) => {
        const item = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
        return {
          id: typeof item.id === "string" ? item.id : `t-${index}`,
          title: typeof item.title === "string" ? item.title : `Thread ${index + 1}`,
          conversation: typeof item.conversation === "string" ? item.conversation : "",
          unread: item.unread === true,
          lastActivityAt: typeof item.lastActivityAt === "string" ? item.lastActivityAt : null,
        };
      });
      const created = createMarketplaceInboxBrief(threads);
      return res.status(201).json({ ok: true, id: created.id, brief: created.brief });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Could not build marketplace brief",
      });
    }
  });

  app.get("/api/marketplace-brief/latest", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const brief = getMarketplaceInboxBrief();
    if (!brief) {
      return res.status(404).json({ ok: false, error: "No Marketplace brief has been saved yet." });
    }
    return res.json({ ok: true, brief });
  });

  /** Backwards-compatible Chrome-helper URL; all ids resolve to the one current brief. */
  app.get("/api/marketplace-brief/:id", (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const brief = getMarketplaceInboxBrief(String(req.params.id || ""));
    if (!brief) {
      return res.status(404).json({
        ok: false,
        error: "No Marketplace brief has been saved yet.",
      });
    }
    return res.json({ ok: true, brief });
  });

  app.post("/api/paid-orders", async (req: Request, res: Response) => {
    if (rejectUnsecuredIntake(req, res)) return;
    const lineItems = paidOrderLineItemsFrom(req.body);
    const draft = paidOrderDraftFrom(req.body);

    if (lineItems) {
      const lineError = validatePaidOrderLineItems(lineItems);
      if (lineError) return res.status(400).json({ ok: false, error: lineError });
      // Keep draft scalars in sync so contact/payment validation still applies.
      draft.productName = lineItems[0]!.productName;
      draft.amount = lineItems[0]!.amount;
    }

    const validationError = validatePaidOrderDraft(draft);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    try {
      const orderGroup =
        lineItems && lineItems.length > 1 ? `manual-${Date.now().toString(36)}` : undefined;
      const result = await createPaidOrder(draft, {
        lineItems: lineItems ?? undefined,
        orderGroup,
      });
      return res.status(201).json({
        ok: true,
        result,
        message:
          result.deals.length > 1
            ? `Created ${result.deals.length} Print Orders on one Contact — attach plates per item next.`
            : "Created Contact and Print Order — attach the first plate next.",
      });
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
