import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(mkdtempSync(join(tmpdir(), "conversation-scan-")), "test.db");
process.env.ORDER_LINKS_DB_FILE = dbFile;

const { resetOrderLinkStore } = await import("../server/lib/order-links");
const {
  formatLabeledTranscript,
  inferConversationStage,
  inferWaitingOn,
  parseLabeledConversation,
  scanConversation,
} = await import("../server/lib/conversation-scan");
const {
  dismissConversationWatchlist,
  listConversationFollowUps,
  snoozeConversationWatchlist,
  upsertWatchlistFromInbox,
  upsertWatchlistFromScan,
} = await import("../server/lib/conversation-watchlist");
const { analyzeMarketplaceConversation } = await import("../server/lib/intake");

test.after(() => {
  resetOrderLinkStore();
  rmSync(dbFile, { force: true });
});

test("parseLabeledConversation keeps buyer/you turns", () => {
  const messages = parseLabeledConversation(`
[buyer] Still available?
[you] Yes — $45 shipped
buyer: Paid via Venmo
`);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.role, "buyer");
  assert.equal(messages[1]!.role, "you");
  assert.equal(messages[2]!.role, "buyer");
  assert.match(formatLabeledTranscript(messages), /\[you\] Yes/);
});

test("scanConversation flags unanswered buyer and payment claim", () => {
  const scan = scanConversation({
    counterpartName: "Jane P.",
    threadUrl: "https://www.facebook.com/marketplace/t/1234567890",
    messages: [
      { role: "buyer", text: "Hi, can you print a knight bust?" },
      { role: "you", text: "Yes — $120 shipped" },
      { role: "buyer", text: "Deal. Paid via Venmo just now." },
    ],
  });

  assert.equal(scan.waitingOn, "you");
  assert.equal(scan.stage, "payment_claimed");
  assert.equal(scan.threadKey, "mp:1234567890");
  assert.match(scan.headline, /waiting on you/i);
  assert.ok(scan.nudges.some((nudge) => /order link|Verify payment/i.test(nudge.title)));
  assert.equal(scan.analysis.paymentLanguageDetected, true);
  assert.equal(scan.analysis.amount, "120");
});

test("inferWaitingOn and stage for quoting thread", () => {
  const messages = parseLabeledConversation(`
[buyer] Interested in the bust — how much?
[you] I can do $55 pickup or $70 shipped
`);
  assert.equal(inferWaitingOn(messages), "buyer");
  const analysis = analyzeMarketplaceConversation(formatLabeledTranscript(messages));
  assert.equal(inferConversationStage(messages, analysis), "negotiating");
});

test("watchlist upsert surfaces buried waiting-on-you reminder", () => {
  resetOrderLinkStore();
  const scan = scanConversation({
    counterpartName: "Alex",
    messages: [
      { role: "you", text: "Ready when you are" },
      { role: "buyer", text: "Did you get my payment?" },
    ],
  });
  const id = upsertWatchlistFromScan(scan, {
    counterpartName: "Alex",
    messages: [
      { role: "you", text: "Ready when you are" },
      { role: "buyer", text: "Did you get my payment?" },
    ],
  });
  assert.ok(id > 0);

  const followUps = listConversationFollowUps({ waitingOnYouOnly: true });
  assert.ok(followUps.some((row) => /forgotten about Alex|waiting on your reply/i.test(row.reminder)));

  assert.equal(snoozeConversationWatchlist(id, 24), true);
  assert.equal(listConversationFollowUps({ waitingOnYouOnly: true }).some((row) => row.id === id), false);

  // Re-open by dismissing another path: mark done then inbox upsert keeps done status.
  assert.equal(dismissConversationWatchlist(id), true);
});

test("inbox snapshot creates shallow follow-ups", () => {
  resetOrderLinkStore();
  const result = upsertWatchlistFromInbox([
    {
      counterpartName: "Buried Buyer",
      preview: "Any update on my order?",
      threadUrl: "https://www.facebook.com/marketplace/t/999",
      threadKey: "mp:999",
      waitingOn: "you",
    },
  ]);
  assert.equal(result.upserted, 1);
  const followUps = listConversationFollowUps({ waitingOnYouOnly: true });
  assert.ok(followUps.some((row) => /Buried Buyer/i.test(row.reminder)));
});
