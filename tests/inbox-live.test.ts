import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.INBOX_DB_FILE = ":memory:";

const { normalizeInboxPayload } = await import("../shared/inbox");
const store = await import("../server/lib/inbox-cards-store");
const { registerInboxRoutes } = await import("../server/lib/inbox-routes");
const live = await import("../client/src/lib/inbox-live");

const T0 = new Date("2026-10-18T00:40:00Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

function card(id: string, over: Record<string, unknown> = {}) {
  return {
    id, source: "facebook_marketplace", name: "Demo Buyer", listing: "Demo listing", last_message: "hi", last_message_at: "2026-10-17T14:37",
    last_speaker: "buyer", owes_reply: true, category: "question",
    thread: [
      { who: "buyer", when: "x", at: "2026-10-17T14:30", text: "is this available" },
      { who: "miguel", when: "x", at: "2026-10-17T14:31", text: "yes" },
      { who: "buyer", when: "x", at: "2026-10-17T14:37", text: "hi" },
    ],
    recent: [{ who: "buyer", when: "x", text: "hi" }],
    ...over,
  };
}

test("payload: full history only when the Mac flags it; excluded (personal) ids never stored", () => {
  const old = normalizeInboxPayload({ threads: { a: card("a") } });
  assert.equal(old.cards[0].history.length, 0, "older Mac script: no history field use");
  const p = normalizeInboxPayload({ threads: { a: card("a", { full_history: true }), p: card("p", { full_history: true }) }, exclude_ids: ["p", "bad id!"] });
  assert.deepEqual(p.excludeIds, ["p"]);
  assert.equal(p.cards.length, 1);
  assert.equal(p.cards[0].history.length, 3);
});

test("purge removes a personal chat that was already stored, with its edits and queued sends", () => {
  store.resetInboxStoreForTests();
  const { cards } = normalizeInboxPayload({ threads: { a: card("a"), p: card("p") } });
  store.upsertInboxCards(cards, "2026-10-17T14:38:49", T0);
  store.saveReplyEdit("p", "x");
  store.queueOutbound("p", "x", "send-personal-1", T0);
  assert.equal(store.purgeInboxCards(["p"]), 1);
  assert.equal(store.getInboxCard("p"), null);
  assert.equal(store.listOutbound(T0).length, 0);
  assert.equal(store.listReplyEditsSince(null).length, 0);
});

test("send queue: idempotency key dedupes, conflicting reuse rejected, claim once, result, retry by owner only", () => {
  store.resetInboxStoreForTests();
  store.upsertInboxCards(normalizeInboxPayload({ threads: { a: card("a") } }).cards, null, T0);
  const first = store.queueOutbound("a", "sounds good", "send-key-0001", T0);
  const again = store.queueOutbound("a", "sounds good", "send-key-0001", plus(1000));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.outbound.id, first.outbound.id);
  assert.throws(() => store.queueOutbound("a", "different", "send-key-0001"), store.OutboundKeyConflictError);
  assert.equal(store.listOutbound(T0).length, 1);

  const claimed = store.claimOutbound(3, plus(2000));
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "sending");
  assert.equal(store.claimOutbound(3, plus(3000)).length, 0, "a claimed send is never handed out twice");
  assert.equal(store.retryOutbound(first.outbound.id), null, "cannot retry while sending");
  assert.equal(store.finishOutbound(first.outbound.id, 2, "sent", "", plus(4000)), null, "wrong attempt ignored");
  const failed = store.finishOutbound(first.outbound.id, 1, "failed", "needs login", plus(4000));
  assert.equal(failed?.status, "failed");
  assert.equal(store.finishOutbound(first.outbound.id, 1, "sent", "", plus(5000)), null, "late duplicate result ignored");
  const retried = store.retryOutbound(first.outbound.id, plus(6000));
  assert.equal(retried?.status, "queued");
  assert.equal(retried?.attempt, 2);
  store.claimOutbound(3, plus(7000));
  const sent = store.finishOutbound(first.outbound.id, 2, "sent", "", plus(8000));
  assert.equal(sent?.status, "sent");
  assert.ok(sent?.sentAt);
  assert.equal(store.retryOutbound(first.outbound.id), null, "a sent message cannot be retried");
});

test("send queue: a claim with no result for 10 min becomes unverified (never auto re-sent)", () => {
  store.resetInboxStoreForTests();
  store.upsertInboxCards(normalizeInboxPayload({ threads: { a: card("a") } }).cards, null, T0);
  const q = store.queueOutbound("a", "ok", "send-key-0002", T0);
  store.claimOutbound(3, T0);
  const later = store.listOutbound(plus(11 * 60_000)).find((o) => o.id === q.outbound.id);
  assert.equal(later?.status, "unverified");
  assert.match(later!.detail, /Check Messenger/);
  assert.equal(store.claimOutbound(3, plus(12 * 60_000)).length, 0);
});

