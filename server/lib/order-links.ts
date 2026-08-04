/**
 * Persistent storage for one-time client order links.
 *
 * Storage: SQLite (`data.db` in the project root) through Drizzle + better-sqlite3.
 * The table is created on first use, so no migration step is required.
 *
 * Security notes:
 * - The link token is 256 bits of CSPRNG randomness, base64url encoded.
 * - Only its SHA-256 hash is stored. The raw token is returned once, by
 *   `createOrderLink`, and is never persisted, logged, or echoed back later.
 * - A client submission only ever writes to this table. HubSpot is untouched
 *   until the owner explicitly approves the intake.
 */
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  orderIntakeLinks,
  lineItemsForIntake,
  normalizeIntakeLineItems,
  summarizeIntakeLineItems,
  type ClientOrderSubmission,
  type ClientOrderView,
  type CreateOrderLinkInput,
  type CreatedOrderLink,
  type HubSpotIntakeDealRef,
  type OrderIntakeLink,
  type OrderIntakeStatus,
  type ReviewEditInput,
} from "../../shared/schema";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS order_intake_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  internal_label TEXT NOT NULL,
  item_description TEXT NOT NULL,
  agreed_amount TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT '',
  payment_reference TEXT NOT NULL DEFAULT '',
  buyer_name_hint TEXT NOT NULL DEFAULT '',
  buyer_username_hint TEXT NOT NULL DEFAULT '',
  owner_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  submitted_at TEXT,
  decided_at TEXT,
  client_full_name TEXT NOT NULL DEFAULT '',
  client_username TEXT NOT NULL DEFAULT '',
  client_email TEXT NOT NULL DEFAULT '',
  client_phone TEXT NOT NULL DEFAULT '',
  shipping_required INTEGER NOT NULL DEFAULT 0,
  shipping_street TEXT NOT NULL DEFAULT '',
  shipping_city TEXT NOT NULL DEFAULT '',
  shipping_state TEXT NOT NULL DEFAULT '',
  shipping_postal_code TEXT NOT NULL DEFAULT '',
  shipping_country TEXT NOT NULL DEFAULT '',
  confirmed_item TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  client_notes TEXT NOT NULL DEFAULT '',
  client_payment_confirmed INTEGER NOT NULL DEFAULT 0,
  hubspot_contact_id TEXT,
  hubspot_deal_id TEXT,
  hubspot_deal_name TEXT,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  hubspot_deals_json TEXT NOT NULL DEFAULT '[]'
);
`;

const CREATE_SUPPLY_PURCHASES_SQL = `
CREATE TABLE IF NOT EXISTS supply_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'Amazon',
  order_reference TEXT NOT NULL DEFAULT '',
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  total_amount TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

const CREATE_PRINT_FILE_ANALYSES_SQL = `
CREATE TABLE IF NOT EXISTS print_file_analyses (
  id TEXT PRIMARY KEY,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

const CREATE_PRINT_FILE_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS print_file_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id TEXT NOT NULL,
  hubspot_deal_id TEXT NOT NULL,
  hubspot_deal_name TEXT NOT NULL,
  deal_stage TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  format_revision TEXT NOT NULL,
  print_time_seconds INTEGER,
  resin_volume_ml TEXT,
  resin_mass_g TEXT,
  resin_cost TEXT,
  resin_density_g_per_ml TEXT,
  layer_count INTEGER,
  layer_height_mm TEXT,
  model_height_mm TEXT,
  exposure_seconds TEXT,
  bottom_exposure_seconds TEXT,
  light_off_seconds TEXT,
  bottom_light_off_seconds TEXT,
  bottom_layer_count INTEGER,
  lift_distance_mm TEXT,
  lift_speed_mm_per_min TEXT,
  bottom_lift_distance_mm TEXT,
  bottom_lift_speed_mm_per_min TEXT,
  retract_speed_mm_per_min TEXT,
  resolution_x INTEGER,
  resolution_y INTEGER,
  printer_profile TEXT,
  hubspot_synced_at TEXT NOT NULL,
  attached_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS print_file_records_deal_id_idx
  ON print_file_records (hubspot_deal_id, attached_at DESC);
`;

