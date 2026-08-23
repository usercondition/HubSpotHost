/**
 * Shipping label PDF text → tracking / service / postage / recipient,
 * then match against Print Orders (open + recently completed).
 */
import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { z } from "zod";

export type ShippingLabelFields = {
  trackingNumber: string | null;
  service: string | null;
  carrier: string | null;
  postageUsd: string | null;
  recipientName: string | null;
  recipientCity: string | null;
  recipientState: string | null;
  recipientPostalCode: string | null;
  warnings: string[];
};

export type ShippingLabelMatchCandidate = {
  dealId: string;
  dealName: string;
  stage: string;
  contactName: string | null;
  amount: number;
  closed: boolean;
  score: number;
  reason: string;
};

const USPS_TRACKING =
  /\b((?:94|93|92|91|95|70|14|03)\d{18}|\d{20,22})\b/g;
const UPS_TRACKING = /\b(1Z[0-9A-Z]{16})\b/gi;
const FEDEX_TRACKING = /\b(\d{12,15})\b/g;

const SERVICE_PATTERNS: Array<{ re: RegExp; label: string; carrier: string }> = [
  { re: /ground\s*advantage/i, label: "USPS Ground Advantage", carrier: "USPS" },
  { re: /priority\s*mail\s*express/i, label: "USPS Priority Mail Express", carrier: "USPS" },
  { re: /priority\s*mail/i, label: "USPS Priority Mail", carrier: "USPS" },
  { re: /first[-\s]*class/i, label: "USPS First-Class", carrier: "USPS" },
  { re: /parcel\s*select/i, label: "USPS Parcel Select", carrier: "USPS" },
  { re: /\bUPS\s*Ground\b/i, label: "UPS Ground", carrier: "UPS" },
  { re: /\bFedEx\s*Ground\b/i, label: "FedEx Ground", carrier: "FedEx" },
  { re: /\bFedEx\s*Home\b/i, label: "FedEx Home Delivery", carrier: "FedEx" },
];

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function looksLikeUspsTracking(digits: string): boolean {
  if (digits.length < 20 || digits.length > 22) return false;
  return /^(94|93|92|91|95|70|14|03)/.test(digits);
}

/** Prefer longest / most USPS-like tracking candidates. */
export function extractTrackingNumber(text: string): { tracking: string | null; carrier: string | null } {
  const ups = text.match(UPS_TRACKING);
  if (ups?.[0]) return { tracking: ups[0].toUpperCase(), carrier: "UPS" };

  const uspsHits: string[] = [];
  for (const match of text.matchAll(USPS_TRACKING)) {
    const digits = compactDigits(match[1] ?? "");
    if (looksLikeUspsTracking(digits)) uspsHits.push(digits);
  }
  if (uspsHits.length > 0) {
    uspsHits.sort((a, b) => b.length - a.length);
    return { tracking: uspsHits[0] ?? null, carrier: "USPS" };
  }

  // FedEx last — many false positives on plain number runs.
  const fedex = [...text.matchAll(FEDEX_TRACKING)]
    .map((match) => match[1] ?? "")
    .filter((digits) => digits.length >= 12 && digits.length <= 15 && !looksLikeUspsTracking(digits));
  if (fedex[0]) return { tracking: fedex[0], carrier: "FedEx" };

  return { tracking: null, carrier: null };
}

export function extractService(text: string): { service: string | null; carrier: string | null } {
  for (const row of SERVICE_PATTERNS) {
    if (row.re.test(text)) return { service: row.label, carrier: row.carrier };
  }
  if (/\bUSPS\b/i.test(text)) return { service: null, carrier: "USPS" };
  if (/\bUPS\b/i.test(text)) return { service: null, carrier: "UPS" };
  if (/\bFedEx\b/i.test(text)) return { service: null, carrier: "FedEx" };
  return { service: null, carrier: null };
}

