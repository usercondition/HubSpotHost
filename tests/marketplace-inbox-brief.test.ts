/**
 * Marketplace secretary inbox brief — classify threads and prioritize actions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketplaceInboxBrief } from "../server/lib/marketplace-inbox-brief";
import {
  clearMarketplaceInboxBriefs,
  createMarketplaceInboxBrief,
  getMarketplaceInboxBrief,
} from "../server/lib/marketplace-inbox-brief-store";

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

test("brief store returns created brief by id", () => {
  clearMarketplaceInboxBriefs();
  const created = createMarketplaceInboxBrief([
    {
      title: "Casey",
      unread: true,
      conversation: `Buyer: Ok I can do that — where do I pay?\nYou: PayPal works`,
    },
  ]);
  const loaded = getMarketplaceInboxBrief(created.id);
  assert.ok(loaded);
  assert.equal(loaded?.threadCount, 1);
  assert.equal(getMarketplaceInboxBrief("missing"), null);
});
