import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { suggestSupplyCategory } from "./supplies";
import {
  summarizeSupplyLineItems,
  type SupplyCategory,
  type SupplyPurchaseLineItem,
} from "../../shared/schema";

const MEBIBYTE = 1024 * 1024;
export const SUPPLY_INVOICE_MAX_BYTES = 12 * MEBIBYTE;
export const SUPPLY_INVOICE_MAX_LABEL = "12 MB";
const OCR_TIMEOUT_MS = 45_000;

export const SUPPLY_RECEIPT_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".text",
  ".csv",
  ".tsv",
  ".xlsx",
  ".xls",
  ".html",
  ".htm",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
] as const;

export type SupplyReceiptFormat =
  | "pdf"
  | "text"
  | "csv"
  | "spreadsheet"
  | "html"
  | "image"
  | "unknown";

export interface SupplyInvoiceFields {
  source: string;
  orderReference: string;
  itemName: string;
  category: SupplyCategory;
  quantity: number;
  totalAmount: string;
  purchasedAt: string;
  notes: string;
  lineItems: SupplyPurchaseLineItem[];
}

export interface SupplyInvoiceParseResult {
  fields: SupplyInvoiceFields;
  warnings: string[];
  pageCount: number;
  format: SupplyReceiptFormat;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const KNOWN_VENDORS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bamazon\b|\bamzn\b|\b1\d{2}-\d{7}-\d{7}\b/i, label: "Amazon" },
  { pattern: /\bebay\b/i, label: "eBay" },
  { pattern: /\betsy\b/i, label: "Etsy" },
  { pattern: /\bwalmart\b/i, label: "Walmart" },
  { pattern: /\bhome\s*depot\b/i, label: "Home Depot" },
  { pattern: /\blowes\b|\blowe'?s\b/i, label: "Lowe's" },
  { pattern: /\bmcmaster(?:-carr)?\b/i, label: "McMaster-Carr" },
  { pattern: /\belegoo\b|\bEUS\d{5,}\b/i, label: "ELEGOO" },
  { pattern: /\banycubic\b/i, label: "Anycubic" },
  { pattern: /\bphrozen\b/i, label: "Phrozen" },
  { pattern: /\bhey\s*gears\b|\bheygears\b/i, label: "HeyGears" },
  { pattern: /\builine\b/i, label: "Uline" },
  { pattern: /\bstaples\b/i, label: "Staples" },
  { pattern: /\boffice\s*depot\b|\boffice\s*max\b/i, label: "Office Depot" },
  { pattern: /\baliexpress\b/i, label: "AliExpress" },
  { pattern: /\bmouser\b/i, label: "Mouser" },
  { pattern: /\bdigi[- ]?key\b/i, label: "Digi-Key" },
  { pattern: /\bspecialty\s*resin\b|\bresiners\b/i, label: "Specialty resin" },
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

/** Repair common screenshot/OCR glitches before field extraction. */
export function normalizeOcrText(text: string): string {
  let value = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");

  value = value
    .replace(/\bQuan[il1]{1,3}ty\b/gi, "Quantity")
    .replace(/\bQty\b/gi, "Qty")
    .replace(/\bTota[il1]\b/gi, "Total")
    .replace(/\bSub\s*tota[il1]\b/gi, "Subtotal")
    .replace(/\bOrder\s*Deta[il1]{2,3}s\b/gi, "Order Details")
    .replace(/\bOrder\s*Num(?:ber|her|her)\b/gi, "Order Number")
    .replace(/[|]/g, "I")
    .replace(/[;]/g, ":")
    .replace(/\$\s+(\d)/g, "$$$1")
    .replace(/(\d),(\d{2})\b/g, "$1.$2");

  // Split glued email-style blocks onto their own lines.
  value = value
    .replace(/([^\n])\s+(Quantity\s*:)/gi, "$1\n$2")
    .replace(/(Quantity\s*:\s*\d{1,5})\s+(Total\s*:)/gi, "$1\n$2")
    .replace(/(Total\s*:\s*\$?\s*[\d,]+\.\d{2})\s+(?=[A-Z(])/g, "$1\n")
    .replace(/([^\n])\s+(Subtotal\s*:?)/gi, "$1\n$2")
    .replace(/\b(Order\s*Details)\s+/gi, "$1\n");

  return value;
}

function moneyFromMatch(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount.toFixed(2);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const check = new Date(`${iso}T12:00:00.000Z`);
  if (!Number.isFinite(check.getTime())) return null;
  return iso;
}

function parseLooseDate(raw: string): string | null {
  const value = normalizeWhitespace(raw);

  const iso = value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const slash = value.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  if (slash) {
    return toIsoDate(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  }

  const named = value.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase().replace(/\.$/, "")];
    if (month) return toIsoDate(Number(named[3]), month, Number(named[2]));
  }

  return null;
}

export function pathExt(fileName: string | undefined): string {
  if (!fileName) return "";
  return path.extname(fileName).toLowerCase();
}

export function detectSupplyReceiptFormat(fileName: string | undefined): SupplyReceiptFormat {
  const ext = pathExt(fileName);
  if (ext === ".pdf") return "pdf";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".xlsx" || ext === ".xls") return "spreadsheet";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".txt" || ext === ".text") return "text";
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(ext)) {
    return "image";
  }
  return "unknown";
}