test("refresh: open respects 15 min freshness, manual bypasses it with a 60 s cooldown, one in flight", () => {
  store.resetInboxStoreForTests();
  store.upsertInboxCards(normalizeInboxPayload({ threads: { a: card("a") } }).cards, "2026-10-17T17:34:05", T0);
  const open = store.requestInboxRefresh("open", plus(60_000));
  assert.equal(open.queued, false);
  assert.equal(open.queued === false && open.reason, "fresh");
  const m1 = store.requestInboxRefresh("manual", plus(61_000));
  assert.equal(m1.queued, true);
  const dup = store.requestInboxRefresh("manual", plus(62_000));
  assert.equal(dup.queued === false && dup.reason, "in_progress");
  const c = store.claimRefresh(plus(63_000));
  assert.equal(c?.status, "running");
  assert.equal(store.claimRefresh(plus(64_000)), null);
  assert.ok(store.finishRefresh(c!.id, true, "15 threads", plus(100_000)));
  const cool = store.requestInboxRefresh("manual", plus(110_000));
  assert.equal(cool.queued === false && cool.reason, "cooldown");
  assert.equal(store.requestInboxRefresh("manual", plus(130_000)).queued, true);
  // Stale running request fails after 10 min so the UI never spins forever.
  store.claimRefresh(plus(131_000));
  assert.equal(store.latestRefresh(plus(131_000 + 11 * 60_000))?.status, "failed");
  // Old data -> opening the Inbox queues a read.
  assert.equal(store.requestInboxRefresh("open", plus(60 * 60_000)).queued, true);
});

test("thread merge after a send appends only new tail messages and never shortens history", () => {
  store.resetInboxStoreForTests();
  store.upsertInboxCards(normalizeInboxPayload({ threads: { a: card("a", { full_history: true }) } }).cards, null, T0);
  const r = store.mergeThreadRead("a", [
    { who: "miguel", when: "", at: null, text: "yes" },
    { who: "buyer", when: "", at: null, text: "hi" },
    { who: "miguel", when: "", at: null, text: "sounds good" },
  ]);
  assert.deepEqual(r, { ok: true, added: 1 });
  const c = store.getInboxCard("a")!;
  assert.equal(c.history.length, 4);
  assert.equal(c.lastMessage, "sounds good");
  assert.equal(c.owesReply, false);
  assert.deepEqual(store.mergeThreadRead("a", [{ who: "buyer", when: "", at: null, text: "hi" }]), { ok: true, added: 0 });
  assert.equal(store.mergeThreadRead("nope", []).ok, false);
});

