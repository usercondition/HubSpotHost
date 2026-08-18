import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectSource,
  detectSupplyReceiptFormat,
  extractSupplyInvoiceFromText,
  extractTextFromSupplyReceipt,
  isSupportedSupplyReceiptFileName,
  isSupportedSupplyReceiptUpload,
  normalizeOcrText,
  parseSupplyReceipt,
} from "../server/lib/supply-invoice";

const ELEGOO_EMAIL_SCREENSHOT = `
Hi Miguel,

Order Date 07/31/2026
Order Number #EUS338607
Track Your Order

Billing Address
Miguel
Shipping Address
4547 Kensington Dr
San Diego, California 92116
United States

Order Details
Worry-Free Purchase
Quantity: 1
Total: $1.98
ABS-Like Resin V3.0
Quantity: 4
Total: $123.96

Subtotal $101.18
Shipping $0.00
Total $101.18
`;

const ELEGOO_OCR_GLUED = `
Order Details Worry-Free Purchase Quantity: 1 Total: $1.98 ABS-Like Resin V3.0 Quantity: 4 Total: $123.96
Subtotal $101.18 Shipping $0.00 Total $101.18
Order Number #EUS338607
`;

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

const AMAZON_MULTI_ITEM = `
Amazon.com
Final Details for Order #111-9998888-7776666

Order Placed: August 2, 2026
Amazon.com order number: 111-9998888-7776666

Items Ordered
ELEGOO ABS-Like Resin 3.0 Grey 1000g UV-Curing Resin for LCD 3D Printer
Sold by: ELEGOO Official
Quantity: 1
Unit Price: $29.99

Nitrile Gloves Disposable 100 Pack Powder Free
Sold by: GloveCo
Quantity: 2
Unit Price: $12.50

Shipping & Handling: $0.00
Total before tax: $54.99
Estimated tax: $4.40
Grand Total: $59.39
`;

/** Amazon print.html Order Details — totals first, then product + Sold by. */
const AMAZON_PRINT_ORDER_DETAILS = `
Order Summary
Order placed August 15, 2026  Order # 112-4165520-4382601
Ship to
Miguel Mercado
4547 KENSINGTON DR
SAN DIEGO, CA 92116-3835
United States
Visa ending in 3436
Payment method
View related transactions
Order Summary
Item(s) Subtotal:$69.00
Shipping & Handling:$0.00
Total before tax:$69.00
Estimated tax to be
collected:
$5.35
Grand Total:$74.35
Arriving August 25 - August 26
HEYGEARS 2 PCS Release Film Set for Reflex RS & RS Turbo
Sold by: HEYGEARS Official Store
Supplied by: Other
$69.00
Back to top
Conditions of UsePrivacy Notice
© 1996-2026, Amazon.com, Inc. or its affiliates
8/15/26, 12:23 PMOrder Details
https://www.amazon.com/gp/css/summary/print.html?orderID=112-4165520-4382601
`;

const ULINE_INVOICE = `
ULINE
Invoice Number: 21554487
Invoice Date: 07/20/2026
Vendor: Uline

Description: Corrugated mailer boxes, 12x9x3
Qty: 25
Total Paid: $48.75
`;

