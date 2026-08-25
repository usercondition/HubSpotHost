/**
 * Messenger scan V1: thread text formatting + consume-once Manual bridge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearMessengerScanBridges,
  createMessengerScanBridge,
  messengerScanBridgeCount,
  redeemMessengerScanBridge,
} from "../server/lib/messenger-scan-bridge";
import {
  formatMessengerThread,
  isNoiseBubble,
  cleanBubbleText,
} from "../server/lib/messenger-thread-text";
import { analyzeMarketplaceConversation } from "../server/lib/intake";
import { messengerScanTestUiEnabled } from "../server/lib/messenger-scan-test-ui";

test("formatMessengerThread drops noise and labels speakers", () => {
  const text = formatMessengerThread(
    [
      { speaker: "buyer", text: "Hi! Looking for an Acastus Knight" },
      { speaker: "you", text: "You sent" },
      { speaker: "you", text: "$350 shipped works" },
      { speaker: "buyer", text: "Paid $350 via PayPal" },
      { speaker: "buyer", text: "Ship to 123 Resin Way, San Diego CA 92101" },
    ],
    { title: "Jane Smith (Marketplace)" },
  );

  assert.match(text, /^Thread: Jane Smith/);
  assert.match(text, /Buyer: Hi! Looking for an Acastus Knight/);
  assert.match(text, /You: \$350 shipped works/);
  assert.doesNotMatch(text, /You sent/);
  assert.equal(isNoiseBubble("Today"), true);
  assert.equal(cleanBubbleText("  a\u200b b  "), "a b");
});

test("formatted mock-style thread analyzes into paid-order suggestions", () => {
  const conversation = formatMessengerThread(
    [
      { speaker: "buyer", text: "Hi! Saw your Marketplace listing for resin prints." },
      { speaker: "you", text: "Hey — yes, still taking custom orders." },
      { speaker: "buyer", text: "Looking for an Acastus Knight, painted quality." },
      { speaker: "you", text: "I can do that. $350 shipped for the kit you described." },
      { speaker: "buyer", text: "Sounds good. Name is Jane Smith." },
      { speaker: "buyer", text: "My Marketplace username is jane.prints.91" },
      { speaker: "buyer", text: "Paid $350 via PayPal just now." },
      { speaker: "buyer", text: "Ship to 123 Resin Way, San Diego CA 92101" },
      { speaker: "buyer", text: "Email is jane.smith.printops@example.com if you need it." },
    ],
    { title: "Jane Smith (Marketplace)" },
  );

  const analysis = analyzeMarketplaceConversation(conversation);
  assert.equal(analysis.paymentLanguageDetected, true);
  assert.ok(analysis.amount === "350" || analysis.amount.includes("350"));
  assert.match(analysis.productName || conversation, /Acastus|Knight/i);
  assert.equal(analysis.email, "jane.smith.printops@example.com");
  assert.equal(analysis.postalCode, "92101");
});

test("messenger bridge is create-protected by length and consume-once", () => {
  clearMessengerScanBridges();
  assert.throws(() => createMessengerScanBridge({ conversation: "too short" }));

  const conversation = formatMessengerThread([
    { speaker: "buyer", text: "Paid $120 for Titanicus legs, ship to 1 Main St Austin TX 78701" },
    { speaker: "you", text: "Got it, starting soon." },
  ]);
  const created = createMessengerScanBridge({
    conversation,
    title: "Buyer",
    source: "test",
  });
  assert.equal(messengerScanBridgeCount(), 1);

  const first = redeemMessengerScanBridge(created.id);
  assert.ok(first);
  assert.equal(first?.conversation, conversation);
  assert.equal(redeemMessengerScanBridge(created.id), null);
  assert.equal(messengerScanBridgeCount(), 0);
});

test("mock Messenger test UI flag defaults on outside production", () => {
  const previousNode = process.env.NODE_ENV;
  const previousFlag = process.env.MESSENGER_SCAN_TEST_UI;
  try {
    delete process.env.MESSENGER_SCAN_TEST_UI;
    process.env.NODE_ENV = "development";
    assert.equal(messengerScanTestUiEnabled(), true);
    process.env.NODE_ENV = "production";
    assert.equal(messengerScanTestUiEnabled(), false);
    process.env.MESSENGER_SCAN_TEST_UI = "1";
    assert.equal(messengerScanTestUiEnabled(), true);
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
    if (previousFlag === undefined) delete process.env.MESSENGER_SCAN_TEST_UI;
    else process.env.MESSENGER_SCAN_TEST_UI = previousFlag;
  }
});
