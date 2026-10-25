import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.INBOX_DB_FILE = ":memory:";

const { classifySellerMail, normalizeSellerMailBatch, SELLER_MAIL_QUERIES } = await import("../shared/inbox-mail");
const store = await import("../server/lib/inbox-cards-store");
const { registerInboxRoutes } = await import("../server/lib/inbox-routes");

test("seller mail queries target buyer notifications and name the three shops", () => {
  assert.match(SELLER_MAIL_QUERIES.ebay, /members\.ebay/);
  assert.match(SELLER_MAIL_QUERIES.ebay, /sent a message/);
  assert.match(SELLER_MAIL_QUERIES.etsy, /Etsy Conversation/);
  assert.match(SELLER_MAIL_QUERIES.myminifactory, /You have a new message/);
});

test("seller mail classification keeps buyer notifications and drops listing and promo mail", () => {
  assert.equal(classifySellerMail({
    from: "eBay - buyer_one <abc@members.ebay.com>",
    subject: "Re: shop sent a message about Sample Fig #123456789012",
  }), "ebay");
  assert.equal(classifySellerMail({
    from: "eBay - buyer_one <abc@members.ebay.com.hk>",
    subject: "shop sent a message about Sample Fig #123456789012",
  }), "ebay");
  assert.equal(classifySellerMail({
    from: "eBay <ebay@ebay.com>",
    subject: "Sample Fig has been listed",
  }), null);
  assert.equal(classifySellerMail({
    from: "Etsy <no-reply@account.etsy.com>",
    subject: "Etsy Conversation with Pat from SampleShop about Order #100",
  }), "etsy");
  assert.equal(classifySellerMail({
    from: "Etsy Conversations <conversations@mail.etsy.com>",
    subject: "You have an unread message!",
  }), "etsy");
  assert.equal(classifySellerMail({
    from: "Etsy <email@email.etsy.com>",
    subject: "Fresh finds for the shop",
  }), null);
  assert.equal(classifySellerMail({
    from: "MyMiniFactory <no-reply@myminifactory.com>",
    subject: "You have a new message",
  }), "myminifactory");
  assert.equal(classifySellerMail({
    from: "MyMiniFactory <newsletter@tx.myminifactory.com>",
    subject: "FINAL 48 HOURS",
  }), null);
  assert.equal(classifySellerMail({
    from: "Facebook Marketplace <noreply@facebookmail.com>",
    subject: "You have a new message",
  }), null);
});

test("seller mail batch groups one thread, skips noise, and does not invent text", () => {
  const { cards, skipped } = normalizeSellerMailBatch([
    {
      id: "m1",
      threadId: "t1",
      from: "eBay - buyer_one <abc@members.ebay.com>",
      subject: "Re: shop sent a message about Sample Fig #123456789012",
      snippet: "Is this available?",
      date: "2026-10-20T18:00:00Z",
    },
    {
      id: "m2",
      threadId: "t1",
      from: "eBay - buyer_one <abc@members.ebay.com>",
      subject: "Re: shop sent a message about Sample Fig #123456789012",
      text: "Still there?",
      date: "2026-10-21T18:00:00Z",
    },
    {
      id: "promo",
      from: "eBay <ebay@ebay.com>",
      subject: "Sample Fig has been listed",
      snippet: "selling tips",
      date: "2026-10-21T19:00:00Z",
    },
    {
      id: "blank",
      channel: "etsy",
      from: "Etsy <no-reply@account.etsy.com>",
      subject: "   ",
      snippet: "",
      text: "",
    },
  ]);
  assert.equal(skipped, 2);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].source, "ebay");
  assert.equal(cards[0].id, "gmail.ebay.t1");
  assert.equal(cards[0].name, "buyer_one");
  assert.equal(cards[0].listing, "Sample Fig");
  assert.equal(cards[0].history.length, 2);
  assert.equal(cards[0].history[0].text, "Is this available?");
  assert.equal(cards[0].lastMessage, "Still there?");
  assert.equal(cards[0].owesReply, true);
  assert.equal(cards[0].lastSpeaker, "buyer");
});

test("ingest route merges seller mail, leaves other channels, and never queues a send", async () => {
  store.resetInboxStoreForTests();
  process.env.INBOX_PUSH_TOKEN = "m".repeat(32);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const owner = (req: express.Request, res: express.Response) => {
    if (req.get("x-paid-order-access-code") === "owner") return false;
    res.status(401).json({ ok: false });
    return true;
  };
  registerInboxRoutes(app, owner, (_req, res) => (res.status(401).end(), true));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = { Authorization: `Bearer ${"m".repeat(32)}`, "Content-Type": "application/json" };
  const ownerH = { "x-paid-order-access-code": "owner" };
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/inbox/ingest", { "Content-Type": "application/json" }, { messages: [] })).status, 401);
    const first = await post("/api/inbox/ingest", token, {
      messages: [
        {
          id: "e1",
          threadId: "thread-ebay",
          from: "eBay - buyer_one <abc@members.ebay.com>",
          subject: "shop sent a message about Sample Fig #123456789012",
          text: "Can you print this?",
          date: "2026-10-24T16:00:00Z",
        },
        {
          id: "y1",
          threadId: "thread-etsy",
          from: "Etsy <no-reply@account.etsy.com>",
          subject: "Etsy Conversation with Pat from SampleShop",
          snippet: "Pat sent you a message",
          date: "2026-10-24T17:00:00Z",
        },
      ],
    });
    assert.equal(first.status, 200);
    const again = await post("/api/inbox/ingest", token, {
      messages: [
        {
          id: "e2",
          threadId: "thread-ebay",
          from: "eBay - buyer_one <abc@members.ebay.com>",
          subject: "Re: shop sent a message about Sample Fig #123456789012",
          text: "Any update?",
          date: "2026-10-25T16:00:00Z",
        },
        {
          id: "fb",
          from: "Marketplace <note@facebookmail.com>",
          subject: "New marketplace message",
          text: "this must not be stored",
          channel: "facebook",
        },
      ],
    });
    const body = await again.json();
    assert.equal(again.status, 200);
    assert.equal(body.received, 1);
    assert.equal(body.skipped, 1);
    const list = await (await fetch(`${base}/api/inbox/cards`, { headers: ownerH })).json();
    assert.deepEqual(list.cards.map((c: { source: string }) => c.source).sort(), ["ebay", "etsy"]);
    const ebay = list.cards.find((c: { source: string }) => c.source === "ebay");
    assert.equal(ebay.history.length, 2);
    assert.equal(ebay.lastMessage, "Any update?");
    assert.equal(list.buyerSend, "off");
    assert.ok(list.lastIngestAt);
    const send = await post("/api/inbox/cards/" + ebay.id + "/send", { ...token, "x-paid-order-access-code": "owner" }, {
      text: "reply",
      idempotencyKey: "send-abcdefgh",
    });
    assert.equal(send.status, 403);
    assert.equal(store.listOutbound().length, 0);
  } finally {
    server.close();
    delete process.env.INBOX_PUSH_TOKEN;
  }
});