test("routes: owner gate on refresh/send/retry, push token on Mac endpoints, heartbeat, live flag", async () => {
  store.resetInboxStoreForTests();
  const TOKEN = "t".repeat(32);
  process.env.INBOX_PUSH_TOKEN = TOKEN;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const owner = (req: express.Request, res: express.Response) => {
    if (req.get("x-paid-order-access-code") === "owner") return false;
    res.status(401).json({ ok: false });
    return true;
  };
  registerInboxRoutes(app, owner, (_q, res) => (res.status(401).end(), true));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { "Content-Type": "application/json" };
  const ownerH = { ...json, "x-paid-order-access-code": "owner" };
  const macH = { ...json, Authorization: `Bearer ${TOKEN}` };
  const post = (p: string, h: Record<string, string>, b: unknown) => fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) });
  try {
    await post("/api/inbox/cards", macH, {
      updated_at: "2026-10-17T17:34:05",
      threads: {
        a: card("a", { source: "ebay", full_history: true }),
        fb: card("fb", { source: "facebook_marketplace" }),
        z: card("z", { source: "ebay" }),
      },
      exclude_ids: ["z"],
    });
    assert.equal((await post("/api/inbox/refresh", json, { reason: "manual" })).status, 401);
    assert.equal((await post("/api/inbox/cards/a/send", json, { text: "x", idempotencyKey: "send-abcdefgh" })).status, 401);
    assert.equal((await post("/api/inbox/mac/poll", ownerH, { live: true })).status, 401, "owner code is not the push token");
    assert.equal((await post("/api/inbox/cards/a/send", ownerH, { text: "x", idempotencyKey: "bad" })).status, 400);
    assert.equal((await post("/api/inbox/cards/missing/send", ownerH, { text: "x", idempotencyKey: "send-abcdefgh" })).status, 404);
    const s1 = await post("/api/inbox/cards/a/send", ownerH, { text: "on my way", idempotencyKey: "send-abcdefgh" });
    assert.equal(s1.status, 403, "buyer send stays off");
    assert.equal(store.listOutbound().length, 0);
    const refresh = await (await post("/api/inbox/refresh", ownerH, { reason: "manual" })).json();
    assert.equal(refresh.queued, false);
    assert.equal(refresh.reason, "paused");
    assert.equal(store.latestRefresh(), null, "a refresh tap does not queue a Facebook read");

    const off = await (await post("/api/inbox/mac/poll", macH, { live: false })).json();
    assert.deepEqual(off.outbound, []);
    assert.equal(off.refresh, null);
    const on = await (await post("/api/inbox/mac/poll", macH, { live: true })).json();
    assert.deepEqual(on.outbound, [], "the Mac poll does not claim a buyer send");
    assert.equal(on.refresh, null, "the Mac poll does not claim a Facebook refresh");
    assert.equal((await post("/api/inbox/mac/thread/a", macH, { messages: [{ who: "miguel", text: "on my way" }] })).status, 200);

    const list = await (await fetch(`${base}/api/inbox/cards`, { headers: ownerH })).json();
    assert.equal(list.cards.length, 1, "Facebook chat hidden and personal chat excluded");
    assert.equal(list.cards[0].source, "ebay");
    assert.equal(list.cards[0].history.length, 4);
    assert.ok(list.lastCheckinAt);
    assert.equal(list.buyerSend, "off");
    assert.equal(list.refresh, null);
    assert.deepEqual(list.outbound, []);
    // Old Mac script (GET edits only) also counts as a check-in.
    store.setInboxMeta("last_checkin_at", "2000-01-01T00:00:00Z");
    await fetch(`${base}/api/inbox/edits`, { headers: macH });
    assert.notEqual(store.getMeta("last_checkin_at"), "2000-01-01T00:00:00Z");
  } finally {
    server.close();
    delete process.env.INBOX_PUSH_TOKEN;
  }
});

test("client helpers: Pacific times, pending bubbles, labels, keys, drafts", () => {
  assert.equal(new Date(live.parsePacific("2026-10-17T17:34")!).toISOString(), "2026-10-18T00:34:00.000Z");
  assert.equal(new Date(live.parsePacific("2026-12-01T09:00")!).toISOString(), "2026-12-01T17:00:00.000Z");
  assert.equal(live.parsePacific("2026-10-18T00:34:00Z"), Date.parse("2026-10-18T00:34:00Z"));
  assert.equal(live.parsePacific(null), null);
  const c = { id: "a", recent: [], history: [{ who: "miguel", when: "", at: null, text: "On my  way" }] };
  const ob = (status: string, text: string, cardId = "a") => ({ id: text, cardId, text, idempotencyKey: "k", status, detail: "", attempt: 1, createdAt: "", updatedAt: "", sentAt: null }) as never;
  const pend = live.outboundForCard(c, [ob("sent", "on my way"), ob("sent", "new one"), ob("failed", "on my way"), ob("queued", "x", "b")]);
  assert.deepEqual(pend.map((o: { text: string; status: string }) => `${o.status}:${o.text}`), ["sent:new one", "failed:on my way"]);
  assert.equal(live.outboundLabel({ status: "failed", detail: "needs login", attempt: 1 }).canRetry, true);
  assert.equal(live.outboundLabel({ status: "sending", detail: "", attempt: 1 }).canRetry, false);
  assert.equal(live.outboundLabel({ status: "sent", detail: "", attempt: 1 }).text, "Sent");
  const now = Date.parse("2026-10-18T00:40:00Z");
  assert.equal(live.heartbeatLabel("2026-10-18T00:39:30Z", null, now).stale, false);
  assert.equal(live.heartbeatLabel(null, "2026-10-17T21:43:00Z", now).stale, true);
  assert.match(live.heartbeatLabel("2026-10-18T00:39:30Z", null, now).text, /checked in 5:39 PM PT/);
  assert.match(live.newIdempotencyKey(() => "1234-abcd"), /^send-1234-abcd$/);
  assert.ok(/^[A-Za-z0-9_-]{8,80}$/.test(live.newIdempotencyKey()));
  const mem = new Map<string, string>();
  const st = { setItem: (k: string, v: string) => mem.set(k, v), removeItem: (k: string) => mem.delete(k), getItem: (k: string) => mem.get(k) ?? null };
  live.saveComposerDraft("a", "use this", st);
  assert.equal(live.loadComposerDraft("a", st), "use this");
  live.saveComposerDraft("a", "", st);
  assert.equal(live.loadComposerDraft("a", st), "");
  assert.equal(live.refreshLabel({ id: "", reason: "manual", status: "running", detail: "", requestedAt: "", startedAt: null, finishedAt: null }), "Refreshing… reading Facebook");
  assert.match(live.refreshLabel({ id: "", reason: "manual", status: "failed", detail: "FB needs login on the Mac", requestedAt: "", startedAt: null, finishedAt: null }), /needs login/);
});

