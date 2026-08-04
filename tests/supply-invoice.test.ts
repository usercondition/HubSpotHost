import test from "node:test";
import assert from "node:assert/strict";
import { extractSupplyInvoiceFromText } from "../server/lib/supply-invoice";

const AMAZON_INVOICE = `
Amazon.com
Final Details for Order #111-2223333-4445555

Order Placed: August 1, 2026
Amazon.com order number: 111-2223333-4445555

Items Ordered
ELEGOO ABS-Like Resin 3.0 Grey 1000g UV-Curing Resin for LCD 3D Printer
Sold by: ELEGOO Official
Condition: New
Quantity: 2
Unit Price: $28.99

Shipping & Handling: $0.00
Total before tax: $57.98
Estimated tax: $4.64
Grand Total: $62.62
`;

const GENERIC_INVOICE = `
INVOICE
Invoice Number: INV-9088
Invoice Date: 07/15/2026
Vendor: PrintSupply Co

Description: Nitrile gloves, 100 pack
Qty: 1
Total Paid: $12.50
`;

test("Amazon-style PDF text fills supply purchase fields", () => {
  const result = extractSupplyInvoiceFromText(AMAZON_INVOICE, { fileName: "amazon-order.pdf" });

  assert.equal(result.fields.source, "Amazon");
  assert.equal(result.fields.orderReference, "111-2223333-4445555");
  assert.match(result.fields.itemName, /ELEGOO ABS-Like Resin/i);
  assert.equal(result.fields.category, "materials");
  assert.equal(result.fields.quantity, 2);
  assert.equal(result.fields.totalAmount, "62.62");
  assert.equal(result.fields.purchasedAt, "2026-08-01");
  assert.match(result.fields.notes, /amazon-order\.pdf/i);
  assert.equal(result.warnings.length, 0);
});

test("generic invoice text extracts item, total, and date", () => {
  const result = extractSupplyInvoiceFromText(GENERIC_INVOICE, { fileName: "gloves.pdf" });

  assert.equal(result.fields.orderReference, "INV-9088");
  assert.match(result.fields.itemName, /Nitrile gloves/i);
  assert.equal(result.fields.category, "consumables");
  assert.equal(result.fields.quantity, 1);
  assert.equal(result.fields.totalAmount, "12.50");
  assert.equal(result.fields.purchasedAt, "2026-07-15");
});

test("sparse invoice text still returns editable defaults with warnings", () => {
  const result = extractSupplyInvoiceFromText("Thank you for your purchase.\nSubtotal $9.00");

  assert.equal(result.fields.totalAmount, "9.00");
  assert.equal(result.fields.quantity, 1);
  assert.ok(result.fields.purchasedAt.length === 10);
  assert.ok(result.warnings.length >= 1);
});
