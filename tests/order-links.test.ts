/**
 * Client order link workflow tests.
 *
 * Covers token hashing, expiry, single-submission enforcement, queue state
 * transitions, and the hard rule that a client submission never reaches HubSpot.
 * A throwaway SQLite file and a localhost mock HubSpot API keep the run offline.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";

const dbFile = path.join(os.tmpdir(), `order-links-test-${crypto.randomUUID()}.db`);
process.env.ORDER_LINKS_DB_FILE = dbFile;
const OWNER_CODE = "test-owner-code";
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");

const store = await import("../server/lib/order-links");
const { registerRoutes } = await import("../server/routes");
const { orderIntakeLinks } = await import("../shared/schema");
const { eq } = await import("drizzle-orm");

interface MockCall {
  method: string;
  url: string;
}

let mock: http.Server;
let mockCalls: MockCall[] = [];
let app: http.Server;
let appBase = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

const ownerHeaders = {
  "content-type": "application/json",
  "x-paid-order-access-code": OWNER_CODE,
};

async function ownerRequest(method: string, url: string, body?: unknown) {
  const res = await fetch(`${appBase}${url}`, {
    method,
    headers: ownerHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function publicRequest(url: string, body: unknown) {
  const res = await fetch(`${appBase}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const submission = {
  clientFullName: "Jane Smith",
  clientUsername: "jane.prints",
  clientEmail: "jane@example.com",
  clientPhone: "619-555-0199",
  shippingRequired: true,
  shippingStreet: "123 Resin Way",
  shippingCity: "San Diego",
  shippingState: "CA",
  shippingPostalCode: "92101",
  shippingCountry: "United States",
  confirmedItem: "Acastus Knight Porphyrion",
  quantity: 2,
  clientNotes: "Please pack the banner separately.",
  clientPaymentConfirmed: true,
};

function newLink(overrides: Partial<{ expiryDays: number }> = {}) {
  return store.createOrderLink({
    internalLabel: "MIG-1001",
    itemDescription: "Acastus Knight Porphyrion",
    agreedAmount: "350",
    paymentMethod: "Zelle",
    paymentReference: "ZL-88213",
    buyerNameHint: "Jane",
    buyerUsernameHint: "jane.prints",
    ownerNotes: "Agreed on Marketplace chat.",
    expiryDays: 14,
    ...overrides,
  });
}

test("the server automatically assigns a readable order reference when none is supplied", () => {
  const created = store.createOrderLink({
    itemDescription: "Automatically numbered test order",
    agreedAmount: "125",
    expiryDays: 14,
  });
  assert.match(created.link.internalLabel, /^PO-\d{8}-\d{6}$/);
  assert.equal(store.getOrderLink(created.link.id)?.internalLabel, created.link.internalLabel);
});

before(async () => {
  mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mockCalls.push({ method: req.method || "", url: req.url || "" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "901", properties: { firstname: "Jane", lastname: "Smith" } }));
    });
  });
  const mockPort = await listen(mock);
  process.env.HUBSPOT_API_BASE = `http://127.0.0.1:${mockPort}`;
  process.env.HUBSPOT_ACCESS_TOKEN = "test-token";
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_URL;
  delete process.env.CUSTOM_CRED_API_HUBAPI_COM_TOKEN;

  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  const appPort = await listen(app);
  appBase = `http://127.0.0.1:${appPort}`;
});

after(() => {
  mock?.close();
  app?.close();
  store.resetOrderLinkStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

test("link tokens are high entropy and only their SHA-256 hash is stored", () => {
  const created = newLink();
  // 32 random bytes, base64url encoded => 43 characters, 256 bits of entropy.
  assert.equal(created.token.length, 43);
  assert.match(created.token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(created.token, newLink().token);

  const row = store
    .getDb()
    .select()
    .from(orderIntakeLinks)
    .where(eq(orderIntakeLinks.id, created.link.id))
    .get();
  assert.ok(row);
  assert.equal(row.tokenHash, crypto.createHash("sha256").update(created.token).digest("hex"));
  assert.equal(row.tokenHash.length, 64);
  assert.notEqual(row.tokenHash, created.token);
  // The raw token appears nowhere in the persisted row.
  assert.equal(JSON.stringify(row).includes(created.token), false);
  assert.equal(store.hashLinkToken(created.token), row.tokenHash);
  assert.equal(created.url, `/#/client-order/${created.token}`);
});

test("a valid token exposes only client-safe order details", () => {
  const created = newLink();
  const lookup = store.lookupClientOrder(created.token);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;
  assert.deepEqual(Object.keys(lookup.view).sort(), [
    "agreedAmount",
    "buyerNameHint",
    "buyerUsernameHint",
    "expiresAt",
    "itemDescription",
  ]);
  assert.equal(JSON.stringify(lookup.view).includes("MIG-1001"), false);
  assert.equal(JSON.stringify(lookup.view).includes("ZL-88213"), false);
});

test("an unknown token is rejected without revealing anything", () => {
  const lookup = store.lookupClientOrder(store.generateLinkToken());
  assert.deepEqual(lookup, { ok: false, reason: "invalid" });
});

test("an expired link rejects both lookup and submission", () => {
  const created = newLink();
  store
    .getDb()
    .update(orderIntakeLinks)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(orderIntakeLinks.id, created.link.id))
    .run();

  assert.deepEqual(store.lookupClientOrder(created.token), { ok: false, reason: "expired" });
  assert.deepEqual(store.submitClientOrder(created.token, submission), {
    ok: false,
    reason: "expired",
  });
  assert.equal(store.getOrderLink(created.link.id)?.status, "expired");
});

test("a link accepts exactly one buyer submission", () => {
  const created = newLink();
  assert.deepEqual(store.submitClientOrder(created.token, submission), { ok: true });
  assert.equal(store.getOrderLink(created.link.id)?.status, "pending_review");

  const duplicate = store.submitClientOrder(created.token, submission);
  assert.deepEqual(duplicate, { ok: false, reason: "already-submitted" });
  assert.deepEqual(store.lookupClientOrder(created.token), {
    ok: false,
    reason: "already-submitted",
  });
});

test("queue state transitions follow awaiting -> pending -> created", () => {
  const created = newLink();
  assert.equal(created.link.status, "awaiting_client");

  store.submitClientOrder(created.token, submission);
  assert.equal(store.getOrderLink(created.link.id)?.status, "pending_review");

  const edited = store.applyReviewEdits(created.link.id, { clientFullName: "Jane A. Smith" });
  assert.equal(edited?.clientFullName, "Jane A. Smith");

  const approved = store.markOrderLinkCreated(created.link.id, {
    contactId: "5001",
    dealId: "9001",
    dealName: "Acastus Knight Porphyrion - Jane A. Smith",
  });
  assert.equal(approved?.status, "created");
  assert.equal(approved?.hubspotDealId, "9001");

  // Creation cannot happen twice, edits stop, and the link cannot be expired.
  assert.equal(store.markOrderLinkCreated(created.link.id, { contactId: "1", dealId: "2", dealName: "x" }), null);
  assert.equal(store.applyReviewEdits(created.link.id, { clientFullName: "Someone Else" })?.clientFullName, "Jane A. Smith");
  assert.equal(store.expireOrderLink(created.link.id)?.status, "created");
  assert.deepEqual(store.lookupClientOrder(created.token), {
    ok: false,
    reason: "already-submitted",
  });
});

test("the owner can manually expire a link that is still awaiting details", () => {
  const created = newLink();
  assert.equal(store.expireOrderLink(created.link.id)?.status, "expired");
  assert.deepEqual(store.submitClientOrder(created.token, submission), {
    ok: false,
    reason: "expired",
  });
});

test("owner management routes require the intake access code", async () => {
  const res = await fetch(`${appBase}/api/order-links`);
  assert.equal(res.status, 401);
  const created = await fetch(`${appBase}/api/order-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ internalLabel: "X", itemDescription: "Y", agreedAmount: "10" }),
  });
  assert.equal(created.status, 401);
});

test("performance and supply routes require the owner code, and supply records never call HubSpot", async () => {
  const performanceBlocked = await fetch(`${appBase}/api/performance`);
  assert.equal(performanceBlocked.status, 401);
  const suppliesBlocked = await fetch(`${appBase}/api/supplies`);
  assert.equal(suppliesBlocked.status, 401);

  mockCalls = [];
  const saved = await ownerRequest("POST", "/api/supplies", {
    itemName: "Elegoo ABS-like resin",
    totalAmount: "38.99",
    purchasedAt: "2026-08-03",
    quantity: 1,
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.purchase.category, "materials");
  assert.equal(mockCalls.length, 0, "saving a supply purchase stays local");

  const listed = await ownerRequest("GET", "/api/supplies");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.purchases.some((purchase: { id: number }) => purchase.id === saved.body.purchase.id));
  assert.equal(mockCalls.length, 0, "reading supply purchases stays local");
});

test("a client submission writes to the queue and never calls HubSpot", async () => {
  const create = await ownerRequest("POST", "/api/order-links", {
    internalLabel: "MIG-2002",
    itemDescription: "Titan bust",
    agreedAmount: "180",
    expiryDays: 14,
  });
  assert.equal(create.status, 201);
  const token: string = create.body.token;
  assert.equal(create.body.link.tokenHash, undefined);

  mockCalls = [];
  const lookup = await publicRequest("/api/client-order/lookup", { token });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.view.itemDescription, "Titan bust");

  const submit = await publicRequest("/api/client-order/submit", { token, ...submission });
  assert.equal(submit.status, 201);
  assert.equal(mockCalls.length, 0, "client submission must not reach HubSpot");

  const duplicate = await publicRequest("/api/client-order/submit", { token, ...submission });
  assert.equal(duplicate.status, 410);
  assert.equal(duplicate.body.reason, "already-submitted");
  assert.equal(JSON.stringify(duplicate.body).includes("MIG-2002"), false);
  assert.equal(mockCalls.length, 0);

  const queue = await ownerRequest("GET", "/api/order-links?status=pending_review");
  assert.equal(queue.status, 200);
  assert.equal(
    queue.body.links.some((link: { internalLabel: string }) => link.internalLabel === "MIG-2002"),
    true,
  );
  assert.equal(mockCalls.length, 0);
});

test("approval requires verified payment and creates HubSpot records once", async () => {
  const create = await ownerRequest("POST", "/api/order-links", {
    internalLabel: "MIG-3003",
    itemDescription: "Dropfleet cruiser set",
    agreedAmount: "220",
  });
  const token: string = create.body.token;
  const id: number = create.body.link.id;
  await publicRequest("/api/client-order/submit", { token, ...submission });

  mockCalls = [];
  const unverified = await ownerRequest("POST", `/api/order-links/${id}/create-order`, {});
  assert.equal(unverified.status, 400);
  assert.match(unverified.body.error, /verified the payment/);
  assert.equal(mockCalls.length, 0);

  const approved = await ownerRequest("POST", `/api/order-links/${id}/create-order`, {
    paymentVerified: true,
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.result.dealStage, "4096856781");
  assert.equal(approved.body.result.pipeline, "default");
  assert.equal(approved.body.link.status, "created");
  assert.equal(approved.body.link.hubspotDealId, "901");
  assert.ok(mockCalls.length >= 2, "approval performs the HubSpot writes");

  const repeat = await ownerRequest("POST", `/api/order-links/${id}/create-order`, {
    paymentVerified: true,
  });
  assert.equal(repeat.status, 409);
  assert.match(repeat.body.error, /already created/);
});

test("owner review edits and manual expiry work over the API", async () => {
  const create = await ownerRequest("POST", "/api/order-links", {
    internalLabel: "MIG-4004",
    itemDescription: "Custom terrain",
    agreedAmount: "95",
  });
  const token: string = create.body.token;
  const id: number = create.body.link.id;
  await publicRequest("/api/client-order/submit", { token, ...submission });

  const edited = await ownerRequest("PATCH", `/api/order-links/${id}`, {
    clientFullName: "Jane Q. Smith",
    agreedAmount: "105",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.link.clientFullName, "Jane Q. Smith");
  assert.equal(edited.body.link.agreedAmount, "105");

  const expired = await ownerRequest("POST", `/api/order-links/${id}/expire`);
  assert.equal(expired.status, 200);
  assert.equal(expired.body.link.status, "expired");

  const rejected = await publicRequest("/api/client-order/lookup", { token });
  assert.equal(rejected.status, 410);
});

test("a partial owner edit leaves untouched buyer fields intact", async () => {
  const create = await ownerRequest("POST", "/api/order-links", {
    internalLabel: "MIG-4005",
    itemDescription: "Ork trukk conversion",
    agreedAmount: "140",
  });
  const token: string = create.body.token;
  const id: number = create.body.link.id;
  await publicRequest("/api/client-order/submit", { token, ...submission });

  const edited = await ownerRequest("PATCH", `/api/order-links/${id}`, { quantity: 4 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.link.quantity, 4);
  // Regression: an absent key must not blank the stored column.
  assert.equal(edited.body.link.shippingStreet, submission.shippingStreet);
  assert.equal(edited.body.link.shippingCity, submission.shippingCity);
  assert.equal(edited.body.link.clientPhone, submission.clientPhone);
  assert.equal(edited.body.link.clientNotes, submission.clientNotes);
  assert.equal(edited.body.link.clientUsername, submission.clientUsername);
});
