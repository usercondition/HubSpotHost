/**
 * Shared contracts between the Express API and the React dashboard.
 * The audit log is a small local file kept server-side.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { z } from "zod";

export const INPUT_PROPERTY_LABELS: Record<string, string> = {
  amount: "Amount",
  print_material_cost: "Actual material cost",
  print_labor_cost: "Labor cost",
  print_packaging_cost: "Packaging cost",
  print_actual_shipping_cost: "Actual shipping cost",
};

export const OUTPUT_PROPERTY_LABELS: Record<string, string> = {
  print_gross_profit: "Gross Profit",
  print_margin_percentage: "Margin Percentage",
};

export const SUPPLY_CATEGORIES = [
  "materials",
  "consumables",
  "packaging_shipping",
  "equipment_maintenance",
  "other",
] as const;

export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = {
  materials: "Materials",
  consumables: "Consumables",
  packaging_shipping: "Packaging & shipping",
  equipment_maintenance: "Equipment & maintenance",
  other: "Other",
};

export type TriggerOrigin = "webhook" | "manual";
export type AttemptStatus = "written" | "dry-run" | "error";

export interface AuditEntry {
  id: number;
  timestamp: string;
  dealId: string;
  origin: TriggerOrigin;
  status: AttemptStatus;
  dryRun: boolean;
  gate: string;
  inputs: {
    amount: number;
    material: number;
    labor: number;
    packaging: number;
    shipping: number;
    costTotal: number;
  } | null;
  outputs: {
    print_gross_profit: number;
    print_margin_percentage: number;
  } | null;
  error?: string;
}

export interface HealthResponse {
  status: "ok";
  mode: "dry-run" | "live-write";
  readiness: string;
  safety: {
    dryRun: boolean;
    allowHubspotWrites: boolean;
    liveWriteReady: boolean;
    blockedBy: string | null;
  };
  credentials: {
    apiBaseConfigured: boolean;
    apiBaseSource: "environment" | "default";
    tokenConfigured: boolean;
    tokenSource: "custom_cred" | "hubspot_access_token" | null;
  };
  paidOrderIntake?: {
    accessCodeConfigured: boolean;
    buildId?: string;
    clientLinkWorkflow?: string;
  };
  storage?: {
    configured: boolean;
    ephemeral: boolean;
    durableVolumeLikely: boolean;
    warning: string | null;
  };
  webhook: {
    verification: "configured" | "not-configured";
    callbackToken?: "configured" | "not-configured";
    supportedVersions: string[];
    path: string;
    latestDelivery: {
      receivedAt: string;
      result: "accepted" | "rejected";
      version: "v1" | "v3" | null;
      reason: string;
    } | null;
  };
  admin: {
    /** Public deployments expose only the webhook and safe readiness status. */
    publicControlsEnabled?: boolean;
    internalControlsEnabled?: boolean;
  };
  properties: {
    inputs: string[];
    outputs: string[];
  };
  audit: {
    retained: number;
    limit: number;
  };
  serverTime: string;
}

export interface RecalcOutcome {
  dealId: string;
  status: AttemptStatus;
  dryRun: boolean;
  gate: string;
  grossProfit?: number;
  marginPercentage?: number;
  costTotal?: number;
  error?: string;
}

export interface CalculationsResponse {
  count: number;
  limit: number;
  entries: AuditEntry[];
}

/** Slim supply summary shape used when building the books balance. */
export interface SupplySpendSummaryLike {
  periodDays: number;
  total: number;
  purchases: number;
  byCategory: Array<{
    category: SupplyCategory;
    label: string;
    total: number;
    count: number;
  }>;
}

/**
 * Revenue / gross profit from Print Orders vs logged supply receipts.
 * `afterSupplySpend` is a management view — not GAAP net profit — because
 * supply receipts may overlap with actual costs already on HubSpot deals.
 */
export interface SupplyBooksBalance {
  periodDays: number;
  revenue: number;
  orderCosts: number;
  grossProfit: number;
  orders: number;
  supplySpend: number;
  supplyPurchases: number;
  afterSupplySpend: number;
  supplyShareOfRevenuePercent: number;
  supplyShareOfGrossProfitPercent: number;
  byCategory: Array<{
    category: SupplyCategory;
    label: string;
    total: number;
    count: number;
    shareOfSupplyPercent: number;
  }>;
}

export interface PerformanceResponse {
  generatedAt: string;
  period: {
    days: number;
    startsAt: string;
  };
  thresholds: {
    marginPercent: number;
    staleDays: number;
  };
  summary: {
    revenue: number;
    grossProfit: number;
    weightedMarginPercent: number;
    orders: number;
    averageOrderValue: number;
    activeOrders: number;
    attentionCount: number;
  };
  intake: {
    awaitingClient: number;
    pendingReview: number;
    approved: number;
  };
  supplySpend: SupplySpendSummaryLike;
  /** Where money went: order profit set against logged supply purchases. */
  books: SupplyBooksBalance;
  pipeline: Array<{
    id: string;
    label: string;
    count: number;
    closed: boolean;
  }>;
  attention: Array<{
    dealId: string;
    dealName: string;
    stage: string;
    issue: string;
    /** Stable key for dismiss/bypass: no_plates | costs_incomplete | low_margin | stale | other */
    issueKey: string;
    detail: string;
    severity: "neutral" | "warn" | "bad";
  }>;
  activeDeals: Array<{
    dealId: string;
    dealName: string;
    /** HubSpot dealstage id for pipeline board columns. */
    stageId: string;
    stage: string;
    amount: number;
    hasPlates: boolean;
    /** Show Attach plates when plates missing and alert not dismissed. */
    promptAttachPlates: boolean;
    closeDate: string | null;
    contactName: string | null;
  }>;
  hubspotPortalId: string | null;
}

export const ATTENTION_ISSUE_KEYS = [
  "no_plates",
  "costs_incomplete",
  "low_margin",
  "stale",
  "other",
] as const;

export type AttentionIssueKey = (typeof ATTENTION_ISSUE_KEYS)[number];

