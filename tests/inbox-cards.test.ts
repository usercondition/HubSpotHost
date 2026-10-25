import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.INBOX_DB_FILE = ":memory:";

const { normalizeInboxPayload, normalizeInboxCard, shopToday, channelForSource } = await import("../shared/inbox");
const store = await import("../server/lib/inbox-cards-store");
const { registerInboxRoutes } = await import("../server/lib/inbox-routes");
const { buildFollowupDigest, runFollowupReminders } = await import("../server/lib/followup-reminders");
const { followupToNotionProperties, writeFollowupToNotion } = await import("../server/lib/notion-followups");

/** Synthetic card shaped like Hermes' marketplace.json (v1, Oct 2026). */
function hermesCard(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    source: "facebook_marketplace",
    name: "Dave",
    listing: "Resin 3D Printing for Tabletop",
    listing_url: "https://www.facebook.com/marketplace/item/1/",
    last_message: "Thank you",
    last_message_at: "2026-10-13T19:38",
    time_label: "7:38 PM",
    last_speaker: "buyer",
    owes_reply: true,
    needs_you: true,
    category: "hot",
    stage: "inquiry",
    next_action: "send proxy options",
    suggested_reply: "want me to send pics?",
    thread_url: "https://www.facebook.com/marketplace/inbox",
    thread_hint: "Open the Selling inbox and click Dave",
    messages_read: 31,
    first_seen: "2026-10-13T21:05:49",
    last_scraped: "2026-10-13T21:34:10",
    history: [],
    thread: [{ who: "buyer", when: "x", at: null, text: "old" }],
    recent: [{ who: "buyer", when: "7:38 PM", text: "Thank you" }, { who: "buyer", when: "7:38 PM", text: "" }],
    risk: null,
    analysis: {
      summary: "Needs Necron bits",
      client_wants: { items: "gate", qty: "1" },
      agreed: { price: "$49.99", timeline: "" },
      open_questions: ["photos"],
      stage: "inquiry",
      risk_flags: ["zelle"],
      confidence: 0.85,
      suggested_reply: "analysis reply",
      brand_new_field: { anything: true },
    },
    ...over,
  };
}

test("normalizes the Hermes file shape and tolerates new analysis fields", () => {
  const { cards, updatedAt, rejected } = normalizeInboxPayload({
    version: 1,
    updated_at: "2026-10-13T21:34:10",
    threads: { a1: hermesCard("a1"), bad: { id: "../etc" }, b2: { name: "Only name" } },
  });
  assert.equal(updatedAt, "2026-10-13T21:34:10");
  assert.equal(rejected, 1);
  const a = cards.find((c) => c.id === "a1")!;
  assert.equal(a.analysis?.confidence, 0.85);
  assert.deepEqual(a.analysis?.riskFlags, ["zelle"]);
  assert.equal(a.analysis?.agreed.price, "$49.99");
  assert.deepEqual(a.analysis?.extra, { brand_new_field: { anything: true } });
  assert.equal(a.recent.length, 1, "empty messages dropped; recent preferred over thread");
  const b = cards.find((c) => c.id === "b2")!;
  assert.equal(b.name, "Only name");
  assert.equal(b.analysis, null);
});

test("analysis-only fields fill in and odd types are coerced", () => {
  const card = normalizeInboxCard({ id: "x", analysis: { stage: "printing", next_action: "ship", suggested_reply: "hi", confidence: "70", risk_flags: "late", agreed: "cash" }, listing_url: "javascript:alert(1)" })!;
  assert.equal(card.stage, "printing");
  assert.equal(card.nextAction, "ship");
  assert.equal(card.suggestedReply, "hi");
  assert.equal(card.analysis?.confidence, 0.7);
  assert.deepEqual(card.analysis?.riskFlags, ["late"]);
  assert.deepEqual(card.analysis?.agreed, { note: "cash" });
  assert.equal(card.listingUrl, "", "non-https URLs dropped");
  assert.equal(card.source, "unknown", "a missing source is not treated as Facebook");
  assert.equal(channelForSource("offerup"), "OfferUp");
  assert.equal(channelForSource("ebay"), "eBay");
  assert.equal(channelForSource("Etsy"), "Etsy");
  assert.equal(channelForSource("mmf"), "MMF");
  assert.equal(channelForSource("facebook_marketplace"), "Marketplace");
  assert.equal(shopToday(new Date("2026-10-14T05:00:00Z")), "2026-10-13");
});