export function isSupportedSupplyReceiptFileName(fileName: string | undefined): boolean {
  return detectSupplyReceiptFormat(fileName) !== "unknown";
}

export function isSupportedSupplyReceiptUpload(file: {
  originalname?: string;
  mimetype?: string;
}): boolean {
  if (isSupportedSupplyReceiptFileName(file.originalname)) return true;
  const mime = String(file.mimetype || "").toLowerCase();
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime === "text/plain" ||
    mime === "text/csv" ||
    mime === "text/html" ||
    mime.includes("spreadsheet") ||
    mime.includes("excel")
  );
}

export function formatFromUpload(file: {
  originalname?: string;
  mimetype?: string;
}): SupplyReceiptFormat {
  const fromName = detectSupplyReceiptFormat(file.originalname);
  if (fromName !== "unknown") return fromName;
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/csv") return "csv";
  if (mime === "text/html") return "html";
  if (mime === "text/plain") return "text";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "spreadsheet";
  return "unknown";
}

/** @deprecated Use isSupportedSupplyReceiptFileName */
export function isPdfInvoiceFileName(fileName: string | undefined): boolean {
  return pathExt(fileName) === ".pdf";
}

function extractOrderReference(text: string): string | null {
  const amazon = text.match(/\b(1\d{2}-\d{7}-\d{7})\b/);
  if (amazon?.[1]) return amazon[1];

  const elegoo = text.match(/#\s*(EUS\d{5,})\b/i);
  if (elegoo?.[1]) return elegoo[1].toUpperCase();

  const labeled = text.match(
    /\b(?:Order|Invoice|Receipt|PO|Purchase\s*Order|Confirmation)\s*(?:#|Number|No\.?|ID)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,40})\b/i,
  );
  if (labeled?.[1] && !/^(date|total|item|qty|invoice|order|number|receipt)$/i.test(labeled[1])) {
    return labeled[1];
  }
  return null;
}

function extractTotalAmount(text: string): string | null {
  // Prefer order-level totals. Avoid the first line-item "Total: $1.98".
  const preferred = [
    /Grand\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Order\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Amount\s*(?:Due|Paid|Charged)\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Invoice\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Balance\s*Due\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Subtotal\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const pattern of preferred) {
    const match = text.match(pattern);
    const money = moneyFromMatch(match?.[1]);
    if (money) return money;
  }

  // Bare "Total:" labels — use the last one (summary is usually at the bottom).
  const bareTotals: string[] = [];
  const barePattern = /(?:^|\n)\s*Total\s*(?:Paid|Charged|Cost|Price)?\s*[:\s]*\$?\s*([\d,]+\.\d{2})/gi;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = barePattern.exec(text)) !== null) {
    const money = moneyFromMatch(bareMatch[1]);
    if (money) bareTotals.push(money);
  }
  if (bareTotals.length > 0) return bareTotals[bareTotals.length - 1]!;

  const amounts: number[] = [];
  const moneyPattern = /\$\s*([\d,]+\.\d{2})\b/g;
  let moneyMatch: RegExpExecArray | null;
  while ((moneyMatch = moneyPattern.exec(text)) !== null) {
    const money = moneyFromMatch(moneyMatch[1]);
    if (!money) continue;
    const amount = Number(money);
    if (amount > 0 && amount < 100_000) amounts.push(amount);
  }
  if (amounts.length === 0) {
    const bare = text.match(/(?:^|\n)\s*(?:total|amount|cost|price)\s*[,:\t ]+\s*([\d,]+\.\d{2})\s*(?:\n|$)/i);
    return moneyFromMatch(bare?.[1]);
  }
  return Math.max(...amounts).toFixed(2);
}