/** Owner-dismissed attention alerts (per deal + issue). Survives until undone. */
export const attentionOverrides = sqliteTable("attention_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hubspotDealId: text("hubspot_deal_id").notNull(),
  issueKey: text("issue_key").notNull().$type<AttentionIssueKey>(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export type AttentionOverride = typeof attentionOverrides.$inferSelect;

export function attentionIssueKeyFromIssue(issue: string): AttentionIssueKey {
  const normalized = issue.toLowerCase();
  if (normalized.includes("ctb") || normalized.includes("plate")) return "no_plates";
  if (normalized.includes("cost")) return "costs_incomplete";
  if (normalized.includes("margin")) return "low_margin";
  if (normalized.includes("recent activity") || normalized.includes("stale")) return "stale";
  return "other";
}

export const dismissAttentionSchema = z.object({
  dealId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "Select a valid Print Order"),
  issueKey: z.enum(ATTENTION_ISSUE_KEYS),
  note: z.string().trim().max(200).default(""),
});

export type DismissAttentionInput = z.infer<typeof dismissAttentionSchema>;

export interface TrackerAssistantAction {
  label: string;
  href: string;
  external?: boolean;
}

export interface TrackerAssistantResponse {
  ok: true;
  mode: "rules" | "model";
  reply: string;
  actions: TrackerAssistantAction[];
  usedFacts: string[];
}

export interface WebhookSummary {
  ok: boolean;
  received: number;
  matched: number;
  ignoredOutputEvents: number;
  ignoredOther: number;
  deals: number;
  written: number;
  dryRun: number;
  errors: number;
  results: RecalcOutcome[];
}

export interface PaidOrderAnalysis {
  fullName: string;
  marketplaceUsername: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  productName: string;
  amount: string;
  conversationSummary: string;
  missing: string[];
  paymentLanguageDetected: boolean;
}

export interface PaidOrderDraft {
  paymentConfirmed: boolean;
  fullName: string;
  marketplaceUsername: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  productName: string;
  amount: string;
  conversationSummary: string;
}

export interface HubSpotIntakeDealRef {
  dealId: string;
  dealName: string;
  amount: string;
  productName: string;
}

export interface PaidOrderCreateResult {
  contactId: string;
  contactStatus: "existing" | "created";
  /** Primary deal (first line item) — kept for older callers. */
  dealId: string;
  dealName: string;
  pipeline: string;
  dealStage: string;
  /** Every deal created for this approval (one per line item). */
  deals: HubSpotIntakeDealRef[];
}

/* ------------------------------------------------------------------ */
/* Client order intake links (SQLite-backed, Drizzle)                  */
/* ------------------------------------------------------------------ */


/**
 * One row per one-time client details link.
 *
 * Only a SHA-256 hash of the link token is stored. The raw token is returned
 * exactly once, in the creation response, and is never logged or persisted.
 * Client submissions land here and never touch HubSpot; the owner's explicit
 * approval is the only path that creates HubSpot records.
 */
export const orderIntakeLinks = sqliteTable("order_intake_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().$type<OrderIntakeStatus>(),

  /* Owner-entered, agreed before the link is sent */
  internalLabel: text("internal_label").notNull(),
  itemDescription: text("item_description").notNull(),
  agreedAmount: text("agreed_amount").notNull(),
  paymentMethod: text("payment_method").notNull().default(""),
  paymentReference: text("payment_reference").notNull().default(""),
  buyerNameHint: text("buyer_name_hint").notNull().default(""),
  buyerUsernameHint: text("buyer_username_hint").notNull().default(""),
  ownerNotes: text("owner_notes").notNull().default(""),

  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  submittedAt: text("submitted_at"),
  decidedAt: text("decided_at"),

  /* Buyer-submitted details */
  clientFullName: text("client_full_name").notNull().default(""),
  clientUsername: text("client_username").notNull().default(""),
  clientEmail: text("client_email").notNull().default(""),
  clientPhone: text("client_phone").notNull().default(""),
  shippingRequired: integer("shipping_required", { mode: "boolean" }).notNull().default(false),
  shippingStreet: text("shipping_street").notNull().default(""),
  shippingCity: text("shipping_city").notNull().default(""),
  shippingState: text("shipping_state").notNull().default(""),
  shippingPostalCode: text("shipping_postal_code").notNull().default(""),
  shippingCountry: text("shipping_country").notNull().default(""),
  confirmedItem: text("confirmed_item").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  clientNotes: text("client_notes").notNull().default(""),
  clientPaymentConfirmed: integer("client_payment_confirmed", { mode: "boolean" })
    .notNull()
    .default(false),

  /**
   * JSON array of commercial line items for this intake.
   * Empty / missing means a legacy single-item row using itemDescription + agreedAmount.
   */
  lineItemsJson: text("line_items_json").notNull().default("[]"),

  /* Set only after the owner approves and HubSpot accepts the write */
  hubspotContactId: text("hubspot_contact_id"),
  hubspotDealId: text("hubspot_deal_id"),
  hubspotDealName: text("hubspot_deal_name"),
  /** JSON array of { dealId, dealName, amount, productName } created on approve. */
  hubspotDealsJson: text("hubspot_deals_json").notNull().default("[]"),
});

export type OrderIntakeStatus = "awaiting_client" | "pending_review" | "created" | "expired";

export const ORDER_INTAKE_STATUSES: OrderIntakeStatus[] = [
  "awaiting_client",
  "pending_review",
  "created",
  "expired",
];

export const ORDER_INTAKE_STATUS_LABELS: Record<OrderIntakeStatus, string> = {
  awaiting_client: "Awaiting client details",
  pending_review: "Pending review",
  created: "Approved / created",
  expired: "Expired",
};

export type OrderIntakeLink = typeof orderIntakeLinks.$inferSelect;

/** One commercial item on an intake. Each becomes its own HubSpot deal on approve. */
export interface OrderIntakeLineItem {
  description: string;
  amount: string;
  quantity: number;
}

export type ResinCostSource = "ctb" | "ultx" | "amazon" | "supplies" | "manual";

export function parseAmountNumber(value: string): number {
  return Number(String(value).replace(/[$,\s]/g, ""));
}

/** Prefer explicit lineItems; otherwise treat legacy scalar fields as one line. */
export function normalizeIntakeLineItems(input: {
  lineItems?: Array<{ description?: string; amount?: string; quantity?: unknown }> | null;
  itemDescription?: string;
  agreedAmount?: string;
}): OrderIntakeLineItem[] {
  const fromArray = Array.isArray(input.lineItems)
    ? input.lineItems
        .map((item) => ({
          description: String(item?.description ?? "").trim(),
          amount: String(item?.amount ?? "").trim(),
          quantity: Math.max(1, Math.min(999, Number(item?.quantity) || 1)),
        }))
        .filter((item) => {
          if (item.description.length < 2 || !item.amount) return false;
          const parsed = parseAmountNumber(item.amount);
          return Number.isFinite(parsed) && parsed >= 0;
        })
    : [];
  if (fromArray.length > 0) return fromArray.slice(0, 20);

  const description = String(input.itemDescription ?? "").trim();
  const amount = String(input.agreedAmount ?? "").trim();
  const parsed = parseAmountNumber(amount);
  if (description.length >= 2 && amount && Number.isFinite(parsed) && parsed >= 0) {
    return [{ description, amount, quantity: 1 }];
  }
  return [];
}