test("store: push, edit with version guard, status, reopen on new buyer message", () => {
  store.resetInboxStoreForTests();
  const first = normalizeInboxPayload({ threads: { s1: hermesCard("s1"), s2: hermesCard("s2") } }).cards;
  assert.deepEqual(store.upsertInboxCards(first, null), { received: 2, changed: 2, reopened: 0, removed: 0 });
  assert.equal(store.upsertInboxCards(first, null).changed, 0, "unchanged push is a no-op");

  const e1 = store.saveReplyEdit("s1", "edited", 0);
  assert.equal(e1.version, 1);
  assert.throws(() => store.saveReplyEdit("s1", "stale", 0), store.VersionConflictError);
  assert.equal(store.listReplyEditsSince(null).length, 1);
  assert.equal(store.listReplyEditsSince(e1.editedAt).length, 0);

  store.setCardStatus("s1", "replied");
  assert.equal(store.getInboxCard("s1")?.status, "replied");
  const newer = normalizeInboxPayload({ threads: { s1: hermesCard("s1", { last_message_at: "2026-10-14T08:00", last_message: "any update?" }) } }).cards;
  const r = store.upsertInboxCards(newer, null);
  assert.equal(r.reopened, 1);
  assert.equal(r.removed, 1, "s2 vanished from the file");
  assert.equal(store.getInboxCard("s1")?.status, "open");
  assert.equal(store.getInboxCard("s1")?.editedReply, "edited");
  assert.deepEqual(store.listInboxCards().map((c) => c.id), ["s1"]);
});

test("store: a push replaces only cards from the channels it contains", () => {
  store.resetInboxStoreForTests();
  const ebay = normalizeInboxPayload({ threads: { e1: hermesCard("e1", { source: "ebay" }) } }).cards;
  const etsy = normalizeInboxPayload({ threads: { y1: hermesCard("y1", { source: "Etsy" }) } }).cards;
  store.upsertInboxCards(ebay, null);
  const r = store.upsertInboxCards(etsy, null);
  assert.equal(r.removed, 0, "an Etsy push does not retire eBay chats");
  assert.deepEqual(store.listInboxCards().map((c) => c.id).sort(), ["e1", "y1"]);
  assert.equal(store.purgePausedFacebookCards(), 0);
  store.upsertInboxCards(normalizeInboxPayload({ threads: { fb: hermesCard("fb") } }).cards, null);
  assert.equal(store.purgePausedFacebookCards(), 1);
  assert.equal(store.getInboxCard("fb"), null);
  assert.deepEqual(store.listInboxCards().map((c) => c.id).sort(), ["e1", "y1"]);
});

