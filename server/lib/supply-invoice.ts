import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { suggestSupplyCategory } from "./supplies";
import {
  summarizeSupplyLineItems,
  type SupplyCategory,
  type SupplyPurchaseLineItem,
} from "../../shared/schema";

const MEBIBYTE = 1024 * 1024;
export const SUPPLY_INVOICE_MAX_BYTES = 12 * MEBIBYTE;
export const SUPPLY_INVOICE_MAX_LABEL = "12 MB";

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

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
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

function extractOrderReference(text: string): string | null {
  const amazon = text.match(/\b(1\d{2}-\d{7}-\d{7})\b/);
  if (amazon?.[1]) return amazon[1];

  const labeled = text.match(
    /\b(?:Order|Invoice|Receipt|PO|Purchase\s*Order)\s*(?:#|Number|No\.?|ID)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,40})\b/i,
  );
  if (labeled?.[1] && !/^(date|total|item|qty|invoice|order|number|receipt)$/i.test(labeled[1])) {
    return labeled[1];
  }
  return null;
}

function extractTotalAmount(text: string): string | null {
  const patterns = [
    /Grand\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Order\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Amount\s*Due\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Total\s*(?:Paid|Charged)?\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /Invoice\s*Total\s*[:\s]*\$?\s*([\d,]+\.\d{2})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const money = moneyFromMatch(match?.[1]);
    if (money) return money;
  }

  // Last-resort: the largest dollar amount that looks like a line total.
  const amounts: number[] = [];
  const moneyPattern = /\$\s*([\d,]+\.\d{2})\b/g;
  let moneyMatch: RegExpExecArray | null;
  while ((moneyMatch = moneyPattern.exec(text)) !== null) {
    const money = moneyFromMatch(moneyMatch[1]);
    if (!money) continue;
    const amount = Number(money);
    if (amount > 0 && amount < 100_000) amounts.push(amount);
  }
  if (amounts.length === 0) return null;
  return Math.max(...amounts).toFixed(2);
}

function extractPurchasedAt(text: string): string | null {
  const labeled = text.match(
    /(?:Order\s*Placed|Order\s*Date|Invoice\s*Date|Purchase\s*Date|Date\s*of\s*Purchase|Date)\s*[:\s]+([^\n]{6,40})/i,
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
    normalized.length < 4 ||
    /^(amazon\.com|final details|order information|billing|shipping|payment|sold by|condition:|thank you|invoice|receipt|page\s+\d)/i.test(
      normalized,
    ) ||
    /^(subtotal|shipping|tax|total|grand total|order total|amount due)/i.test(normalized) ||
    /^\$?\d/.test(normalized) ||
    /^(https?:|www\.)/i.test(normalized)
  );
}

function isSectionEnd(line: string): boolean {
  return /^(subtotal|shipping|tax|estimated tax|total before|grand total|order total|amount due|payment information|billing address|shipping address)/i.test(
    line,
  );
}

function extractLineItems(text: string): SupplyPurchaseLineItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const items: SupplyPurchaseLineItem[] = [];
  let inItems = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (/^Items?\s+Ordered$/i.test(line) || /^Order\s+Details$/i.test(line)) {
      inItems = true;
      continue;
    }
    if (inItems && isSectionEnd(line)) break;
    if (!inItems) continue;
    if (looksLikeNoiseItem(line)) continue;
    if (/sold by|condition:|asin|unit price|of:|shipment/i.test(line)) continue;
    if (/^quantity\b/i.test(line)) continue;

    // Product title line — gather qty / price from the next few lines.
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

      const totalMatch = next.match(
        /\b(?:Item\s*)?(?:Sub)?total\s*[:\s]*\$?\s*([\d,]+\.\d{2})\b/i,
      );
      if (totalMatch) lineTotal = moneyFromMatch(totalMatch[1]);

      // Amazon often prints "$28.99" alone after quantity.
      if (!unitPrice && !lineTotal) {
        const lone = next.match(/^\$?\s*([\d,]+\.\d{2})$/);
        if (lone) unitPrice = moneyFromMatch(lone[1]);
      }

      // Next product title ends this block.
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
    if (!amount && unitPrice) {
      amount = (Number(unitPrice) * quantity).toFixed(2);
    }

    items.push({
      itemName: line.slice(0, 300),
      quantity,
      lineAmount: amount ?? "",
      category: suggestSupplyCategory(line),
    });

    if (items.length >= 40) break;
  }

  if (items.length > 0) return items;

  // Generic single-description invoices.
  const titled = text.match(
    /(?:Item(?:\s*Description)?|Description|Product)\s*[:\s]+([^\n]{4,300})/i,
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

function detectSource(text: string, fileName?: string): string {
  const haystack = `${text}\n${fileName ?? ""}`.toLowerCase();
  if (/\bamazon\b/.test(haystack) || /\b1\d{2}-\d{7}-\d{7}\b/.test(text)) return "Amazon";
  if (/\bebay\b/.test(haystack)) return "eBay";
  if (/\betsy\b/.test(haystack)) return "Etsy";
  if (/\bwalmart\b/.test(haystack)) return "Walmart";
  if (/\bulta\b|\bhome depot\b|\bmcmaster\b/.test(haystack)) {
    if (/\bhome depot\b/.test(haystack)) return "Home Depot";
    if (/\bmcmaster\b/.test(haystack)) return "McMaster-Carr";
  }
  return "Amazon";
}

function localTodayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** Pure text heuristics used by the PDF path and unit tests. */
export function extractSupplyInvoiceFromText(
  text: string,
  options: { fileName?: string; pageCount?: number } = {},
): SupplyInvoiceParseResult {
  const cleaned = text.replace(/\u0000/g, " ");
  const warnings: string[] = [];

  const lineItems = extractLineItems(cleaned);
  const summary = summarizeSupplyLineItems(lineItems);
  const itemName = summary.itemName || extractItemName(cleaned);
  const totalAmount = extractTotalAmount(cleaned);
  const purchasedAt = extractPurchasedAt(cleaned);
  const orderReference = extractOrderReference(cleaned);
  const quantity = summary.quantity || extractQuantity(cleaned) || 1;
  const source = detectSource(cleaned, options.fileName);

  if (lineItems.length === 0) warnings.push("Could not find a clear item name — enter it manually.");
  if (!totalAmount) warnings.push("Could not find a receipt total — enter the amount paid.");
  if (!purchasedAt) warnings.push("Could not find a purchase date — today's date was used.");
  if (!orderReference) warnings.push("No order or invoice number was found.");
  if (lineItems.length > 1) {
    warnings.push(`Found ${lineItems.length} line items — review the breakdown before saving.`);
  } else if (lineItems.length === 1 && !lineItems[0]!.quantity) {
    warnings.push("Quantity was not found — defaulted to 1.");
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
  };
}

export async function parseSupplyInvoicePdf(
  filePath: string,
  fileName?: string,
): Promise<SupplyInvoiceParseResult> {
  const buffer = await fs.readFile(filePath);
  if (buffer.length === 0) {
    throw new Error("That PDF is empty");
  }
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new Error("That file does not look like a PDF invoice");
  }

  let parsed: { text?: string; numpages?: number };
  try {
    parsed = await pdfParse(buffer);
  } catch {
    throw new Error("The PDF could not be read. Try exporting a text-based invoice, not a scanned image.");
  }

  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    throw new Error(
      "No readable text was found in that PDF. Image-only scans cannot be extracted yet — enter the receipt manually.",
    );
  }

  return extractSupplyInvoiceFromText(text, {
    fileName,
    pageCount: typeof parsed.numpages === "number" ? parsed.numpages : 1,
  });
}

export function isPdfInvoiceFileName(fileName: string | undefined): boolean {
  return pathExt(fileName) === ".pdf";
}

function pathExt(fileName: string | undefined): string {
  if (!fileName) return "";
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}