function extractPurchasedAt(text: string): string | null {
  const labeled = text.match(
    /(?:Order\s*Placed|Order\s*Date|Invoice\s*Date|Purchase\s*Date|Date\s*of\s*Purchase|Transaction\s*Date|Date)\s*[:\s]+([^\n]{6,40})/i,
  );
  if (labeled?.[1]) {
    const parsed = parseLooseDate(labeled[1]);
    if (parsed) return parsed;
  }
  return parseLooseDate(text);
}

function extractQuantity(text: string): number | null {
  const patterns = [
    /\bQty\.?\s*[:\s]*(\d{1,5})\b/i,
    /\bQuantity\s*[:\s]*(\d{1,5})\b/i,
    /\b(\d{1,5})\s*(?:of\s*)?(?:items?|units?|pcs?|pieces?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const qty = Number(match?.[1]);
    if (Number.isInteger(qty) && qty >= 1 && qty <= 100_000) return qty;
  }
  return null;
}

function looksLikeNoiseItem(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized.length < 3 ||
    /^(amazon\.com|final details|order information|billing|shipping|payment|sold by|condition:|thank you|invoice|receipt|page\s+\d|vendor|merchant|store|track your order|hi[, ]|hello)/i.test(
      normalized,
    ) ||
    /^(subtotal|shipping|tax|total|grand total|order total|amount due|balance due|quantity)\b/i.test(normalized) ||
    /^(billing address|shipping address|order date|order number)\b/i.test(normalized) ||
    /^\$?\d/.test(normalized) ||
    /^(https?:|www\.)/i.test(normalized)
  );
}

function isSectionEnd(line: string): boolean {
  return /^(subtotal|shipping\b(?!\s+address)|tax|estimated tax|total before|grand total|order total|amount due|balance due|payment information)\b/i.test(
    line,
  );
}

function isProductTitleLine(line: string): boolean {
  if (looksLikeNoiseItem(line)) return false;
  if (/^(quantity|qty|total|unit price)\b/i.test(line)) return false;
  if (!/[a-zA-Z]{3,}/.test(line)) return false;
  if (line.length < 3 || line.length > 180) return false;
  return true;
}

/**
 * Email/screenshot layout: product name, then Quantity:, then Total:.
 * Works with or without an "Order Details" heading, including OCR-glued lines.
 */
export function extractQuantityTotalBlocks(lines: string[]): SupplyPurchaseLineItem[] {
  const items: SupplyPurchaseLineItem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    // Same-line: "ABS-Like Resin V3.0 Quantity: 4 Total: $123.96"
    const sameLine = line.match(
      /^(.+?)\s+Quantity\s*:\s*(\d{1,5})\s+Total\s*:\s*\$?\s*([\d,]+\.\d{2})\s*$/i,
    );
    if (sameLine) {
      const itemName = normalizeWhitespace(sameLine[1]!).slice(0, 300);
      if (isProductTitleLine(itemName)) {
        items.push({
          itemName,
          quantity: Number(sameLine[2]) || 1,
          lineAmount: moneyFromMatch(sameLine[3]) ?? "",
          category: suggestSupplyCategory(itemName),
        });
      }
      continue;
    }

    if (!isProductTitleLine(line)) continue;

    const next1 = lines[index + 1] ?? "";
    const next2 = lines[index + 2] ?? "";
    const qtyLine = next1.match(/^Quantity\s*:\s*(\d{1,5})\s*$/i) || next1.match(/^Qty\.?\s*:\s*(\d{1,5})\s*$/i);
    const totalOnNext1 = next1.match(/^Total\s*:\s*\$?\s*([\d,]+\.\d{2})\s*$/i);
    const totalOnNext2 = next2.match(/^Total\s*:\s*\$?\s*([\d,]+\.\d{2})\s*$/i);

    if (qtyLine && totalOnNext2) {
      items.push({
        itemName: line.slice(0, 300),
        quantity: Number(qtyLine[1]) || 1,
        lineAmount: moneyFromMatch(totalOnNext2[1]) ?? "",
        category: suggestSupplyCategory(line),
      });
      index += 2;
      continue;
    }

    // Quantity and total somehow on one following line.
    const qtyTotal = next1.match(/^Quantity\s*:\s*(\d{1,5})\s+Total\s*:\s*\$?\s*([\d,]+\.\d{2})\s*$/i);
    if (qtyTotal) {
      items.push({
        itemName: line.slice(0, 300),
        quantity: Number(qtyTotal[1]) || 1,
        lineAmount: moneyFromMatch(qtyTotal[2]) ?? "",
        category: suggestSupplyCategory(line),
      });
      index += 1;
      continue;
    }

    // Name + quantity on this line, total on next.
    const nameQty = line.match(/^(.+?)\s+Quantity\s*:\s*(\d{1,5})\s*$/i);
    if (nameQty && totalOnNext1) {
      const itemName = normalizeWhitespace(nameQty[1]!).slice(0, 300);
      if (isProductTitleLine(itemName)) {
        items.push({
          itemName,
          quantity: Number(nameQty[2]) || 1,
          lineAmount: moneyFromMatch(totalOnNext1[1]) ?? "",
          category: suggestSupplyCategory(itemName),
        });
        index += 1;
      }
    }
  }

  return items.slice(0, 40);
}