/** Unit amount × quantity for one intake line (amount is unit price). */
export function intakeLineExtendedAmount(line: Pick<OrderIntakeLineItem, "amount" | "quantity">): number {
  const unit = parseAmountNumber(line.amount);
  const quantity = Math.max(1, Math.min(999, Number(line.quantity) || 1));
  if (!Number.isFinite(unit) || unit < 0) return 0;
  return unit * quantity;
}

export function summarizeIntakeLineItems(lines: OrderIntakeLineItem[]): {
  itemDescription: string;
  agreedAmount: string;
} {
  if (lines.length === 0) return { itemDescription: "", agreedAmount: "0" };
  const total = lines.reduce((sum, line) => sum + intakeLineExtendedAmount(line), 0);
  const itemDescription =
    lines.length === 1
      ? lines[0]!.description
      : `${lines.length} items: ${lines.map((line) => line.description).join("; ")}`.slice(0, 400);
  return {
    itemDescription,
    agreedAmount: total.toFixed(2),
  };
}

export function parseIntakeLineItemsJson(raw: string | null | undefined): OrderIntakeLineItem[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeIntakeLineItems({ lineItems: parsed as OrderIntakeLineItem[] });
  } catch {
    return [];
  }
}

export function parseHubSpotDealsJson(raw: string | null | undefined): HubSpotIntakeDealRef[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const dealId = String(row.dealId ?? "").trim();
        const dealName = String(row.dealName ?? "").trim();
        if (!dealId) return null;
        return {
          dealId,
          dealName: dealName || `Deal ${dealId}`,
          amount: String(row.amount ?? "").trim(),
          productName: String(row.productName ?? "").trim(),
        };
      })
      .filter((item): item is HubSpotIntakeDealRef => item !== null);
  } catch {
    return [];
  }
}

/** Resolve line items for a stored intake, including legacy single-item rows. */
export function lineItemsForIntake(
  link: Pick<OrderIntakeLink, "lineItemsJson" | "itemDescription" | "agreedAmount" | "quantity">,
): OrderIntakeLineItem[] {
  const stored = parseIntakeLineItemsJson(link.lineItemsJson);
  if (stored.length > 0) return stored;
  return normalizeIntakeLineItems({
    itemDescription: link.itemDescription,
    agreedAmount: link.agreedAmount,
  }).map((item) => ({
    ...item,
    quantity: link.quantity > 1 ? link.quantity : item.quantity,
  }));
}

/**
 * A manual record of a supply purchase, usually copied from a regular Amazon
 * order confirmation. These records remain separate from per-deal actual
 * costs until the owner allocates an actual cost on the HubSpot deal.
 *
 * `lineItemsJson` holds the per-SKU breakdown when an order has more than one
 * item. Empty / missing means a legacy single-item row using itemName + quantity.
 */
export const supplyPurchases = sqliteTable("supply_purchases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull().default("Amazon"),
  orderReference: text("order_reference").notNull().default(""),
  itemName: text("item_name").notNull(),
  category: text("category").notNull().$type<SupplyCategory>(),
  quantity: integer("quantity").notNull().default(1),
  totalAmount: text("total_amount").notNull(),
  purchasedAt: text("purchased_at").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  lineItemsJson: text("line_items_json").notNull().default("[]"),
});

export type SupplyPurchase = typeof supplyPurchases.$inferSelect;

export interface SupplyPurchaseLineItem {
  itemName: string;
  quantity: number;
  /** Optional line subtotal before tax/shipping. Empty when unknown. */
  lineAmount: string;
  category: SupplyCategory;
}

/** Prefer explicit lineItems; otherwise treat legacy scalar fields as one line. */
export function normalizeSupplyLineItems(input: {
  lineItems?: Array<{
    itemName?: string;
    quantity?: unknown;
    lineAmount?: string;
    category?: string;
  }> | null;
  itemName?: string;
  quantity?: unknown;
  totalAmount?: string;
  category?: SupplyCategory;
}): SupplyPurchaseLineItem[] {
  const fromArray = Array.isArray(input.lineItems)
    ? input.lineItems
        .map((item) => {
          const itemName = String(item?.itemName ?? "").trim();
          const quantity = Math.max(1, Math.min(100_000, Number(item?.quantity) || 1));
          const lineAmount = String(item?.lineAmount ?? "").trim();
          const categoryRaw = String(item?.category ?? "").trim();
          const category = (SUPPLY_CATEGORIES as readonly string[]).includes(categoryRaw)
            ? (categoryRaw as SupplyCategory)
            : suggestCategoryFromName(itemName);
          return { itemName, quantity, lineAmount, category };
        })
        .filter((item) => item.itemName.length >= 2)
    : [];
  if (fromArray.length > 0) return fromArray.slice(0, 40);

  const itemName = String(input.itemName ?? "").trim();
  if (itemName.length < 2) return [];
  return [
    {
      itemName,
      quantity: Math.max(1, Math.min(100_000, Number(input.quantity) || 1)),
      lineAmount: String(input.totalAmount ?? "").trim(),
      category: input.category ?? suggestCategoryFromName(itemName),
    },
  ];
}

function suggestCategoryFromName(itemName: string): SupplyCategory {
  const normalized = itemName.toLowerCase();
  if (/\b(resin|filament|primer|paint|epoxy|silicone|pigment)\b/.test(normalized)) return "materials";
  if (/\b(box|mailer|bubble|tape|label|packing|shipping|envelope|foam)\b/.test(normalized)) {
    return "packaging_shipping";
  }
  if (/\b(fep|nfep|screen|vat|printer|build plate|motor|bearing|replacement|repair|tool)\b/.test(normalized)) {
    return "equipment_maintenance";
  }
  if (/\b(glove|nitrile|isopropyl|ipa|alcohol|paper towel|mask|filter|funnel|rag|wipe)\b/.test(normalized)) {
    return "consumables";
  }
  return "other";
}

