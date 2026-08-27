/**
 * Marketplace secretary inbox brief — classify threads and prioritize actions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { after, before } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { buildMarketplaceInboxBrief } from "../server/lib/marketplace-inbox-brief";

const dbFile = path.join(os.tmpdir(), `marketplace-brief-test-${crypto.randomUUID()}.db`);
const OWNER_CODE = "marketplace-brief-owner-code";
process.env.MARKETPLACE_INBOX_BRIEF_DB_FILE = dbFile;
process.env.PAID_ORDER_INTAKE_ACCESS_CODE_HASH = crypto
  .createHash("sha256")
  .update(OWNER_CODE, "utf8")
  .digest("hex");

const {
  clearMarketplaceInboxBriefs,
  createMarketplaceInboxBrief,
  getMarketplaceInboxBrief,
  resetMarketplaceInboxBriefStore,
} = await import("../server/lib/marketplace-inbox-brief-store");
const {
  clearMarketplaceScanRequest,
  getMarketplaceScanRequest,
  resetMarketplaceScanRequestStore,
  setMarketplaceScanRequest,
} = await import("../server/lib/marketplace-scan-request-store");
const { registerRoutes } = await import("../server/routes");

let app: http.Server;
let appBase = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

before(async () => {
  const expressApp = express();
  expressApp.use(express.json());
  app = http.createServer(expressApp);
  await registerRoutes(app, expressApp);
  appBase = `http://127.0.0.1:${await listen(app)}`;
});

after(() => {
  app?.close();
  resetMarketplaceInboxBriefStore();
  resetMarketplaceScanRequestStore();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* cleanup */
    }
  }
});

test("secretary brief prioritizes your-turn and paid threads", () => {
  const brief = buildMarketplaceInboxBrief([
    {
      id: "1",
      title: "Alex",
      unread: true,
      conversation: `Thread: Alex
Buyer: Hi, do you still print Acastus Knights?
Buyer: How much shipped?`,
    },
    {
      id: "2",
      title: "Sam",
      conversation: `Thread: Sam
Buyer: Paid $180 via PayPal
Buyer: Ship to 9 Oak Ave, Austin TX 78701`,
    },
    {
      id: "3",
      title: "Jordan",
      conversation: `Thread: Jordan
Buyer: Can you do a bust?
You: Let me know whenever you're ready`,
    },
  ]);

  assert.match(brief.headline, /Secretary brief/i);
  assert.ok(brief.doFirst.length >= 2);
  assert.equal(brief.doFirst[0]?.status === "your_turn" || brief.doFirst[0]?.status === "ready_to_book", true);
  const sam = brief.threads.find((t) => t.title === "Sam");
  assert.equal(sam?.status, "ready_to_book");
  const jordan = brief.threads.find((t) => t.title === "Jordan");
  assert.ok(jordan?.status === "waiting_on_buyer" || jordan?.status === "stale");
  assert.ok(brief.doFirst.some((t) => t.draftReply));
});

test("brief store replaces the previous brief instead of stacking history", () => {
  clearMarketplaceInboxBriefs();
  const first = createMarketplaceInboxBrief([
    {
      title: "Casey",
      unread: true,
      conversation: `Buyer: Ok I can do that — where do I pay?\nYou: PayPal works`,
    },
  ]);
  const second = createMarketplaceInboxBrief([
    {
      title: "Morgan",
      unread: true,
      conversation: `Buyer: Can you send a price for a Warhound?\nBuyer: I need it shipped.`,
    },
  ]);
  const loaded = getMarketplaceInboxBrief(first.id);
  assert.ok(loaded);
  assert.equal(loaded?.threadCount, 1);
  assert.equal(loaded?.threads[0]?.title, "Morgan");
  assert.equal(second.id, "latest");
});

test("latest brief API is owner-gated and returns the persistent current brief", async () => {
  clearMarketplaceInboxBriefs();
  const blocked = await fetch(`${appBase}/api/marketplace-brief/latest`);
  assert.equal(blocked.status, 401);

  const created = await fetch(`${appBase}/api/marketplace-brief`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: JSON.stringify({
      threads: [
        {
          title: "Taylor",
          unread: true,
          conversation: `Buyer: Can you print a Reaver?\nBuyer: What would it cost?`,
        },
      ],
    }),
  });
  assert.equal(created.status, 201);

  const latest = await fetch(`${appBase}/api/marketplace-brief/latest`, {
    headers: { "x-paid-order-access-code": OWNER_CODE },
  });
  const body = (await latest.json()) as { ok: boolean; brief?: { threads: Array<{ title: string }> } };
  assert.equal(latest.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.brief?.threads[0]?.title, "Taylor");
});

test("Marketplace scan request API has a public read and owner-gated persistent writes", async () => {
  clearMarketplaceScanRequest();
  const initial = await fetch(`${appBase}/api/marketplace-scan-request`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { requested: false, id: 0 });

  const blocked = await fetch(`${appBase}/api/marketplace-scan-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requested: true }),
  });
  assert.equal(blocked.status, 401);

  const armed = await fetch(`${appBase}/api/marketplace-scan-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: JSON.stringify({ requested: true }),
  });
  const armedBody = (await armed.json()) as { ok: boolean; requested: boolean; id: number };
  assert.equal(armed.status, 201);
  assert.deepEqual(armedBody, { ok: true, requested: true, id: 1 });

  const armedRead = await fetch(`${appBase}/api/marketplace-scan-request`);
  assert.deepEqual(await armedRead.json(), { requested: true, id: armedBody.id });

  resetMarketplaceScanRequestStore();
  assert.deepEqual(getMarketplaceScanRequest(), { requested: true, id: armedBody.id });

  const replaced = await fetch(`${appBase}/api/marketplace-scan-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: JSON.stringify({ requested: true }),
  });
  const replacedBody = (await replaced.json()) as { ok: boolean; requested: boolean; id: number };
  assert.deepEqual(replacedBody, { ok: true, requested: true, id: armedBody.id + 1 });

  const cleared = await fetch(`${appBase}/api/marketplace-scan-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paid-order-access-code": OWNER_CODE,
    },
    body: JSON.stringify({ requested: false }),
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ok: true, requested: false, id: replacedBody.id });
});
