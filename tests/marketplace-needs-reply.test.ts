import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketplaceInboxBrief } from "../server/lib/marketplace-inbox-brief";
import {
  briefStatusNeedsReply,
  syncMarketplaceBriefNeedsReply,
} from "../server/lib/marketplace-needs-reply";

test("linked Marketplace brief threads set the reply flag for replies and chases", async () => {
  const brief = buildMarketplaceInboxBrief([
    {
      id: "buyer-turn",
      dealId: "1001",
      title: "Ada",
      unread: true,
      conversation: "Buyer: Is the Dragon bust still available?",
    },
    {
      id: "chase",
      dealId: "1002",
      title: "Beau",
      conversation: "You: Let me know when you're ready to pay. Still waiting on payment.",
    },
  ]);
  const writes: Array<[string, boolean]> = [];

  const result = await syncMarketplaceBriefNeedsReply(brief, async (dealId, needsReply) => {
    writes.push([dealId, needsReply]);
  });

  assert.deepEqual(writes, [["1001", true], ["1002", true]]);
  assert.deepEqual(result.updatedDealIds, ["1001", "1002"]);
});

test("linked soft-closed and replied threads clear the reply flag", async () => {
  const brief = buildMarketplaceInboxBrief([
    {
      id: "waiting-on-buyer",
      dealId: "1003",
      title: "Casey",
      conversation: "You: Let me know whenever you're ready.",
    },
    {
      id: "complete",
      dealId: "1004",
      title: "Drew",
      conversation: "Buyer: Package delivered. Thanks again!",
    },
  ]);
  const writes: Array<[string, boolean]> = [];

  await syncMarketplaceBriefNeedsReply(brief, async (dealId, needsReply) => {
    writes.push([dealId, needsReply]);
  });

  assert.deepEqual(writes, [["1003", false], ["1004", false]]);
  assert.equal(briefStatusNeedsReply("waiting_on_buyer"), false);
  assert.equal(briefStatusNeedsReply("done"), false);
});

test("an open linked thread wins over a soft-closed thread on the same deal", async () => {
  const brief = buildMarketplaceInboxBrief([
    {
      dealId: "1005",
      title: "Erin",
      conversation: "You: Let me know whenever you're ready.",
    },
    {
      dealId: "1005",
      title: "Erin",
      unread: true,
      conversation: "Buyer: Can you confirm the order details?",
    },
  ]);
  const writes: Array<[string, boolean]> = [];

  await syncMarketplaceBriefNeedsReply(brief, async (dealId, needsReply) => {
    writes.push([dealId, needsReply]);
  });

  assert.deepEqual(writes, [["1005", true]]);
});

test("does not report a deal updated when the HubSpot write gate blocks it", async () => {
  const brief = buildMarketplaceInboxBrief([
    {
      dealId: "1006",
      title: "Flynn",
      unread: true,
      conversation: "Buyer: Is the order still on track?",
    },
  ]);

  const result = await syncMarketplaceBriefNeedsReply(
    brief,
    async () => ({ written: false, gate: "DRY_RUN is enabled" }),
  );

  assert.deepEqual(result.updatedDealIds, []);
});