function extractAmazonStyleLineItems(lines: string[]): SupplyPurchaseLineItem[] {
  const items: SupplyPurchaseLineItem[] = [];
  let inItems = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (
      /^Items?\s+Ordered$/i.test(line) ||
      /^Order\s+Details$/i.test(line) ||
      /^Items?\s*$/i.test(line)
    ) {
      inItems = true;
      continue;
    }
    if (inItems && isSectionEnd(line)) break;
    if (!inItems) continue;
    if (looksLikeNoiseItem(line)) continue;
    if (/sold by|condition:|asin|unit price|of:|shipment/i.test(line)) continue;
    if (/^quantity\b/i.test(line)) continue;
    if (!/[a-zA-Z]{3,}/.test(line) || line.length < 6) continue;

    let quantity = 1;
    let unitPrice: string | null = null;
    let lineTotal: string | null = null;

    for (let offset = 1; offset <= 8; offset += 1) {
      const next = lines[index + offset];
      if (!next || isSectionEnd(next)) break;

      const qtyMatch = next.match(/\b(?:Qty\.?|Quantity)\s*[:\s]*(\d{1,5})\b/i);
      if (qtyMatch) quantity = Number(qtyMatch[1]) || 1;

      const unitMatch = next.match(/\bUnit\s*Price\s*[:\s]*\$?\s*([\d,]+\.\d{2})\b/i);
      if (unitMatch) unitPrice = moneyFromMatch(unitMatch[1]);

      const totalMatch = next.match(/\b(?:Item\s*)?(?:Sub)?total\s*[:\s]*\$?\s*([\d,]+\.\d{2})\b/i);
      if (totalMatch) lineTotal = moneyFromMatch(totalMatch[1]);

      if (!unitPrice && !lineTotal) {
        const lone = next.match(/^\$?\s*([\d,]+\.\d{2})$/);
        if (lone) unitPrice = moneyFromMatch(lone[1]);
      }

      if (
        offset > 1 &&
        /[a-zA-Z]{6,}/.test(next) &&
        !/sold by|condition:|quantity|unit price|asin|total/i.test(next) &&
        !looksLikeNoiseItem(next) &&
        next.length >= 12
      ) {
        break;
      }
    }

    let amount = lineTotal;
    if (!amount && unitPrice) amount = (Number(unitPrice) * quantity).toFixed(2);

    items.push({
      itemName: line.slice(0, 300),
      quantity,
      lineAmount: amount ?? "",
      category: suggestSupplyCategory(line),
    });
    if (items.length >= 40) break;
  }

  return items;
}