test("Needs me: one predicate for the Chats filter and every count (open, not spam, owes reply or needs Miguel)", () => {
  const base = { status: "open", category: "question", needsYou: false, owesReply: false } as const;
  assert.equal(live.needsMe({ ...base, owesReply: true }), true);
  assert.equal(live.needsMe({ ...base, needsYou: true }), true);
  assert.equal(live.needsMe(base), false);
  assert.equal(live.needsMe({ ...base, owesReply: true, category: "spam" }), false);
  assert.equal(live.needsMe({ ...base, owesReply: true, status: "replied" }), false);
  const cards = normalizeInboxPayload({ threads: { a: card("a"), b: card("b", { owes_reply: false }), c: card("c", { owes_reply: false, needs_you: true }), s: card("s", { category: "spam" }) } }).cards;
  assert.equal(cards.map((c) => ({ ...c, status: "open" })).filter(live.needsMe).length, 2);
});

test("risk text joins card risk, analysis flags and note", () => {
  const [c] = normalizeInboxPayload({ threads: { a: card("a", { risk: "Wants it shipped tomorrow", analysis: { risk_flags: ["low budget"], risk_note: "asked twice" } }) } }).cards;
  assert.equal(live.riskText(c), "Wants it shipped tomorrow · low budget · asked twice");
  assert.equal(live.riskText(normalizeInboxPayload({ threads: { b: card("b") } }).cards[0]), "");
});

test("inbox gaps: photo/attachment-only messages are kept (thumbnail or placeholder) and not-in-latest chats are flagged", () => {
  const p = normalizeInboxPayload({
    threads: {
      a: card("a", {
        full_history: true,
        thread: [
          { who: "buyer", when: "x", at: "2026-10-17T14:30", text: "pic", attachments: [] },
          { who: "buyer", when: "x", at: "2026-10-17T14:31", text: "", attachments: [{ kind: "image", thumb: "https://scontent.example/t.jpg", url: "javascript:alert(1)" }] },
          { who: "buyer", when: "x", at: "2026-10-17T14:32", text: "", attachments: [{ kind: "weird" }] },
          { who: "buyer", when: "x", at: "2026-10-17T14:33", text: "   " },
        ],
      }),
      b: card("b", { not_in_latest: true, last_scraped: "2026-10-17T20:07:44" }),
    },
  });
  const a = p.cards.find((c) => c.id === "a")!;
  assert.equal(a.history.length, 3, "blank row dropped, attachment rows kept");
  assert.equal(a.history[1].attachments?.[0].thumb, "https://scontent.example/t.jpg");
  assert.equal(a.history[1].attachments?.[0].url, "", "non-https url rejected");
  assert.equal(a.history[2].attachments?.[0].kind, "attachment");
  assert.equal(a.notInLatestRead, false);
  const b = p.cards.find((c) => c.id === "b")!;
  assert.equal(b.notInLatestRead, true);
  assert.equal(b.lastSeenInList, "2026-10-17T20:07:44");
  const msgs = live.cardMessages({ ...a, threadUrl: "https://www.facebook.com/marketplace/inbox" });
  assert.equal(msgs[1].attachments?.[0].thumb, "https://scontent.example/t.jpg");
  assert.equal(msgs[2].attachments?.[0].href, "https://www.facebook.com/marketplace/inbox", "placeholder links to the chat");
});

test("inbox gaps: refresh stays queued while the Mac reports the FB browser busy", () => {
  store.resetInboxStoreForTests();
  const r = store.requestInboxRefresh("open", T0);
  assert.equal(r.queued, true);
  store.noteFbBusy(true, "FB browser locked by iris-publish", plus(1000));
  assert.equal(store.latestRefresh(plus(1000))?.status, "queued");
  assert.match(store.latestRefresh(plus(1000))?.detail ?? "", /^Waiting: FB browser locked/);
  assert.match(live.refreshLabel(store.latestRefresh(plus(1000))), /Waiting for the FB browser/);
  // Busy for 45 min: not expired (would be after 30 min when the Mac is simply offline).
  store.noteFbBusy(true, "FB browser locked by iris-publish", plus(45 * 60_000));
  assert.equal(store.latestRefresh(plus(45 * 60_000))?.status, "queued");
  store.noteFbBusy(false, "", plus(46 * 60_000));
  const claimed = store.claimRefresh(plus(46 * 60_000));
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.detail, "");
});