const CREATE_RESIN_PROFILES_SQL = `
CREATE TABLE IF NOT EXISTS resin_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amazon_asin TEXT NOT NULL DEFAULT '',
  amazon_url TEXT NOT NULL DEFAULT '',
  bottle_mass_g TEXT NOT NULL,
  bottle_volume_ml TEXT,
  bottle_price_usd TEXT NOT NULL,
  price_source TEXT NOT NULL DEFAULT 'manual',
  price_fetched_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Columns added after the first Print Files release. Safe on existing Railway volumes. */
const PRINT_FILE_RECORD_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["resin_cost", "TEXT"],
  ["resin_cost_source", "TEXT"],
  ["resin_cost_label", "TEXT"],
  ["resin_density_g_per_ml", "TEXT"],
  ["model_height_mm", "TEXT"],
  ["exposure_seconds", "TEXT"],
  ["bottom_exposure_seconds", "TEXT"],
  ["light_off_seconds", "TEXT"],
  ["bottom_light_off_seconds", "TEXT"],
  ["bottom_layer_count", "INTEGER"],
  ["lift_distance_mm", "TEXT"],
  ["lift_speed_mm_per_min", "TEXT"],
  ["bottom_lift_distance_mm", "TEXT"],
  ["bottom_lift_speed_mm_per_min", "TEXT"],
  ["retract_speed_mm_per_min", "TEXT"],
];

function ensurePrintFileRecordColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (
      sqlite.prepare("PRAGMA table_info(print_file_records)").all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const [name, type] of PRINT_FILE_RECORD_COLUMN_MIGRATIONS) {
    if (existing.has(name)) continue;
    sqlite.exec(`ALTER TABLE print_file_records ADD COLUMN ${name} ${type}`);
  }
}

const ORDER_INTAKE_COLUMN_MIGRATIONS: Array<[string, string]> = [
  ["line_items_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["hubspot_deals_json", "TEXT NOT NULL DEFAULT '[]'"],
];

function ensureOrderIntakeColumns(sqlite: Database.Database): void {
  const existing = new Set(
    (
      sqlite.prepare("PRAGMA table_info(order_intake_links)").all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const [name, type] of ORDER_INTAKE_COLUMN_MIGRATIONS) {
    if (existing.has(name)) continue;
    sqlite.exec(`ALTER TABLE order_intake_links ADD COLUMN ${name} ${type}`);
  }
}

let db: BetterSQLite3Database | null = null;

function databaseFile(): string {
  const configured = process.env.ORDER_LINKS_DB_FILE?.trim();
  if (configured) return configured === ":memory:" ? configured : path.resolve(configured);
  return path.resolve(process.cwd(), "data.db");
}

/** Public readiness info for intakes, print boards, resin profiles, and supplies. */
export function describeOrderLinksStorage(): {
  configured: boolean;
  ephemeral: boolean;
  durableVolumeLikely: boolean;
  warning: string | null;
} {
  const configuredRaw = process.env.ORDER_LINKS_DB_FILE?.trim() ?? "";
  const configured = configuredRaw.length > 0;
  const file = databaseFile();
  const ephemeral = file === ":memory:" || !configured;
  const normalized = file.replace(/\\/g, "/");
  const durableVolumeLikely =
    configured && file !== ":memory:" && (normalized === "/data" || normalized.startsWith("/data/"));
  let warning: string | null = null;
  if (file === ":memory:") {
    warning =
      "SQLite is in-memory — intakes, plate boards, resin profiles, and supply history reset on restart.";
  } else if (!configured) {
    warning =
      "ORDER_LINKS_DB_FILE is unset — data.db under the app directory may be wiped on redeploy. Point it at a mounted volume such as /data/hubspot.db.";
  } else if (!durableVolumeLikely) {
    warning =
      "ORDER_LINKS_DB_FILE is set outside /data — confirm this path is on a persistent volume before relying on it.";
  }
  return { configured, ephemeral, durableVolumeLikely, warning };
}

export function getDb(): BetterSQLite3Database {
  if (db) return db;
  const file = databaseFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(CREATE_TABLE_SQL);
  sqlite.exec(CREATE_SUPPLY_PURCHASES_SQL);
  sqlite.exec(CREATE_PRINT_FILE_ANALYSES_SQL);
  sqlite.exec(CREATE_PRINT_FILE_RECORDS_SQL);
  sqlite.exec(CREATE_RESIN_PROFILES_SQL);
  ensurePrintFileRecordColumns(sqlite);
  ensureOrderIntakeColumns(sqlite);
  db = drizzle(sqlite);
  return db;
}

/** Test helper: drop the cached handle so a new DB file can be used. */
export function resetOrderLinkStore(): void {
  db = null;
}

/* ------------------------------------------------------------------ token */

/** 256 bits of randomness — well above the 128-bit minimum. */
export function generateLinkToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashLinkToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function clientLinkPath(token: string): string {
  return `/#/client-order/${token}`;
}

/* ------------------------------------------------------------------ helpers */

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function generatedOrderReference(id: number, createdAt: string): string {
  const date = createdAt.slice(0, 10).replaceAll("-", "");
  return `PO-${date}-${String(id).padStart(6, "0")}`;
}