test("follow-ups: due list, digest text, Notion properties", () => {
  store.resetInboxStoreForTests();
  const f = store.createFollowup({
    cardId: "c1", client: "Matt <M>", listing: "Mega print", listingUrl: "", channel: "Marketplace",
    said: "sent refund", nextAction: "confirm Zelle", reminderDate: "2026-10-12", outcome: "handled", stage: "dead", hubspotUrl: "",
  });
  store.createFollowup({ cardId: null, client: "Later", listing: "", listingUrl: "", channel: "Other", said: "", nextAction: "", reminderDate: "2026-12-01", outcome: "replied", stage: "", hubspotUrl: "" });
  const due = store.listDueFollowups("2026-10-13");
  assert.deepEqual(due.map((d) => d.id), [f.id]);
  const text = buildFollowupDigest(due, "2026-10-13", "https://example.test")!;
  assert.match(text, /Matt &lt;M&gt;/);
  assert.match(text, /overdue since 2026-10-12/);
  assert.match(text, /#\/inbox\?tab=followups/);
  assert.equal(buildFollowupDigest([], "2026-10-13"), null);
  const props = followupToNotionProperties(f) as any;
  assert.equal(props.Name.title[0].text.content, "Matt <M> – Mega print");
  assert.equal(props.Outcome.select.name, "Handled");
  assert.equal(props.Reminder.date.start, "2026-10-12");
  assert.equal(props["Listing URL"].url, null);
});

test("Notion writer: not configured, success, and API error", async () => {
  store.resetInboxStoreForTests();
  const f = store.createFollowup({ cardId: "c", client: "A", listing: "", listingUrl: "", channel: "Marketplace", said: "", nextAction: "", reminderDate: null, outcome: "replied", stage: "", hubspotUrl: "" });
  assert.equal((await writeFollowupToNotion(f, {})).ok, false);
  const env = { NOTION_TOKEN: "ntn_test", NOTION_FOLLOWUPS_DB_ID: "1936ac47-4875-4338-a991-41ad9e610ba2" };
  let sent: any = null;
  const okFetch = (async (url: string, init: any) => {
    sent = { url, init };
    return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await writeFollowupToNotion(f, env, okFetch);
  assert.deepEqual(r, { ok: true, pageId: "page-1", url: "https://notion.so/page-1" });
  assert.equal(sent.url, "https://api.notion.com/v1/pages");
  assert.equal(JSON.parse(sent.init.body).parent.database_id, "1936ac4748754338a99141ad9e610ba2");
  const badFetch = (async () => new Response(JSON.stringify({ message: "Could not find database" }), { status: 404 })) as unknown as typeof fetch;
  const bad = await writeFollowupToNotion(f, env, badFetch);
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /404/);
});

test("reminders run: retries Notion, sends one Telegram digest per day", async () => {
  store.resetInboxStoreForTests();
  store.createFollowup({ cardId: "c", client: "Due", listing: "", listingUrl: "", channel: "Marketplace", said: "", nextAction: "ping", reminderDate: "2026-10-13", outcome: "replied", stage: "", hubspotUrl: "" });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("notion")) return new Response(JSON.stringify({ id: "p", url: "https://notion.so/p" }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", NOTION_TOKEN: "t", NOTION_FOLLOWUPS_DB_ID: "1936ac4748754338a99141ad9e610ba2" };
  const now = new Date("2026-10-13T16:00:00Z");
  const first = await runFollowupReminders({ env, fetchImpl, now });
  assert.equal(first.sent, true);
  assert.equal(first.notionRetried, 1);
  assert.equal(first.due, 1);
  const second = await runFollowupReminders({ env, fetchImpl, now });
  assert.equal(second.sent, false);
  assert.equal(second.skipped, "already sent today");
  assert.equal(second.notionRetried, 0);
  assert.equal(calls.filter((u) => u.includes("telegram")).length, 1);
});

test("routes: push token, owner gate, mark handled logs a local follow-up", async () => {
  store.resetInboxStoreForTests();
  process.env.INBOX_PUSH_TOKEN = "x".repeat(32);
  delete process.env.NOTION_TOKEN;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const owner = (req: express.Request, res: express.Response) => {
    if (req.get("x-paid-order-access-code") === "owner") return false;
    res.status(401).json({ ok: false });
    return true;
  };
  const cron = (_req: express.Request, res: express.Response) => (res.status(401).end(), true);
  registerInboxRoutes(app, owner, cron);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const body = JSON.stringify({ threads: { r1: hermesCard("r1", { source: "etsy", name: "Pat" }), fb: hermesCard("fb") } });
    const json = { "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/inbox/cards`, { method: "POST", headers: json, body })).status, 401);
    assert.equal((await fetch(`${base}/api/inbox/cards`, { method: "POST", headers: { ...json, Authorization: "Bearer wrong" }, body })).status, 401);
    const push = await fetch(`${base}/api/inbox/cards`, { method: "POST", headers: { ...json, Authorization: `Bearer ${"x".repeat(32)}` }, body });
    assert.equal(push.status, 200);
    assert.equal((await fetch(`${base}/api/inbox/cards`)).status, 401);
    const list = await (await fetch(`${base}/api/inbox/cards`, { headers: { "x-paid-order-access-code": "owner" } })).json();
    assert.equal(list.cards.length, 1, "Facebook Marketplace cards stay out of the inbox");
    assert.equal(list.cards[0].id, "r1");
    assert.equal(list.cards[0].source, "etsy");
    assert.equal(list.buyerSend, "off");
    assert.equal(list.facebookPaused, true);
    assert.deepEqual(list.outbound, []);
    assert.equal(list.notionConfigured, false);
    const ownerJson = { ...json, "x-paid-order-access-code": "owner" };
    const send = await fetch(`${base}/api/inbox/cards/r1/send`, {
      method: "POST", headers: ownerJson, body: JSON.stringify({ text: "hello", idempotencyKey: "send-abcdefgh" }),
    });
    assert.equal(send.status, 403);
    assert.equal(store.listOutbound().length, 0, "buyer send does not queue a Mac message");
    const edit = await fetch(`${base}/api/inbox/cards/r1/reply`, { method: "PATCH", headers: ownerJson, body: JSON.stringify({ reply: "new", version: 0 }) });
    assert.equal(edit.status, 200);
    const conflict = await fetch(`${base}/api/inbox/cards/r1/reply`, { method: "PATCH", headers: ownerJson, body: JSON.stringify({ reply: "x", version: 0 }) });
    assert.equal(conflict.status, 409);
    const edits = await (await fetch(`${base}/api/inbox/edits`, { headers: { "x-inbox-push-token": "x".repeat(32) } })).json();
    assert.equal(edits.edits[0].reply, "new");
    const mark = await (await fetch(`${base}/api/inbox/cards/r1/status`, {
      method: "POST", headers: ownerJson,
      body: JSON.stringify({ status: "handled", followup: { said: "quoted $60", nextAction: "await payment", reminderDate: "2026-10-15" } }),
    })).json();
    assert.equal(mark.card.status, "handled");
    assert.equal(mark.followup.client, "Pat");
    assert.equal(mark.followup.channel, "Etsy");
    assert.equal(mark.followup.notionPageId, null);
    assert.match(mark.followup.notionError, /not configured/);
    const fus = await (await fetch(`${base}/api/followups`, { headers: { "x-paid-order-access-code": "owner" } })).json();
    assert.equal(fus.followups.length, 1);
    const bad = await fetch(`${base}/api/inbox/cards/r1/status`, { method: "POST", headers: ownerJson, body: JSON.stringify({ status: "sent" }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    delete process.env.INBOX_PUSH_TOKEN;
  }
});