export function summarizeSupplyLineItems(lines: SupplyPurchaseLineItem[]): {
  itemName: string;
  quantity: number;
  category: SupplyCategory;
  lineTotal: number | null;
} {
  if (lines.length === 0) {
    return { itemName: "", quantity: 1, category: "other", lineTotal: null };
  }
  const quantity = lines.reduce((sum, line) => sum + Math.max(1, line.quantity || 1), 0);
  const amounts = lines
    .map((line) => parseAmountNumber(line.lineAmount))
    .filter((value) => Number.isFinite(value) && value > 0);
  const lineTotal = amounts.length > 0 ? amounts.reduce((sum, value) => sum + value, 0) : null;

  let category = lines[0]!.category;
  if (lines.length > 1 && amounts.length === lines.length) {
    const byCategory = new Map<SupplyCategory, number>();
    lines.forEach((line, index) => {
      byCategory.set(line.category, (byCategory.get(line.category) ?? 0) + (amounts[index] ?? 0));
    });
    let best: SupplyCategory = category;
    let bestTotal = -1;
    Array.from(byCategory.entries()).forEach(([key, total]) => {
      if (total > bestTotal) {
        best = key;
        bestTotal = total;
      }
    });
    category = best;
  } else if (lines.length > 1) {
    const counts = new Map<SupplyCategory, number>();
    for (const line of lines) {
      counts.set(line.category, (counts.get(line.category) ?? 0) + 1);
    }
    let best: SupplyCategory = category;
    let bestCount = -1;
    Array.from(counts.entries()).forEach(([key, count]) => {
      if (count > bestCount) {
        best = key;
        bestCount = count;
      }
    });
    category = best;
  }

  const itemName =
    lines.length === 1
      ? lines[0]!.itemName
      : `${lines.length} items: ${lines.map((line) => line.itemName).join("; ")}`.slice(0, 400);

  return { itemName, quantity, category, lineTotal };
}

export function parseSupplyLineItemsJson(raw: string | null | undefined): SupplyPurchaseLineItem[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeSupplyLineItems({ lineItems: parsed as SupplyPurchaseLineItem[] });
  } catch {
    return [];
  }
}

/** Prefer stored breakdown; fall back to legacy scalar columns. */
export function lineItemsForSupplyPurchase(
  purchase: Pick<SupplyPurchase, "lineItemsJson" | "itemName" | "quantity" | "totalAmount" | "category">,
): SupplyPurchaseLineItem[] {
  const stored = parseSupplyLineItemsJson(purchase.lineItemsJson);
  if (stored.length > 0) return stored;
  return normalizeSupplyLineItems({
    itemName: purchase.itemName,
    quantity: purchase.quantity,
    totalAmount: purchase.totalAmount,
    category: purchase.category,
  });
}

/* ------------------------------------------------------------------ */
/* Sliced print files                                                  */
/* ------------------------------------------------------------------ */

/**
 * The production metadata extracted from a Chitubox CTB slice file. These
 * values describe the entire build plate, not one individual model on it.
 *
 * `resinCost` is a planning estimate only — not the deal's actual
 * `print_material_cost`.
 */
export type PrintSliceFormat = "CTB" | "ULTX";

export interface PrintFileMetrics {
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  format: PrintSliceFormat;
  formatRevision: string;
  printTimeSeconds: number | null;
  resinVolumeMl: number | null;
  resinMassG: number | null;
  resinCost: number | null;
  resinCostSource: ResinCostSource | null;
  resinCostLabel: string | null;
  resinDensityGPerMl: number | null;
  layerCount: number | null;
  layerHeightMm: number | null;
  modelHeightMm: number | null;
  exposureSeconds: number | null;
  bottomExposureSeconds: number | null;
  lightOffSeconds: number | null;
  bottomLightOffSeconds: number | null;
  bottomLayerCount: number | null;
  liftDistanceMm: number | null;
  liftSpeedMmPerMin: number | null;
  bottomLiftDistanceMm: number | null;
  bottomLiftSpeedMmPerMin: number | null;
  retractSpeedMmPerMin: number | null;
  resolutionX: number | null;
  resolutionY: number | null;
  buildVolumeXmm: number | null;
  buildVolumeYmm: number | null;
  buildVolumeZmm: number | null;
  printerProfile: string | null;
}

/**
 * The rolling production plan for one HubSpot order. Every CTB file remains
 * an individual plate record locally; HubSpot receives these cumulative values
 * so a multi-plate job can be understood from its deal card at a glance.
 */
export interface PrintFileOrderSummary {
  plateCount: number;
  totalPrintTimeSeconds: number | null;
  totalResinVolumeMl: number | null;
  totalResinMassG: number | null;
  totalResinCost: number | null;
  totalLayerCount: number | null;
  latest: PrintFileMetrics;
}