function isExpired(link: OrderIntakeLink, at = nowIso()): boolean {
  return link.expiresAt <= at;
}

/**
 * A link that ran past its expiry while still awaiting the buyer is expired.
 * Expiry is materialised lazily so the queue and the public page agree.
 */
function settleExpiry(link: OrderIntakeLink): OrderIntakeLink {
  if (link.status !== "awaiting_client" || !isExpired(link)) return link;
  getDb()
    .update(orderIntakeLinks)
    .set({ status: "expired", decidedAt: nowIso() })
    .where(and(eq(orderIntakeLinks.id, link.id), eq(orderIntakeLinks.status, "awaiting_client")))
    .run();
  return { ...link, status: "expired" };
}

/* ------------------------------------------------------------------ owner */

export function createOrderLink(
  input: CreateOrderLinkInput,
  baseUrl = "",
): CreatedOrderLink {
  const token = generateLinkToken();
  const expiryDays = Number(input.expiryDays ?? 14);
  const lines = normalizeIntakeLineItems(input);
  const summary = summarizeIntakeLineItems(lines);
  const initial = getDb()
    .insert(orderIntakeLinks)
    .values({
      tokenHash: hashLinkToken(token),
      status: "awaiting_client",
      internalLabel: input.internalLabel || "Generating reference",
      itemDescription: summary.itemDescription,
      agreedAmount: summary.agreedAmount,
      lineItemsJson: JSON.stringify(lines),
      paymentMethod: input.paymentMethod ?? "",
      paymentReference: input.paymentReference ?? "",
      buyerNameHint: input.buyerNameHint ?? "",
      buyerUsernameHint: input.buyerUsernameHint ?? "",
      ownerNotes: input.ownerNotes ?? "",
      createdAt: nowIso(),
      expiresAt: addDays(Number.isFinite(expiryDays) && expiryDays > 0 ? expiryDays : 14),
      confirmedItem: "",
      hubspotDealsJson: "[]",
    })
    .returning()
    .get();
  const internalLabel = input.internalLabel || generatedOrderReference(initial.id, initial.createdAt);
  if (initial.internalLabel !== internalLabel) {
    getDb().update(orderIntakeLinks).set({ internalLabel }).where(eq(orderIntakeLinks.id, initial.id)).run();
  }
  const link = { ...initial, internalLabel };

  return {
    link,
    token,
    url: `${baseUrl.replace(/\/+$/, "")}${clientLinkPath(token)}`,
  };
}

export function listOrderLinks(status?: OrderIntakeStatus): OrderIntakeLink[] {
  const rows = getDb().select().from(orderIntakeLinks).orderBy(desc(orderIntakeLinks.id)).all();
  const settled = rows.map(settleExpiry);
  return status ? settled.filter((row) => row.status === status) : settled;
}

export function getOrderLink(id: number): OrderIntakeLink | null {
  const row = getDb().select().from(orderIntakeLinks).where(eq(orderIntakeLinks.id, id)).get();
  return row ? settleExpiry(row) : null;
}

export function expireOrderLink(id: number): OrderIntakeLink | null {
  const link = getOrderLink(id);
  if (!link) return null;
  if (link.status === "created") return link;
  getDb()
    .update(orderIntakeLinks)
    .set({ status: "expired", decidedAt: nowIso() })
    .where(eq(orderIntakeLinks.id, id))
    .run();
  return getOrderLink(id);
}

/** Owner corrections. Only allowed while the intake is still pending review. */
export function applyReviewEdits(id: number, edits: ReviewEditInput): OrderIntakeLink | null {
  const link = getOrderLink(id);
  if (!link) return null;
  if (link.status !== "pending_review") return link;
  const patch: Partial<OrderIntakeLink> = {};
  const assign = <K extends keyof OrderIntakeLink>(key: K, value: OrderIntakeLink[K] | undefined) => {
    if (value !== undefined) patch[key] = value;
  };
  assign("clientFullName", edits.clientFullName);
  assign("clientUsername", edits.clientUsername);
  assign("clientEmail", edits.clientEmail);
  assign("clientPhone", edits.clientPhone);
  assign("shippingRequired", edits.shippingRequired);
  assign("shippingStreet", edits.shippingStreet);
  assign("shippingCity", edits.shippingCity);
  assign("shippingState", edits.shippingState);
  assign("shippingPostalCode", edits.shippingPostalCode);
  assign("shippingCountry", edits.shippingCountry);
  assign("confirmedItem", edits.confirmedItem);
  assign("quantity", edits.quantity);
  assign("clientNotes", edits.clientNotes);
  assign("clientPaymentConfirmed", edits.clientPaymentConfirmed);
  assign("agreedAmount", edits.agreedAmount);
  assign("itemDescription", edits.itemDescription);
  assign("paymentMethod", edits.paymentMethod);
  assign("paymentReference", edits.paymentReference);
  assign("ownerNotes", edits.ownerNotes);
  if (Object.keys(patch).length === 0) return link;
  getDb().update(orderIntakeLinks).set(patch).where(eq(orderIntakeLinks.id, id)).run();
  return getOrderLink(id);
}