/** Generic "Description .... $12.50" or "Name, qty, amount" rows from any vendor. */
function extractGenericLineItems(lines: string[]): SupplyPurchaseLineItem[] {
  const items: SupplyPurchaseLineItem[] = [];

  for (const line of lines) {
    if (looksLikeNoiseItem(line) || isSectionEnd(line)) continue;

    const trailingMoney = line.match(/^(.+?)\s+[x×]?\s*(\d{1,5})?\s*\$?\s*([\d,]+\.\d{2})\s*$/i);
    if (trailingMoney) {
      const itemName = normalizeWhitespace(trailingMoney[1]!).replace(/[,\t]+$/, "").slice(0, 300);
      if (itemName.length >= 4 && /[a-zA-Z]{3,}/.test(itemName) && !/^(total|subtotal|tax|shipping)/i.test(itemName)) {
        items.push({
          itemName,
          quantity: Number(trailingMoney[2]) || 1,
          lineAmount: moneyFromMatch(trailingMoney[3]) ?? "",
          category: suggestSupplyCategory(itemName),
        });
        if (items.length >= 40) break;
        continue;
      }
    }

    const csvish = line.match(/^"?([^",\t]{4,200})"?\s*[,\t]\s*(\d{1,5})\s*[,\t]\s*\$?\s*([\d,]+\.\d{2})\s*$/);
    if (csvish) {
      const itemName = normalizeWhitespace(csvish[1]!).slice(0, 300);
      if (!/^(item|description|product|name|sku)$/i.test(itemName)) {
        items.push({
          itemName,
          quantity: Number(csvish[2]) || 1,
          lineAmount: moneyFromMatch(csvish[3]) ?? "",
          category: suggestSupplyCategory(itemName),
        });
        if (items.length >= 40) break;
      }
    }
  }

  return items;
}

function extractLineItems(text: string): SupplyPurchaseLineItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  // Prefer Quantity/Total email blocks (ELEGOO, Shopify, etc.) — most reliable for screenshots.
  const quantityTotalBlocks = extractQuantityTotalBlocks(lines);
  if (quantityTotalBlocks.length > 0) return quantityTotalBlocks;

  const amazonStyle = extractAmazonStyleLineItems(lines);
  if (amazonStyle.length > 0) return amazonStyle;

  const generic = extractGenericLineItems(lines);
  if (generic.length > 0) return generic;

  const titled = text.match(
    /(?:Item(?:\s*Description|\s*Name)?|Description|Product|Nomenclature|SKU\s*Description)\s*:\s*([^\n]{4,300})/i,
  );
  if (titled?.[1] && !looksLikeNoiseItem(titled[1])) {
    const itemName = normalizeWhitespace(titled[1]).slice(0, 300);
    return [
      {
        itemName,
        quantity: extractQuantity(text) ?? 1,
        lineAmount: "",
        category: suggestSupplyCategory(itemName),
      },
    ];
  }

  for (const line of lines) {
    if (looksLikeNoiseItem(line)) continue;
    if (!/[a-zA-Z]{3,}/.test(line)) continue;
    if (/\b(resin|filament|glove|fep|ipa|isopropyl|mailer|box|printer|vat|bottle)\b/i.test(line)) {
      return [
        {
          itemName: line.slice(0, 300),
          quantity: extractQuantity(text) ?? 1,
          lineAmount: "",
          category: suggestSupplyCategory(line),
        },
      ];
    }
  }

  return [];
}

function extractItemName(text: string): string | null {
  const items = extractLineItems(text);
  if (items.length === 1) return items[0]!.itemName;
  if (items.length > 1) return summarizeSupplyLineItems(items).itemName;
  return null;
}