/** A short-lived server-side analysis. The binary is never persisted. */
export const printFileAnalyses = sqliteTable("print_file_analyses", {
  id: text("id").primaryKey(),
  metricsJson: text("metrics_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export type PrintFileAnalysis = typeof printFileAnalyses.$inferSelect;

/**
 * A durable production record. It stores extracted metadata only, never the
 * CTB binary itself, so large slicer files are not retained in Railway.
 */
export const printFileRecords = sqliteTable("print_file_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  analysisId: text("analysis_id").notNull(),
  hubspotDealId: text("hubspot_deal_id").notNull(),
  hubspotDealName: text("hubspot_deal_name").notNull(),
  dealStage: text("deal_stage").notNull().default(""),
  fileName: text("file_name").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  formatRevision: text("format_revision").notNull(),
  printTimeSeconds: integer("print_time_seconds"),
  resinVolumeMl: text("resin_volume_ml"),
  resinMassG: text("resin_mass_g"),
  resinCost: text("resin_cost"),
  resinCostSource: text("resin_cost_source"),
  resinCostLabel: text("resin_cost_label"),
  resinDensityGPerMl: text("resin_density_g_per_ml"),
  layerCount: integer("layer_count"),
  layerHeightMm: text("layer_height_mm"),
  modelHeightMm: text("model_height_mm"),
  exposureSeconds: text("exposure_seconds"),
  bottomExposureSeconds: text("bottom_exposure_seconds"),
  lightOffSeconds: text("light_off_seconds"),
  bottomLightOffSeconds: text("bottom_light_off_seconds"),
  bottomLayerCount: integer("bottom_layer_count"),
  liftDistanceMm: text("lift_distance_mm"),
  liftSpeedMmPerMin: text("lift_speed_mm_per_min"),
  bottomLiftDistanceMm: text("bottom_lift_distance_mm"),
  bottomLiftSpeedMmPerMin: text("bottom_lift_speed_mm_per_min"),
  retractSpeedMmPerMin: text("retract_speed_mm_per_min"),
  resolutionX: integer("resolution_x"),
  resolutionY: integer("resolution_y"),
  printerProfile: text("printer_profile"),
  /** Explicit fleet printer for this plate — wins over slicer profile matching. */
  fleetPrinterId: integer("fleet_printer_id"),
  hubspotSyncedAt: text("hubspot_synced_at").notNull(),
  attachedAt: text("attached_at").notNull(),
});

export type PrintFileRecord = typeof printFileRecords.$inferSelect;

/**
 * Parts the operator says were on a specific attached plate.
 * Names come from dropped .stl files — the slice file itself has no part names.
 */
export const PRINT_PLATE_BIT_STATUSES = ["on_plate", "good", "reprint"] as const;
export type PrintPlateBitStatus = (typeof PRINT_PLATE_BIT_STATUSES)[number];

export const PRINT_PLATE_BIT_STATUS_LABELS: Record<PrintPlateBitStatus, string> = {
  on_plate: "On plate",
  good: "Good",
  reprint: "Reprint",
};

export const printPlateBits = sqliteTable("print_plate_bits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  printFileRecordId: integer("print_file_record_id").notNull(),
  fileName: text("file_name").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("on_plate"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type PrintPlateBit = typeof printPlateBits.$inferSelect;

export const updatePrintPlateBitStatusSchema = z.object({
  status: z.enum(PRINT_PLATE_BIT_STATUSES),
});

export type UpdatePrintPlateBitStatusInput = z.infer<typeof updatePrintPlateBitStatusSchema>;

/**
 * Master parts checklist for a HubSpot Print Order.
 * Plates subtract from this list as STLs are linked to attached plates.
 * `itemGroup` separates multiple products on the same order (Acastus vs Valiant).
 */
export const ORDER_PART_STATUSES = ["needed", "on_plate", "good", "reprint"] as const;
export type OrderPartStatus = (typeof ORDER_PART_STATUSES)[number];

export const ORDER_PART_STATUS_LABELS: Record<OrderPartStatus, string> = {
  needed: "Needed",
  on_plate: "On plate",
  good: "Good",
  reprint: "Reprint",
};

/** Human label for order-part or plate-bit status codes. */
export function partStatusLabel(status: string): string {
  if ((ORDER_PART_STATUSES as readonly string[]).includes(status)) {
    return ORDER_PART_STATUS_LABELS[status as OrderPartStatus];
  }
  if ((PRINT_PLATE_BIT_STATUSES as readonly string[]).includes(status)) {
    return PRINT_PLATE_BIT_STATUS_LABELS[status as PrintPlateBitStatus];
  }
  return status;
}

export const orderParts = sqliteTable("order_parts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hubspotDealId: text("hubspot_deal_id").notNull(),
  hubspotDealName: text("hubspot_deal_name").notNull().default(""),
  itemGroup: text("item_group").notNull().default("Kit"),
  fileName: text("file_name").notNull(),
  label: text("label").notNull(),
  status: text("status").notNull().default("needed"),
  printFileRecordId: integer("print_file_record_id"),
  printPlateBitId: integer("print_plate_bit_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type OrderPart = typeof orderParts.$inferSelect;

export const orderPartImportEntrySchema = z.object({
  fileName: z.string().trim().min(1).max(400),
  itemGroup: z.string().trim().max(200).optional(),
  relativePath: z.string().trim().max(800).optional(),
  archivePath: z.string().trim().max(800).optional(),
});

export const importOrderPartsSchema = z.object({
  /** @deprecated Prefer `parts` — kept for older clients. */
  fileNames: z.array(z.string().trim().min(1).max(400)).max(2_000).optional(),
  parts: z.array(orderPartImportEntrySchema).max(2_000).optional(),
  dealName: z.string().trim().max(300).optional(),
  /** When set, all imported files join this item (e.g. second product on the order). */
  defaultItemGroup: z.string().trim().max(200).optional(),
}).refine((value) => (value.parts?.length ?? 0) + (value.fileNames?.length ?? 0) > 0, {
  message: "Add at least one part file.",
});

export type ImportOrderPartsInput = z.infer<typeof importOrderPartsSchema>;

export const updateOrderPartStatusSchema = z.object({
  status: z.enum(ORDER_PART_STATUSES),
});

export type UpdateOrderPartStatusInput = z.infer<typeof updateOrderPartStatusSchema>;

export const addPrintPlateBitsSchema = z.object({
  /** @deprecated Prefer `parts`. */
  fileNames: z.array(z.string().trim().min(1).max(400)).max(500).optional(),
  parts: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(400),
        itemGroup: z.string().trim().max(200).optional(),
        relativePath: z.string().trim().max(800).optional(),
        archivePath: z.string().trim().max(800).optional(),
      }),
    )
    .max(500)
    .optional(),
}).refine((value) => (value.parts?.length ?? 0) + (value.fileNames?.length ?? 0) > 0, {
  message: "Add at least one .stl file.",
});

export type AddPrintPlateBitsInput = z.infer<typeof addPrintPlateBitsSchema>;

/**
 * One kit document per HubSpot Print Order.
 * `kitJson` stores the full client KitTracker (bits, plates, QC).
 */
export const kits = sqliteTable("kits", {
  hubspotDealId: text("hubspot_deal_id").primaryKey(),
  hubspotDealName: text("hubspot_deal_name").notNull().default(""),
  name: text("name").notNull(),
  kitJson: text("kit_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type KitRow = typeof kits.$inferSelect;

export interface PrintFileCandidateDeal {
  dealId: string;
  dealName: string;
  stage: string;
  hasPrintFile: boolean;
}

export const PRINTER_STATUSES = ["active", "retired"] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const PRINTER_LIFECYCLE_EVENT_TYPES = [
  "fep_replaced",
  "screen_replaced",
  "maintenance",
  "note",
  "retired",
  "reactivated",
] as const;
export type PrinterLifecycleEventType = (typeof PRINTER_LIFECYCLE_EVENT_TYPES)[number];

export const PRINTER_LIFECYCLE_EVENT_LABELS: Record<PrinterLifecycleEventType, string> = {
  fep_replaced: "FEP / release film replaced",
  screen_replaced: "LCD screen replaced",
  maintenance: "Maintenance",
  note: "Note",
  retired: "Retired",
  reactivated: "Reactivated",
};

/** Fleet machine registry. Plate metrics match via name + aliases. */
export const printers = sqliteTable("printers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  brand: text("brand").notNull().default("ELEGOO"),
  model: text("model").notNull().default(""),
  status: text("status").notNull().default("active"),
  aliasesJson: text("aliases_json").notNull().default("[]"),
  notes: text("notes").notNull().default(""),
  recommendedFepHours: text("recommended_fep_hours").notNull().default("80"),
  recommendedFepLayers: text("recommended_fep_layers").notNull().default("25000"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Printer = typeof printers.$inferSelect;

export const printerLifecycleEvents = sqliteTable("printer_lifecycle_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  printerId: integer("printer_id").notNull(),
  eventType: text("event_type").notNull(),
  occurredAt: text("occurred_at").notNull(),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export type PrinterLifecycleEvent = typeof printerLifecycleEvents.$inferSelect;

/**
 * Manual mapping from a slicer machine-name string onto a fleet printer.
 * Takes precedence over automatic alias matching.
 */
export const printerProfileMaps = sqliteTable("printer_profile_maps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileKey: text("profile_key").notNull().unique(),
  profileLabel: text("profile_label").notNull(),
  printerId: integer("printer_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type PrinterProfileMap = typeof printerProfileMaps.$inferSelect;

export interface PrinterJobSummary {
  recordId: number;
  dealId: string;
  dealName: string;
  fileName: string;
  formatRevision: string;
  printerProfile: string | null;
  printTimeSeconds: number | null;
  layerCount: number | null;
  resinVolumeMl: number | null;
  resinMassG: number | null;
  attachedAt: string;
}

export interface PrinterUsageBreakdown {
  printerId: number;
  name: string;
  brand: string;
  model: string;
  status: PrinterStatus;
  aliases: string[];
  notes: string;
  recommendedFepHours: number;
  recommendedFepLayers: number;
  plateCount: number;
  totalPrintTimeSeconds: number;
  totalPrintHours: number;
  totalLayers: number;
  totalResinVolumeMl: number;
  totalResinMassG: number;
  distinctOrders: number;
  firstJobAt: string | null;
  lastJobAt: string | null;
  matchedProfiles: string[];
  fepInstalledAt: string | null;
  hoursSinceFep: number;
  layersSinceFep: number;
  fepHoursUsedPercent: number | null;
  fepLayersUsedPercent: number | null;
  screenInstalledAt: string | null;
  hoursSinceScreen: number;
  layersSinceScreen: number;
  recentJobs: PrinterJobSummary[];
  lifecycleEvents: PrinterLifecycleEvent[];
}

export interface PrinterFleetSnapshot {
  printers: PrinterUsageBreakdown[];
  unassigned: {
    plateCount: number;
    totalPrintTimeSeconds: number;
    totalPrintHours: number;
    totalLayers: number;
    profiles: Array<{ profile: string; plateCount: number; totalPrintHours: number }>;
    recentJobs: PrinterJobSummary[];
  };
  fleetTotals: {
    plateCount: number;
    totalPrintHours: number;
    totalLayers: number;
    activePrinters: number;
  };
}

const trimmed = (max: number) => z.string().trim().max(max);
const amountLike = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) && parsed > 0;
  }, "Enter an agreed amount greater than zero");

/** Unit price on intake lines — allows free ($0) add-ons. */
const nonNegativeAmountLike = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) && parsed >= 0;
  }, "Enter an amount of zero or more");

const supplyPurchaseDate = z
  .string()
  .trim()
  .min(1, "Enter the purchase date")
  .refine((value) => Number.isFinite(new Date(value).getTime()), "Enter a valid purchase date");

export const createPrinterLifecycleEventSchema = z.object({
  eventType: z.enum(PRINTER_LIFECYCLE_EVENT_TYPES),
  occurredAt: z
    .string()
    .trim()
    .min(1, "Enter when this happened")
    .refine((value) => Number.isFinite(new Date(value).getTime()), "Enter a valid date/time"),
  notes: trimmed(2_000).default(""),
});

export type CreatePrinterLifecycleEventInput = z.infer<typeof createPrinterLifecycleEventSchema>;

export const updatePrinterSchema = z.object({
  notes: trimmed(2_000).optional(),
  status: z.enum(PRINTER_STATUSES).optional(),
  aliases: z.array(trimmed(120)).max(40).optional(),
  recommendedFepHours: z.coerce.number().positive().max(10_000).optional(),
  recommendedFepLayers: z.coerce.number().int().positive().max(10_000_000).optional(),
});

export type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>;

export const assignPrinterProfileSchema = z.object({
  profile: trimmed(200).min(1, "Choose an unassigned machine name"),
  printerId: z.coerce.number().int().positive("Choose a fleet printer"),
  /**
   * When true, map this slicer label onto one printer for all plates.
   * Leave false/omit for shared model names (Mighty 8K) — use per-plate assign instead.
   */
  applyToAllPlates: z.boolean().optional().default(true),
});

export type AssignPrinterProfileInput = z.infer<typeof assignPrinterProfileSchema>;

const supplyLineItemSchema = z.object({
  itemName: trimmed(300).min(2, "Describe each purchased item"),
  quantity: z.coerce.number().int().min(1).max(100_000).default(1),
  lineAmount: trimmed(40).default(""),
  category: z.enum(SUPPLY_CATEGORIES).optional(),
});

export const createSupplyPurchaseSchema = z
  .object({
    source: trimmed(80).default(""),
    orderReference: trimmed(120).default(""),
    itemName: trimmed(400).default(""),
    category: z.enum(SUPPLY_CATEGORIES).optional(),
    quantity: z.coerce.number().int().min(1).max(100_000).default(1),
    totalAmount: amountLike,
    purchasedAt: supplyPurchaseDate,
    notes: trimmed(1_000).default(""),
    lineItems: z.array(supplyLineItemSchema).max(40).optional(),
  })
  .superRefine((value, ctx) => {
    const lines = normalizeSupplyLineItems(value);
    if (lines.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one item you purchased",
        path: ["lineItems"],
      });
    }
  });

export type CreateSupplyPurchaseInput = z.infer<typeof createSupplyPurchaseSchema>;

export const attachPrintFileSchema = z.object({
  analysisId: z.string().uuid("Analyze the CTB file again before attaching it"),
  dealId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "Select a valid active Print Order"),
  /**
   * Physical fleet printer that ran this plate. Required when Chitubox only
   * embeds a shared model name (e.g. Mighty 8K) shared by NEWX1/2/3.
   */
  printerId: z.coerce.number().int().positive("Choose which printer ran this plate").optional(),
});

export type AttachPrintFileInput = z.infer<typeof attachPrintFileSchema>;

export const assignPrintFilePrinterSchema = z.object({
  recordId: z.coerce.number().int().positive("Choose a plate record"),
  printerId: z.coerce.number().int().positive("Choose a fleet printer"),
});

export type AssignPrintFilePrinterInput = z.infer<typeof assignPrintFilePrinterSchema>;

const kitBitStatusSchema = z.enum(["needed", "on_plate", "good", "reprint"]);

const kitBitSchema = z.object({
  id: z.string().trim().min(1).max(200),
  fileName: z.string().trim().min(1).max(400),
  label: z.string().trim().min(1).max(400),
  group: z.string().trim().min(1).max(200),
  status: kitBitStatusSchema,
  plateId: z.string().trim().max(200).nullable(),
});

const kitPlateSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  ctbFileName: z.string().trim().max(400).default(""),
  createdAt: z.string().trim().min(1),
  bitIds: z.array(z.string().trim().min(1).max(200)).max(500),
  printFileRecordId: z.number().int().positive().nullable().optional(),
});

