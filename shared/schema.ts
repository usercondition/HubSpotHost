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
  supplySpend: {
    periodDays: number;
    total: number;
    purchases: number;
    byCategory: Array<{
      category: SupplyCategory;
      label: string;
      total: number;
      count: number;
    }>;
  };
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
    detail: string;
    severity: "neutral" | "warn" | "bad";
  }>;
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

export type ResinCostSource = "ctb" | "amazon" | "supplies" | "manual";

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
        .filter((item) => item.description.length >= 2 && parseAmountNumber(item.amount) > 0)
    : [];
  if (fromArray.length > 0) return fromArray.slice(0, 20);

  const description = String(input.itemDescription ?? "").trim();
  const amount = String(input.agreedAmount ?? "").trim();
  if (description.length >= 2 && parseAmountNumber(amount) > 0) {
    return [{ description, amount, quantity: 1 }];
  }
  return [];
}

export function summarizeIntakeLineItems(lines: OrderIntakeLineItem[]): {
  itemDescription: string;
  agreedAmount: string;
} {
  if (lines.length === 0) return { itemDescription: "", agreedAmount: "0" };
  const total = lines.reduce((sum, line) => sum + parseAmountNumber(line.amount), 0);
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
});

export type SupplyPurchase = typeof supplyPurchases.$inferSelect;

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
export interface PrintFileMetrics {
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  format: "CTB";
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
  hubspotSyncedAt: text("hubspot_synced_at").notNull(),
  attachedAt: text("attached_at").notNull(),
});

export type PrintFileRecord = typeof printFileRecords.$inferSelect;

export interface PrintFileCandidateDeal {
  dealId: string;
  dealName: string;
  stage: string;
  hasPrintFile: boolean;
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

const supplyPurchaseDate = z
  .string()
  .trim()
  .min(1, "Enter the purchase date")
  .refine((value) => Number.isFinite(new Date(value).getTime()), "Enter a valid purchase date");

export const createSupplyPurchaseSchema = z.object({
  source: trimmed(80).default("Amazon"),
  orderReference: trimmed(120).default(""),
  itemName: trimmed(300).min(2, "Enter the item you purchased"),
  category: z.enum(SUPPLY_CATEGORIES).optional(),
  quantity: z.coerce.number().int().min(1).max(100_000).default(1),
  totalAmount: amountLike,
  purchasedAt: supplyPurchaseDate,
  notes: trimmed(1_000).default(""),
});

export type CreateSupplyPurchaseInput = z.infer<typeof createSupplyPurchaseSchema>;

export const attachPrintFileSchema = z.object({
  analysisId: z.string().uuid("Analyze the CTB file again before attaching it"),
  dealId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "Select a valid active Print Order"),
});

export type AttachPrintFileInput = z.infer<typeof attachPrintFileSchema>;

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

/** Owner form that mints a new one-time client link. Supports one or many line items. */
const intakeLineItemSchema = z.object({
  description: trimmed(400).min(2, "Describe each agreed item"),
  amount: amountLike,
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
        message: "Add at least one item with a description and amount",
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

/** What the public client page is allowed to see once a token validates. */
export interface ClientOrderView {
  itemDescription: string;
  agreedAmount: string;
  lineItems: OrderIntakeLineItem[];
  expiresAt: string;
  buyerNameHint: string;
  buyerUsernameHint: string;
}

export interface CreatedOrderLink {
  link: OrderIntakeLink;
  /** Returned exactly once. Never stored, never logged. */
  token: string;
  url: string;
}