export function detectSource(text: string, fileName?: string): string {
  const haystack = `${text}\n${fileName ?? ""}`;

  for (const vendor of KNOWN_VENDORS) {
    if (vendor.pattern.test(haystack)) return vendor.label;
  }

  const labeled = text.match(
    /\b(?:Vendor|Merchant|Store|Sold\s*by|Seller|From|Supplier|Bill\s*From|Company)\s*[:\s]+([A-Za-z0-9][A-Za-z0-9 .,&'-]{1,60})/i,
  );
  if (labeled?.[1]) {
    const cleaned = normalizeWhitespace(labeled[1])
      .replace(/\s+(Inc\.?|LLC|Ltd\.?|Corp\.?)$/i, "")
      .slice(0, 80);
    if (cleaned.length >= 2 && !/^(date|total|invoice|order)$/i.test(cleaned)) {
      return cleaned;
    }
  }

  // Filename tokens like "homedepot-receipt.pdf" or "uline_order.csv"
  const base = (fileName ?? "").replace(/\.[^.]+$/, "").replace(/[_\-.]+/g, " ");
  for (const vendor of KNOWN_VENDORS) {
    if (vendor.pattern.test(base)) return vendor.label;
  }

  return "";
}

function localTodayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** Pure text heuristics used by every file path and unit tests. */
export function extractSupplyInvoiceFromText(
  text: string,
  options: { fileName?: string; pageCount?: number; format?: SupplyReceiptFormat } = {},
): SupplyInvoiceParseResult {
  const cleaned = normalizeOcrText(text.replace(/\u0000/g, " "));
  const warnings: string[] = [];

  const lineItems = extractLineItems(cleaned);
  const summary = summarizeSupplyLineItems(lineItems);
  const itemName = summary.itemName || extractItemName(cleaned);
  const totalAmount = extractTotalAmount(cleaned);
  const purchasedAt = extractPurchasedAt(cleaned);
  const orderReference = extractOrderReference(cleaned);
  const quantity = summary.quantity || extractQuantity(cleaned) || 1;
  const source = detectSource(cleaned, options.fileName);

  if (lineItems.length === 0) warnings.push("Could not find a clear item name — enter nomenclature manually.");
  if (!totalAmount) warnings.push("Could not find a receipt total — enter the amount paid.");
  if (!purchasedAt) warnings.push("Could not find a purchase date — today's date was used.");
  if (!orderReference) warnings.push("No order or invoice number was found.");
  if (!source) warnings.push("Vendor/source was not detected — set it before saving.");
  if (lineItems.length > 1) {
    warnings.push(`Found ${lineItems.length} line items — review the breakdown before saving.`);
  }

  const resolvedItem = itemName ?? "";
  const fields: SupplyInvoiceFields = {
    source,
    orderReference: orderReference ?? "",
    itemName: resolvedItem,
    category: summary.category || (resolvedItem ? suggestSupplyCategory(resolvedItem) : "other"),
    quantity,
    totalAmount: totalAmount ?? "",
    purchasedAt: purchasedAt ?? localTodayIso(),
    notes: options.fileName ? `Imported from ${options.fileName}` : "",
    lineItems:
      lineItems.length > 0
        ? lineItems
        : resolvedItem
          ? [
              {
                itemName: resolvedItem,
                quantity,
                lineAmount: "",
                category: suggestSupplyCategory(resolvedItem),
              },
            ]
          : [],
  };

  return {
    fields,
    warnings,
    pageCount: options.pageCount ?? 1,
    format: options.format ?? "text",
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

type CsvColumnMap = {
  item?: number;
  quantity?: number;
  amount?: number;
  vendor?: number;
  date?: number;
};

function mapCsvColumns(header: string[]): CsvColumnMap {
  const map: CsvColumnMap = {};
  header.forEach((cell, index) => {
    const key = cell.toLowerCase();
    if (map.item === undefined && /^(item|description|product|nomenclature|name|sku)$/i.test(key)) {
      map.item = index;
    } else if (map.quantity === undefined && /^(qty|quantity|count|units?)$/i.test(key)) {
      map.quantity = index;
    } else if (map.amount === undefined && /^(amount|total|price|cost|line\s*total|unit\s*price)$/i.test(key)) {
      map.amount = index;
    } else if (map.vendor === undefined && /^(vendor|merchant|store|seller|source|supplier)$/i.test(key)) {
      map.vendor = index;
    } else if (map.date === undefined && /^(date|purchased|order\s*date|invoice\s*date)$/i.test(key)) {
      map.date = index;
    }
  });
  return map;
}

function extractLineItemsFromCsvRecords(records: string[][]): {
  lineItems: SupplyPurchaseLineItem[];
  vendor: string;
  purchasedAt: string | null;
  totalAmount: string | null;
  text: string;
} {
  if (records.length === 0) {
    return { lineItems: [], vendor: "", purchasedAt: null, totalAmount: null, text: "" };
  }

  const header = records[0]!.map((cell) => normalizeWhitespace(String(cell ?? "")));
  const columns = mapCsvColumns(header);
  const hasMappedItem = columns.item !== undefined;
  const start = hasMappedItem || header.some((cell) => /item|description|product|qty|amount|total/i.test(cell)) ? 1 : 0;
  const lineItems: SupplyPurchaseLineItem[] = [];
  let vendor = "";
  let purchasedAt: string | null = null;
  let total = 0;
  const lines: string[] = [];

  for (let index = start; index < records.length; index += 1) {
    const row = records[index]!.map((cell) => normalizeWhitespace(String(cell ?? "")));
    if (row.every((cell) => !cell)) continue;

    const itemName = hasMappedItem
      ? row[columns.item!] ?? ""
      : row.find((cell) => /[a-zA-Z]{3,}/.test(cell) && !/^[\d.$,]+$/.test(cell)) ?? "";
    if (!itemName || itemName.length < 2) continue;

    const quantityRaw = columns.quantity !== undefined ? row[columns.quantity!] : "";
    const quantity = Math.max(1, Number(quantityRaw) || 1);
    const amountRaw =
      columns.amount !== undefined
        ? row[columns.amount!]
        : row.find((cell) => /^\$?[\d,]+\.\d{2}$/.test(cell)) ?? "";
    const lineAmount = moneyFromMatch(amountRaw) ?? "";
    if (lineAmount) total += Number(lineAmount);

    const rowVendor = columns.vendor !== undefined ? row[columns.vendor!] ?? "" : "";
    if (!vendor && rowVendor) vendor = rowVendor;

    const rowDate = columns.date !== undefined ? row[columns.date!] ?? "" : "";
    if (!purchasedAt && rowDate) purchasedAt = parseLooseDate(rowDate);

    lineItems.push({
      itemName: itemName.slice(0, 300),
      quantity,
      lineAmount,
      category: suggestSupplyCategory(itemName),
    });

    lines.push(
      [
        `Item: ${itemName}`,
        `Quantity: ${quantity}`,
        lineAmount ? `Amount: $${lineAmount}` : "",
        rowVendor ? `Vendor: ${rowVendor}` : "",
        rowDate ? `Date: ${rowDate}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    lines.push(`${itemName} ${quantity} $${lineAmount || "0.00"}`);
  }

  if (vendor) lines.unshift(`Vendor: ${vendor}`);
  if (total > 0) lines.push(`Grand Total: $${total.toFixed(2)}`);

  return {
    lineItems: lineItems.slice(0, 40),
    vendor,
    purchasedAt,
    totalAmount: total > 0 ? total.toFixed(2) : null,
    text: lines.join("\n"),
  };
}

function csvRecordsToText(records: string[][]): string {
  return extractLineItemsFromCsvRecords(records).text || records.map((row) => row.join(", ")).join("\n");
}

async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new Error("That file does not look like a PDF");
  }
  let parsed: { text?: string; numpages?: number };
  try {
    parsed = await pdfParse(buffer);
  } catch {
    throw new Error("The PDF could not be read. Try a text export, CSV, or a clearer photo.");
  }
  return {
    text: typeof parsed.text === "string" ? parsed.text.trim() : "",
    pageCount: typeof parsed.numpages === "number" ? parsed.numpages : 1,
  };
}

async function extractTextFromCsv(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("utf8");
  const delimiter = raw.includes("\t") && !raw.includes(",") ? "\t" : ",";
  const records = parseCsv(raw, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    delimiter,
  }) as string[][];
  return csvRecordsToText(records);
}

async function extractTextFromSpreadsheet(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const chunks: string[] = [];
  for (const sheetName of workbook.SheetNames.slice(0, 3)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    chunks.push(`Sheet: ${sheetName}\n${csv}`);
  }
  if (chunks.length === 0) return "";
  // Re-run through CSV normalizer for labeled pairs.
  const combined = chunks.join("\n\n");
  try {
    const records = parseCsv(combined.replace(/^Sheet:.*\n/gm, ""), {
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
    const normalized = csvRecordsToText(records);
    return normalized || combined;
  } catch {
    return combined;
  }
}

async function extractTextFromImage(filePath: string): Promise<string> {
  const { createWorker, PSM } = await import("tesseract.js");
  // SINGLE_BLOCK fits email/receipt screenshots better than fully automatic layout.
  const worker = await createWorker("eng", 1, {
    logger: () => undefined,
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
    });
    const recognize = worker.recognize(filePath);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OCR timed out")), OCR_TIMEOUT_MS);
    });
    const result = await Promise.race([recognize, timeout]);
    return normalizeOcrText(String(result.data?.text ?? "").trim());
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

export async function extractTextFromSupplyReceipt(
  filePath: string,
  fileName?: string,
): Promise<{ text: string; pageCount: number; format: SupplyReceiptFormat }> {
  const format = detectSupplyReceiptFormat(fileName ?? filePath);
  const buffer = await fs.readFile(filePath);
  if (buffer.length === 0) {
    throw new Error("That file is empty");
  }

  switch (format) {
    case "pdf": {
      const pdf = await extractTextFromPdf(buffer);
      return { ...pdf, format };
    }
    case "csv":
      return { text: await extractTextFromCsv(buffer), pageCount: 1, format };
    case "spreadsheet":
      return { text: await extractTextFromSpreadsheet(buffer), pageCount: 1, format };
    case "html":
      return { text: stripHtml(buffer.toString("utf8")), pageCount: 1, format };
    case "text":
      return { text: buffer.toString("utf8"), pageCount: 1, format };
    case "image": {
      try {
        const text = await extractTextFromImage(filePath);
        return { text, pageCount: 1, format };
      } catch (error) {
        const message = error instanceof Error ? error.message : "OCR failed";
        throw new Error(
          `${message}. Try a PDF, CSV, or spreadsheet export, or enter the receipt manually.`,
        );
      }
    }
    default:
      throw new Error(
        "Unsupported file type. Use PDF, CSV, Excel, text, HTML, or a photo of the receipt.",
      );
  }
}

async function structuredRowsFromFile(
  filePath: string,
  format: SupplyReceiptFormat,
): Promise<ReturnType<typeof extractLineItemsFromCsvRecords> | null> {
  if (format !== "csv" && format !== "spreadsheet") return null;
  const buffer = await fs.readFile(filePath);
  try {
    if (format === "csv") {
      const raw = buffer.toString("utf8");
      const delimiter = raw.includes("\t") && !raw.includes(",") ? "\t" : ",";
      const records = parseCsv(raw, {
        relax_column_count: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
      }) as string[][];
      return extractLineItemsFromCsvRecords(records);
    }

    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return null;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return null;
    const records = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    }) as string[][];
    return extractLineItemsFromCsvRecords(records.map((row) => row.map((cell) => String(cell ?? ""))));
  } catch {
    return null;
  }
}

/** Prefill-only parse for any supported receipt/invoice file. */
export async function parseSupplyReceipt(
  filePath: string,
  fileName?: string,
): Promise<SupplyInvoiceParseResult> {
  const format = detectSupplyReceiptFormat(fileName ?? filePath);
  const structured = await structuredRowsFromFile(filePath, format);

  if (structured && structured.lineItems.length > 0) {
    const summary = summarizeSupplyLineItems(structured.lineItems);
    const source = structured.vendor || detectSource(structured.text, fileName);
    const warnings: string[] = [];
    if (!source) warnings.push("Vendor/source was not detected — set it before saving.");
    if (structured.lineItems.length > 1) {
      warnings.push(`Found ${structured.lineItems.length} line items — review the breakdown before saving.`);
    }
    return {
      fields: {
        source,
        orderReference: extractOrderReference(structured.text) ?? "",
        itemName: summary.itemName,
        category: summary.category,
        quantity: summary.quantity,
        totalAmount: structured.totalAmount ?? "",
        purchasedAt: structured.purchasedAt ?? localTodayIso(),
        notes: fileName ? `Imported from ${fileName}` : "",
        lineItems: structured.lineItems,
      },
      warnings,
      pageCount: 1,
      format,
    };
  }

  const extracted = await extractTextFromSupplyReceipt(filePath, fileName);
  if (!extracted.text.trim()) {
    const source = detectSource("", fileName);
    return {
      fields: {
        source,
        orderReference: "",
        itemName: "",
        category: "other",
        quantity: 1,
        totalAmount: "",
        purchasedAt: localTodayIso(),
        notes: fileName ? `Imported from ${fileName}` : "",
        lineItems: [],
      },
      warnings: [
        extracted.format === "image"
          ? "No readable text was found in that photo — enter nomenclature, cost, and source manually."
          : "No readable text was found — enter the purchase details manually.",
      ],
      pageCount: extracted.pageCount,
      format: extracted.format,
    };
  }

  const parsed = extractSupplyInvoiceFromText(extracted.text, {
    fileName,
    pageCount: extracted.pageCount,
    format: extracted.format,
  });

  if (extracted.format === "image") {
    parsed.warnings = [
      "Photo OCR is best-effort — double-check nomenclature, cost, and vendor.",
      ...parsed.warnings,
    ];
  }

  return parsed;
}

/** @deprecated Prefer parseSupplyReceipt for multi-format uploads. */
export async function parseSupplyInvoicePdf(
  filePath: string,
  fileName?: string,
): Promise<SupplyInvoiceParseResult> {
  return parseSupplyReceipt(filePath, fileName);
}