export function extractPostageUsd(text: string): string | null {
  const labeled =
    text.match(/postage(?:\s*paid)?[:\s]*\$?\s*(\d{1,3}(?:\.\d{2})?)/i) ||
    text.match(/(?:total|amount)\s*(?:charged|paid)?[:\s]*\$\s*(\d{1,3}\.\d{2})/i);
  if (labeled?.[1]) return Number(labeled[1]).toFixed(2);

  const money = text.match(/\$\s*(\d{1,3}\.\d{2})\b/);
  if (money?.[1]) {
    const value = Number(money[1]);
    if (value > 0 && value < 200) return value.toFixed(2);
  }
  return null;
}

/**
 * Best-effort recipient from Pirate Ship / USPS label text.
 * Looks for a “ship to” block, else a Name + City ST ZIP pattern.
 */
export function extractRecipient(text: string): {
  name: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
} {
  const normalized = text.replace(/\r/g, "\n");
  const shipTo = normalized.match(
    /(?:ship\s*to|deliver\s*to|to:)\s*\n+([^\n]{3,80})(?:\n([^\n]{3,80}))?(?:\n([^\n]{3,80}))?/i,
  );
  let name: string | null = null;
  let city: string | null = null;
  let state: string | null = null;
  let postalCode: string | null = null;

  const cityStateZip = normalized.match(
    /\b([A-Za-z][A-Za-z .'-]{1,40}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/,
  );
  if (cityStateZip) {
    city = cityStateZip[1]?.trim() ?? null;
    state = cityStateZip[2] ?? null;
    postalCode = cityStateZip[3] ?? null;
  }

  if (shipTo?.[1]) {
    const candidate = shipTo[1].trim();
    if (!/^(usps|ups|fedex|priority|ground|postage|from|return)/i.test(candidate)) {
      name = candidate;
    }
  }

  if (!name) {
    // “Product - Client” style: last human-looking line before city/state/zip.
    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const zipLineIdx = lines.findIndex((line) =>
      /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line),
    );
    if (zipLineIdx > 0) {
      for (let i = zipLineIdx - 1; i >= Math.max(0, zipLineIdx - 3); i -= 1) {
        const line = lines[i] ?? "";
        if (
          line.length >= 3 &&
          line.length <= 60 &&
          /[A-Za-z]/.test(line) &&
          !/^(usps|ups|fedex|priority|ground|postage|from|return|ship|street|ave|rd|blvd|\d+)/i.test(line)
        ) {
          name = line;
          break;
        }
      }
    }
  }

  return { name, city, state, postalCode };
}

export function extractShippingLabelFields(text: string): ShippingLabelFields {
  const warnings: string[] = [];
  const cleaned = text.replace(/\u0000/g, " ").trim();
  if (!cleaned) {
    return {
      trackingNumber: null,
      service: null,
      carrier: null,
      postageUsd: null,
      recipientName: null,
      recipientCity: null,
      recipientState: null,
      recipientPostalCode: null,
      warnings: ["No readable text in that PDF — try another export or enter tracking manually."],
    };
  }

  const tracking = extractTrackingNumber(cleaned);
  const service = extractService(cleaned);
  const postageUsd = extractPostageUsd(cleaned);
  const recipient = extractRecipient(cleaned);

  if (!tracking.tracking) warnings.push("Could not find a tracking number — confirm before saving.");
  if (!recipient.name) warnings.push("Could not read the recipient name — pick the order manually if needed.");

  return {
    trackingNumber: tracking.tracking,
    service: service.service,
    carrier: tracking.carrier ?? service.carrier,
    postageUsd,
    recipientName: recipient.name,
    recipientCity: recipient.city,
    recipientState: recipient.state,
    recipientPostalCode: recipient.postalCode,
    warnings,
  };
}

export async function extractShippingLabelFromPdf(filePath: string): Promise<{
  fields: ShippingLabelFields;
  pageCount: number;
  textPreview: string;
}> {
  const buffer = await fs.readFile(filePath);
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new Error("That file does not look like a PDF");
  }
  let parsed: { text?: string; numpages?: number };
  try {
    parsed = await pdfParse(buffer);
  } catch {
    throw new Error("The shipping label PDF could not be read.");
  }
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const fields = extractShippingLabelFields(text);
  return {
    fields,
    pageCount: typeof parsed.numpages === "number" ? parsed.numpages : 1,
    textPreview: text.slice(0, 1_200),
  };
}