export const kitTrackerSchema = z.object({
  name: z.string().trim().min(1).max(300),
  hubspotDealId: z.string().trim().max(40).nullable().optional(),
  hubspotDealName: z.string().trim().max(300).nullable().optional(),
  bits: z.array(kitBitSchema).max(2_000),
  plates: z.array(kitPlateSchema).max(500),
  updatedAt: z.string().trim().optional(),
});

export type KitTrackerDocument = z.infer<typeof kitTrackerSchema>;

export const upsertKitSchema = z.object({
  kit: kitTrackerSchema,
});

export type UpsertKitInput = z.infer<typeof upsertKitSchema>;

export const upsertResinProfileSchema = z.object({
  name: trimmed(200).min(2, "Enter the resin name"),
  amazonAsin: trimmed(20)
    .default("")
    .refine((value) => value === "" || /^[A-Z0-9]{10}$/i.test(value), "Enter a valid Amazon ASIN"),
  amazonUrl: trimmed(500).default(""),
  bottleMassG: z.coerce.number().positive().max(100_000).default(1000),
  bottleVolumeMl: z.coerce.number().positive().max(100_000).optional().nullable(),
  bottlePriceUsd: amountLike,
  notes: trimmed(1_000).default(""),
});

export type UpsertResinProfileInput = z.infer<typeof upsertResinProfileSchema>;

