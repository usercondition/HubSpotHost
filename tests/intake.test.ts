import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMarketplaceConversation,
  splitName,
  validatePaidOrderDraft,
  validatePaidOrderLineItems,
  type PaidOrderDraft,
} from "../server/lib/intake";

const validDraft: PaidOrderDraft = {
  paymentConfirmed: true,
  fullName: "Jane Smith",
  marketplaceUsername: "jane.prints",
  email: "jane@example.com",
  phone: "619-555-0199",
  address: "123 Resin Way",
  city: "San Diego",
  state: "CA",
  postalCode: "92101",
  country: "United States",
  productName: "Acastus Knight Porphyrion",
  amount: "350",
  conversationSummary: "Confirmed paid Marketplace order.",
};

test("Marketplace intake extracts editable paid-order suggestions", () => {
  const analysis = analyzeMarketplaceConversation(`
Buyer: Jane Smith
Marketplace username: jane.prints
Model: Acastus Knight Porphyrion
I paid $350. Payment sent this afternoon.
Shipping address: 123 Resin Way, San Diego, CA 92101
Email: jane@example.com
Phone: 619-555-0199
`);

  assert.equal(analysis.fullName, "Jane Smith");
  assert.equal(analysis.marketplaceUsername, "jane.prints");
  assert.equal(analysis.productName, "Acastus Knight Porphyrion");
  assert.equal(analysis.amount, "350");
  assert.equal(analysis.email, "jane@example.com");
  assert.equal(analysis.paymentLanguageDetected, true);
  assert.match(analysis.conversationSummary, /Facebook Marketplace paid-order intake/);
});

test("Marketplace intake marks a conversation with no payment confirmation for review", () => {
  const analysis = analyzeMarketplaceConversation(`
Hi, I'm Alex.
I want to order a printed knight. Can you send the price and payment information?
`);
  assert.equal(analysis.paymentLanguageDetected, false);
  assert.ok(analysis.missing.includes("Clear payment confirmation"));
});

test("Paid-order validation requires payment, an identifiable client, product, and a non-negative amount", () => {
  assert.equal(validatePaidOrderDraft(validDraft), null);
  assert.equal(validatePaidOrderDraft({ ...validDraft, amount: "0" }), null);
  assert.equal(validatePaidOrderDraft({ ...validDraft, amount: "0.00" }), null);
  assert.match(
    validatePaidOrderDraft({ ...validDraft, paymentConfirmed: false }) ?? "",
    /Payment must be confirmed/,
  );
  assert.match(
    validatePaidOrderDraft({ ...validDraft, amount: "-5" }) ?? "",
    /zero or more/,
  );
  assert.match(
    validatePaidOrderDraft({ ...validDraft, fullName: "", marketplaceUsername: "" }) ?? "",
    /client's name or Marketplace username/,
  );
});

test("Paid-order line items require a description and non-negative amount per row", () => {
  assert.equal(
    validatePaidOrderLineItems([
      { productName: "Knight", amount: "120" },
      { productName: "Base", amount: "15.50" },
    ]),
    null,
  );
  assert.equal(
    validatePaidOrderLineItems([
      { productName: "Gift knight", amount: "0" },
      { productName: "Tracking sample", amount: "0.00" },
    ]),
    null,
  );
  assert.match(validatePaidOrderLineItems([]) ?? "", /at least one/);
  assert.match(
    validatePaidOrderLineItems([{ productName: "", amount: "10" }]) ?? "",
    /Item 1 needs a model/,
  );
  assert.match(
    validatePaidOrderLineItems([{ productName: "Knight", amount: "-1" }]) ?? "",
    /Item 1 needs an amount of zero or more/,
  );
});