function contactFromDealName(dealName: string): string | null {
  const separator = " - ";
  const index = dealName.lastIndexOf(separator);
  if (index < 0) return null;
  const contact = dealName.slice(index + separator.length).trim();
  return contact.length >= 2 ? contact : null;
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(normalizeName(a).split(" ").filter((t) => t.length > 1));
  const right = new Set(normalizeName(b).split(" ").filter((t) => t.length > 1));
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit += 1;
  }
  return hit / Math.max(left.size, right.size);
}

export function matchShippingLabelToDeals(
  fields: ShippingLabelFields,
  deals: Array<{
    dealId: string;
    dealName: string;
    stage: string;
    contactName: string | null;
    amount: number;
    closed?: boolean;
  }>,
): ShippingLabelMatchCandidate[] {
  const needle = fields.recipientName ? normalizeName(fields.recipientName) : "";
  const scored: ShippingLabelMatchCandidate[] = [];

  for (const deal of deals) {
    const contact = deal.contactName || contactFromDealName(deal.dealName) || "";
    const contactNorm = normalizeName(contact);
    const dealNorm = normalizeName(deal.dealName);
    let score = 0;
    const reasons: string[] = [];

    if (needle && contactNorm) {
      if (contactNorm === needle) {
        score += 100;
        reasons.push("Exact client name");
      } else if (contactNorm.includes(needle) || needle.includes(contactNorm)) {
        score += 70;
        reasons.push("Client name contains match");
      } else {
        const overlap = tokenOverlap(contactNorm, needle);
        if (overlap >= 0.5) {
          score += Math.round(overlap * 60);
          reasons.push("Partial client name match");
        }
      }
    }

    if (needle && dealNorm.includes(needle)) {
      score += 40;
      reasons.push("Name appears in deal title");
    }

    if (deal.closed) {
      score += 8;
      reasons.push("Completed (likely shipped)");
    } else if (/ready\s*to\s*ship|packag|ship/i.test(deal.stage)) {
      score += 12;
      reasons.push("Ship-stage deal");
    }

    if (score <= 0) continue;
    scored.push({
      dealId: deal.dealId,
      dealName: deal.dealName,
      stage: deal.stage,
      contactName: deal.contactName,
      amount: deal.amount,
      closed: Boolean(deal.closed),
      score,
      reason: reasons.join(" · ") || "Possible match",
    });
  }

  return scored.sort((a, b) => b.score - a.score || a.dealName.localeCompare(b.dealName)).slice(0, 8);
}

export function buildShipNotesFromLabel(fields: ShippingLabelFields): string {
  const parts: string[] = [];
  if (fields.service) parts.push(fields.service);
  else if (fields.carrier) parts.push(fields.carrier);
  if (fields.postageUsd) parts.push(`Postage $${fields.postageUsd}`);
  if (fields.recipientName) parts.push(`Label to ${fields.recipientName}`);
  return parts.join(" · ").slice(0, 2_000);
}

export const attachShippingLabelSchema = z.object({
  dealId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,20}$/, "Select a valid Print Order"),
  trackingNumber: z.string().trim().min(6).max(120),
  notes: z.string().trim().max(2_000).optional().default(""),
  postageUsd: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((value) => value === "" || Number.isFinite(Number(value.replace(/[$,\s]/g, ""))), "Enter a valid postage amount"),
  packingDone: z.boolean().optional().default(true),
  labelBought: z.boolean().optional().default(true),
  liveWrite: z.boolean().optional(),
});

export type AttachShippingLabelInput = z.infer<typeof attachShippingLabelSchema>;