export const resinProfiles = sqliteTable("resin_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  amazonAsin: text("amazon_asin").notNull().default(""),
  amazonUrl: text("amazon_url").notNull().default(""),
  bottleMassG: text("bottle_mass_g").notNull(),
  bottleVolumeMl: text("bottle_volume_ml"),
  bottlePriceUsd: text("bottle_price_usd").notNull(),
  priceSource: text("price_source").notNull().default("manual"),
  priceFetchedAt: text("price_fetched_at"),
  notes: text("notes").notNull().default(""),
  isActive: integer("is_active").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ResinProfile = typeof resinProfiles.$inferSelect;

export const RESIN_BOTTLE_STATUSES = ["open", "empty", "archived"] as const;
export type ResinBottleStatus = (typeof RESIN_BOTTLE_STATUSES)[number];

/** Catalog + sealed on-hand count for a resin SKU. */
export const resinProducts = sqliteTable("resin_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  brand: text("brand").notNull().default("ELEGOO"),
  bottleMassG: text("bottle_mass_g").notNull().default("1000"),
  bottleVolumeMl: text("bottle_volume_ml"),
  unitCostUsd: text("unit_cost_usd").notNull().default("0"),
  sealedCount: integer("sealed_count").notNull().default(0),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ResinProduct = typeof resinProducts.$inferSelect;

/** A physical bottle once opened (or emptied). Sealed stock lives on resin_products. */
export const resinBottles = sqliteTable("resin_bottles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull(),
  status: text("status").notNull().default("open"),
  isActive: integer("is_active").notNull().default(0),
  openedAt: text("opened_at").notNull(),
  initialMassG: text("initial_mass_g").notNull(),
  remainingMassG: text("remaining_mass_g").notNull(),
  unitCostUsd: text("unit_cost_usd").notNull().default("0"),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ResinBottle = typeof resinBottles.$inferSelect;

export const resinBottleConsumptions = sqliteTable("resin_bottle_consumptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bottleId: integer("bottle_id").notNull(),
  printFileRecordId: integer("print_file_record_id"),
  hubspotDealId: text("hubspot_deal_id").notNull().default(""),
  hubspotDealName: text("hubspot_deal_name").notNull().default(""),
  dealAmount: text("deal_amount").notNull().default(""),
  resinMassG: text("resin_mass_g").notNull(),
  resinVolumeMl: text("resin_volume_ml"),
  resinCostUsd: text("resin_cost_usd"),
  createdAt: text("created_at").notNull(),
});

export type ResinBottleConsumption = typeof resinBottleConsumptions.$inferSelect;

export const upsertResinProductSchema = z.object({
  name: trimmed(200).min(2, "Enter the resin name"),
  brand: trimmed(80).default("ELEGOO"),
  bottleMassG: z.coerce.number().positive().max(100_000).default(1000),
  bottleVolumeMl: z.coerce.number().positive().max(100_000).optional().nullable(),
  unitCostUsd: z.coerce.number().min(0).max(100_000).default(0),
  sealedCount: z.coerce.number().int().min(0).max(100_000).optional(),
  notes: trimmed(2_000).default(""),
});

export type UpsertResinProductInput = z.infer<typeof upsertResinProductSchema>;

export const adjustResinSealedSchema = z.object({
  delta: z.coerce.number().int().min(-10_000).max(10_000),
  unitCostUsd: z.coerce.number().min(0).max(100_000).optional(),
  notes: trimmed(2_000).default(""),
});

export type AdjustResinSealedInput = z.infer<typeof adjustResinSealedSchema>;

export const openResinBottleSchema = z.object({
  productId: z.coerce.number().int().positive(),
  notes: trimmed(2_000).default(""),
  makeActive: z.boolean().optional().default(true),
});

export type OpenResinBottleInput = z.infer<typeof openResinBottleSchema>;

export const setActiveResinBottleSchema = z.object({
  bottleId: z.coerce.number().int().positive(),
});

export type SetActiveResinBottleInput = z.infer<typeof setActiveResinBottleSchema>;

export interface ResinBottleEconomics {
  bottleId: number;
  productId: number;
  productName: string;
  brand: string;
  status: ResinBottleStatus;
  isActive: boolean;
  openedAt: string;
  initialMassG: number;
  remainingMassG: number;
  usedMassG: number;
  usedPercent: number;
  unitCostUsd: number;
  costPerGram: number;
  materialCostUsedUsd: number;
  plateCount: number;
  distinctOrders: number;
  attributedDealRevenueUsd: number;
  roughContributionUsd: number;
  notes: string;
  recentConsumptions: Array<{
    id: number;
    dealId: string;
    dealName: string;
    resinMassG: number;
    dealAmount: number | null;
    createdAt: string;
  }>;
}

export interface ResinInventorySnapshot {
  products: Array<{
    id: number;
    name: string;
    brand: string;
    bottleMassG: number;
    bottleVolumeMl: number | null;
    unitCostUsd: number;
    sealedCount: number;
    sealedValueUsd: number;
    openBottleCount: number;
    notes: string;
  }>;
  bottles: ResinBottleEconomics[];
  activeBottle: ResinBottleEconomics | null;
  totals: {
    sealedBottles: number;
    sealedValueUsd: number;
    openBottles: number;
    resinUsedGrams: number;
    materialCostUsedUsd: number;
    attributedDealRevenueUsd: number;
  };
}

/** Owner form that mints a new one-time client link. Supports one or many line items. */
const intakeLineItemSchema = z.object({
  description: trimmed(400).min(2, "Describe each agreed item"),
  amount: nonNegativeAmountLike,
  quantity: z.coerce.number().int().min(1).max(999).default(1),
});

export const createOrderLinkSchema = z
  .object({
    internalLabel: trimmed(120).default(""),
    itemDescription: trimmed(400).default(""),
    agreedAmount: trimmed(40).default(""),
    lineItems: z.array(intakeLineItemSchema).max(20).optional(),
    paymentMethod: trimmed(80).default(""),
    paymentReference: trimmed(120).default(""),
    buyerNameHint: trimmed(120).default(""),
    buyerUsernameHint: trimmed(120).default(""),
    ownerNotes: trimmed(2000).default(""),
    expiryDays: z.coerce.number().int().min(1).max(90).default(14),
  })
  .superRefine((value, ctx) => {
    const lines = normalizeIntakeLineItems(value);
    if (lines.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add at least one item with a description and unit price",
        path: ["lineItems"],
      });
    }
  });