export function markOrderLinkCreated(
  id: number,
  hubspot: {
    contactId: string;
    deals: HubSpotIntakeDealRef[];
  },
): OrderIntakeLink | null {
  const primary = hubspot.deals[0];
  if (!primary) return null;
  const changed = getDb()
    .update(orderIntakeLinks)
    .set({
      status: "created",
      decidedAt: nowIso(),
      hubspotContactId: hubspot.contactId,
      hubspotDealId: primary.dealId,
      hubspotDealName: primary.dealName,
      hubspotDealsJson: JSON.stringify(hubspot.deals),
    })
    .where(and(eq(orderIntakeLinks.id, id), eq(orderIntakeLinks.status, "pending_review")))
    .run();
  if (changed.changes === 0) return null;
  return getOrderLink(id);
}

/* ------------------------------------------------------------------ public */

export type ClientLookupResult =
  | { ok: true; view: ClientOrderView }
  | { ok: false; reason: "invalid" | "expired" | "already-submitted" };

/**
 * Public token lookup. Returns nothing owner-side: no internal label, no
 * payment reference, no owner notes, no queue state details.
 */
export function lookupClientOrder(token: string): ClientLookupResult {
  const raw = getDb()
    .select()
    .from(orderIntakeLinks)
    .where(eq(orderIntakeLinks.tokenHash, hashLinkToken(token)))
    .get();
  if (!raw) return { ok: false, reason: "invalid" };
  const link = settleExpiry(raw);
  if (link.status === "pending_review" || link.status === "created") {
    return { ok: false, reason: "already-submitted" };
  }
  if (link.status !== "awaiting_client") return { ok: false, reason: "expired" };
  return {
    ok: true,
    view: {
      itemDescription: link.itemDescription,
      agreedAmount: link.agreedAmount,
      lineItems: lineItemsForIntake(link),
      expiresAt: link.expiresAt,
      buyerNameHint: link.buyerNameHint,
      buyerUsernameHint: link.buyerUsernameHint,
    },
  };
}

export type ClientSubmitResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "already-submitted" };

/**
 * Accepts exactly one buyer submission per link. The status guard lives in the
 * UPDATE's WHERE clause, so a duplicate or racing submission changes zero rows
 * and is rejected without leaking any order details.
 */
export function submitClientOrder(token: string, input: ClientOrderSubmission): ClientSubmitResult {
  const lookup = lookupClientOrder(token);
  if (!lookup.ok) return lookup;
  const changed = getDb()
    .update(orderIntakeLinks)
    .set({
      status: "pending_review",
      submittedAt: nowIso(),
      clientFullName: input.clientFullName,
      clientUsername: input.clientUsername,
      clientEmail: input.clientEmail,
      clientPhone: input.clientPhone,
      shippingRequired: input.shippingRequired,
      shippingStreet: input.shippingRequired ? input.shippingStreet : "",
      shippingCity: input.shippingRequired ? input.shippingCity : "",
      shippingState: input.shippingRequired ? input.shippingState : "",
      shippingPostalCode: input.shippingRequired ? input.shippingPostalCode : "",
      shippingCountry: input.shippingRequired ? input.shippingCountry : "",
      confirmedItem: input.confirmedItem,
      quantity: input.quantity,
      clientNotes: input.clientNotes,
      clientPaymentConfirmed: input.clientPaymentConfirmed,
    })
    .where(
      and(
        eq(orderIntakeLinks.tokenHash, hashLinkToken(token)),
        eq(orderIntakeLinks.status, "awaiting_client"),
        sql`${orderIntakeLinks.expiresAt} > ${nowIso()}`,
      ),
    )
    .run();
  if (changed.changes === 0) return { ok: false, reason: "already-submitted" };
  return { ok: true };
}

export function orderLinkCounts(): Record<OrderIntakeStatus, number> {
  const all = listOrderLinks();
  return {
    awaiting_client: all.filter((row) => row.status === "awaiting_client").length,
    pending_review: all.filter((row) => row.status === "pending_review").length,
    created: all.filter((row) => row.status === "created").length,
    expired: all.filter((row) => row.status === "expired").length,
  };
}
