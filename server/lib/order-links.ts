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
  type ClientOrderSubmission,
  type ClientOrderView,
  type CreateOrderLinkInput,
  type CreatedOrderLink,
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
  hubspot_deal_name TEXT
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

let db: BetterSQLite3Database | null = null;

function databaseFile(): string {
  const configured = process.env.ORDER_LINKS_DB_FILE?.trim();
  if (configured) return configured === ":memory:" ? configured : path.resolve(configured);
  return path.resolve(process.cwd(), "data.db");
}

export function getDb(): BetterSQLite3Database {
  if (db) return db;
  const file = databaseFile();
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(CREATE_TABLE_SQL);
  sqlite.exec(CREATE_SUPPLY_PURCHASES_SQL);
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
  input: Required<Pick<CreateOrderLinkInput, "itemDescription" | "agreedAmount">> &
    Omit<CreateOrderLinkInput, "itemDescription" | "agreedAmount">,
  baseUrl = "",
): CreatedOrderLink {
  const token = generateLinkToken();
  const expiryDays = Number(input.expiryDays ?? 14);
  const initial = getDb()
    .insert(orderIntakeLinks)
    .values({
      tokenHash: hashLinkToken(token),
      status: "awaiting_client",
      internalLabel: input.internalLabel || "Generating reference",
      itemDescription: input.itemDescription,
      agreedAmount: input.agreedAmount,
      paymentMethod: input.paymentMethod ?? "",
      paymentReference: input.paymentReference ?? "",
      buyerNameHint: input.buyerNameHint ?? "",
      buyerUsernameHint: input.buyerUsernameHint ?? "",
      ownerNotes: input.ownerNotes ?? "",
      createdAt: nowIso(),
      expiresAt: addDays(Number.isFinite(expiryDays) && expiryDays > 0 ? expiryDays : 14),
      confirmedItem: "",
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
  hubspot: { contactId: string; dealId: string; dealName: string },
): OrderIntakeLink | null {
  const changed = getDb()
    .update(orderIntakeLinks)
    .set({
      status: "created",
      decidedAt: nowIso(),
      hubspotContactId: hubspot.contactId,
      hubspotDealId: hubspot.dealId,
      hubspotDealName: hubspot.dealName,
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