export type CreateOrderLinkInput = z.input<typeof createOrderLinkSchema>;

/** The public buyer form. Deliberately contains no internal cost fields. */
export const clientOrderSubmissionSchema = z.object({
  clientFullName: trimmed(120).min(2, "Enter your full name"),
  clientUsername: trimmed(120).default(""),
  clientEmail: z.string().trim().email("Enter a valid email address").max(200),
  clientPhone: trimmed(40).default(""),
  shippingRequired: z.boolean().default(true),
  shippingStreet: trimmed(200).default(""),
  shippingCity: trimmed(120).default(""),
  shippingState: trimmed(120).default(""),
  shippingPostalCode: trimmed(40).default(""),
  shippingCountry: trimmed(120).default(""),
  confirmedItem: trimmed(400).min(2, "Confirm or correct the item description"),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  clientNotes: trimmed(2000).default(""),
  clientPaymentConfirmed: z
    .boolean()
    .refine((value) => value === true, "Please confirm that you already paid for this order"),
});
export type ClientOrderSubmission = z.infer<typeof clientOrderSubmissionSchema>;

/**
 * Owner corrections applied before approval. Declared field by field on purpose:
 * `clientOrderSubmissionSchema.partial()` would keep the inner `.default("")` values,
 * so an absent key would silently blank a stored column instead of leaving it alone.
 */
export const reviewEditSchema = z.object({
  clientFullName: trimmed(120).min(2, "Enter the buyer's full name").optional(),
  clientUsername: trimmed(120).optional(),
  clientEmail: z.string().trim().email("Enter a valid email address").max(200).optional(),
  clientPhone: trimmed(40).optional(),
  shippingRequired: z.boolean().optional(),
  shippingStreet: trimmed(200).optional(),
  shippingCity: trimmed(120).optional(),
  shippingState: trimmed(120).optional(),
  shippingPostalCode: trimmed(40).optional(),
  shippingCountry: trimmed(120).optional(),
  confirmedItem: trimmed(400).min(2, "Confirm or correct the item description").optional(),
  quantity: z.coerce.number().int().min(1).max(999).optional(),
  clientNotes: trimmed(2000).optional(),
  agreedAmount: amountLike.optional(),
  itemDescription: trimmed(400).optional(),
  paymentMethod: trimmed(80).optional(),
  paymentReference: trimmed(120).optional(),
  ownerNotes: trimmed(2000).optional(),
  clientPaymentConfirmed: z.boolean().optional(),
});
export type ReviewEditInput = z.infer<typeof reviewEditSchema>;

/** Contact and shipping copied from a previous submitted order. */
export interface ClientOrderSavedDetails {
  clientFullName: string;
  clientUsername: string;
  clientEmail: string;
  clientPhone: string;
  shippingRequired: boolean;
  shippingStreet: string;
  shippingCity: string;
  shippingState: string;
  shippingPostalCode: string;
  shippingCountry: string;
}

/** Owner-only match used when creating a returning-buyer link, or after they submit. */
export interface PriorClientMatch extends ClientOrderSavedDetails {
  lastSubmittedAt: string | null;
  lastItemDescription: string;
  lastInternalLabel: string;
  matchedBy: "email" | "username" | "email_and_username";
  hubspotContactId: string | null;
  hubspotDealId: string | null;
}

/** What the public client page is allowed to see once a token validates. */
export interface ClientOrderView {
  itemDescription: string;
  agreedAmount: string;
  lineItems: OrderIntakeLineItem[];
  expiresAt: string;
  buyerNameHint: string;
  buyerUsernameHint: string;
  /** Present when this private link was prepared for a returning buyer. */
  savedDetails: ClientOrderSavedDetails | null;
}

export interface CreatedOrderLink {
  link: OrderIntakeLink;
  /** Returned exactly once. Never stored, never logged. */
  token: string;
  url: string;
}