const GENERIC_CSV = `Item,Quantity,Amount,Vendor,Date
"Nitrile gloves, 100 pack",2,12.50,Staples,2026-07-15
Bubble mailers assortment,1,18.00,Staples,2026-07-15
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
  assert.equal(result.fields.lineItems.length, 1);
  assert.equal(result.fields.lineItems[0]?.quantity, 2);
  assert.equal(result.fields.lineItems[0]?.lineAmount, "57.98");
  assert.equal(result.warnings.length, 0);
});

test("Amazon multi-item invoices extract a line-item breakdown", () => {
  const result = extractSupplyInvoiceFromText(AMAZON_MULTI_ITEM);

  assert.equal(result.fields.lineItems.length, 2);
  assert.match(result.fields.lineItems[0]!.itemName, /ELEGOO ABS-Like Resin/i);
  assert.equal(result.fields.lineItems[0]!.category, "materials");
  assert.equal(result.fields.lineItems[0]!.lineAmount, "29.99");
  assert.match(result.fields.lineItems[1]!.itemName, /Nitrile Gloves/i);
  assert.equal(result.fields.lineItems[1]!.category, "consumables");
  assert.equal(result.fields.lineItems[1]!.quantity, 2);
  assert.equal(result.fields.lineItems[1]!.lineAmount, "25.00");
  assert.equal(result.fields.totalAmount, "59.39");
  assert.match(result.fields.itemName, /2 items:/i);
  assert.ok(result.warnings.some((warning) => /2 line items/i.test(warning)));
});

test("Amazon print Order Details PDF fills item after totals", () => {
  const result = extractSupplyInvoiceFromText(AMAZON_PRINT_ORDER_DETAILS, {
    fileName: "Order Details.pdf",
  });

  assert.equal(result.fields.source, "Amazon");
  assert.equal(result.fields.orderReference, "112-4165520-4382601");
  assert.match(result.fields.itemName, /HEYGEARS.*Release Film/i);
  assert.equal(result.fields.category, "equipment_maintenance");
  assert.equal(result.fields.totalAmount, "74.35");
  assert.equal(result.fields.purchasedAt, "2026-08-15");
  assert.equal(result.fields.lineItems.length, 1);
  assert.equal(result.fields.lineItems[0]?.lineAmount, "69.00");
  assert.equal(result.fields.lineItems[0]?.quantity, 1);
  assert.equal(result.warnings.length, 0);
});

test("non-Amazon invoices detect vendor and nomenclature", () => {
  const result = extractSupplyInvoiceFromText(ULINE_INVOICE, { fileName: "uline-boxes.pdf" });

  assert.equal(result.fields.source, "Uline");
  assert.equal(result.fields.orderReference, "21554487");
  assert.match(result.fields.itemName, /mailer boxes/i);
  assert.equal(result.fields.category, "packaging_shipping");
  assert.equal(result.fields.totalAmount, "48.75");
  assert.equal(result.fields.purchasedAt, "2026-07-20");
});

test("ELEGOO order-confirmation screenshots capture items and quantities", () => {
  const result = extractSupplyInvoiceFromText(ELEGOO_EMAIL_SCREENSHOT, {
    fileName: "elegoo-order.png",
    format: "image",
  });

  assert.equal(result.fields.source, "ELEGOO");
  assert.equal(result.fields.orderReference, "EUS338607");
  assert.equal(result.fields.purchasedAt, "2026-07-31");
  assert.equal(result.fields.totalAmount, "101.18");
  assert.equal(result.fields.lineItems.length, 2);
  assert.equal(result.fields.lineItems[0]?.itemName, "Worry-Free Purchase");
  assert.equal(result.fields.lineItems[0]?.quantity, 1);
  assert.equal(result.fields.lineItems[0]?.lineAmount, "1.98");
  assert.match(result.fields.lineItems[1]?.itemName ?? "", /ABS-Like Resin V3\.0/i);
  assert.equal(result.fields.lineItems[1]?.quantity, 4);
  assert.equal(result.fields.lineItems[1]?.lineAmount, "123.96");
  assert.equal(result.fields.lineItems[1]?.category, "materials");
});

test("OCR-glued screenshot text is split into Quantity/Total item blocks", () => {
  const normalized = normalizeOcrText(ELEGOO_OCR_GLUED);
  assert.match(normalized, /Quantity:\s*1\nTotal:/i);
  const result = extractSupplyInvoiceFromText(ELEGOO_OCR_GLUED, { fileName: "screenshot.png" });
  assert.equal(result.fields.lineItems.length, 2);
  assert.equal(result.fields.lineItems[1]?.quantity, 4);
  assert.equal(result.fields.totalAmount, "101.18");
  assert.equal(result.fields.source, "ELEGOO");
});

test("vendor detection prefers labeled seller and known brands", () => {
  assert.equal(detectSource("Sold by: Phrozen Store\nTotal: $40.00"), "Phrozen");
  assert.equal(detectSource("Thanks for shopping", "homedepot-fep-film.csv"), "Home Depot");
  assert.equal(detectSource("Order Number #EUS338607"), "ELEGOO");
  assert.equal(detectSource("random receipt text"), "");
});

test("clipboard screenshots without a file extension are accepted by mime type", () => {
  assert.equal(isSupportedSupplyReceiptUpload({ originalname: "image", mimetype: "image/png" }), true);
  assert.equal(isSupportedSupplyReceiptUpload({ originalname: "blob", mimetype: "image/jpeg" }), true);
  assert.equal(isSupportedSupplyReceiptUpload({ originalname: "virus.exe", mimetype: "application/octet-stream" }), false);
});

test("supported receipt formats include spreadsheets and photos", () => {
  assert.equal(detectSupplyReceiptFormat("order.pdf"), "pdf");
  assert.equal(detectSupplyReceiptFormat("export.csv"), "csv");
  assert.equal(detectSupplyReceiptFormat("ledger.xlsx"), "spreadsheet");
  assert.equal(detectSupplyReceiptFormat("scan.jpg"), "image");
  assert.equal(isSupportedSupplyReceiptFileName("notes.txt"), true);
  assert.equal(isSupportedSupplyReceiptFileName("virus.exe"), false);
});

test("CSV receipts extract item rows, totals, and vendor", async () => {
  const filePath = path.join(os.tmpdir(), `supply-csv-${crypto.randomUUID()}.csv`);
  fs.writeFileSync(filePath, GENERIC_CSV, "utf8");
  try {
    const text = await extractTextFromSupplyReceipt(filePath, "staples-order.csv");
    assert.match(text.text, /Nitrile gloves/i);
    const parsed = await parseSupplyReceipt(filePath, "staples-order.csv");
    assert.equal(parsed.format, "csv");
    assert.equal(parsed.fields.source, "Staples");
    assert.ok(parsed.fields.lineItems.length >= 1);
    assert.match(parsed.fields.lineItems[0]!.itemName, /Nitrile gloves/i);
  } finally {
    fs.unlinkSync(filePath);
  }
});

test("sparse invoice text still returns editable defaults with warnings", () => {
  const result = extractSupplyInvoiceFromText("Thank you for your purchase.\nSubtotal $9.00");

  assert.equal(result.fields.totalAmount, "9.00");
  assert.equal(result.fields.quantity, 1);
  assert.equal(result.fields.source, "");
  assert.ok(result.fields.purchasedAt.length === 10);
  assert.ok(result.warnings.length >= 1);
});
