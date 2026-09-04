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
  /** Ship-to name printed on the label (may differ from the HubSpot/Marketplace buyer). */
  recipientName: string | null;
  /**
   * Marketplace / HubSpot client from the Pirate Ship file name
   * (`date---Client-Name---TRACKING.pdf`). Prefer this for deal matching.
   */
  clientName: string | null;
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

export function extractShippingLabelFields(text: string, fileName?: string): ShippingLabelFields {
  const warnings: string[] = [];
  const cleaned = text.replace(/\u0000/g, " ").trim();
  const fromName = extractFieldsFromFileName(fileName ?? "");

  if (!cleaned) {
    const fields: ShippingLabelFields = {
      trackingNumber: fromName.trackingNumber,
      service: fromName.service,
      carrier: fromName.carrier,
      postageUsd: null,
      recipientName: fromName.recipientName,
      clientName: fromName.recipientName,
      recipientCity: null,
      recipientState: null,
      recipientPostalCode: null,
      warnings: [],
    };
    if (fromName.trackingNumber || fromName.recipientName) {
      fields.warnings.push(
        "Label PDF has no text layer (common for Pirate Ship) — filled tracking/client from the file name. Confirm postage if you want it saved.",
      );
      return fields;
    }
    fields.warnings.push(
      "No readable text in that PDF — try another export or enter tracking manually.",
    );
    return fields;
  }

  const tracking = extractTrackingNumber(cleaned);
  const service = extractService(cleaned);
  const postageUsd = extractPostageUsd(cleaned);
  const recipient = extractRecipient(cleaned);

  const trackingNumber = tracking.tracking ?? fromName.trackingNumber;
  const carrier = tracking.carrier ?? service.carrier ?? fromName.carrier;
  const serviceLabel = service.service ?? fromName.service;
  // Ship-to on the label (gift / relative address) vs Marketplace client in the file name.
  const recipientName = recipient.name ?? fromName.recipientName;
  const clientName = fromName.recipientName;

  if (!trackingNumber) warnings.push("Could not find a tracking number — confirm before saving.");
  if (!recipientName && !clientName) {
    warnings.push("Could not read a client or ship-to name — pick the order manually if needed.");
  }
  if (!tracking.tracking && fromName.trackingNumber) {
    warnings.push("Tracking taken from the file name.");
  }
  if (clientName && recipient.name && normalizeName(clientName) !== normalizeName(recipient.name)) {
    warnings.push(
      `Ship-to is ${recipient.name}; matching HubSpot orders to file-name client ${clientName}.`,
    );
  } else if (!recipient.name && clientName) {
    warnings.push("Client name taken from the file name.");
  }

  return {
    trackingNumber,
    service: serviceLabel,
    carrier,
    postageUsd,
    recipientName,
    clientName,
    recipientCity: recipient.city,
    recipientState: recipient.state,
    recipientPostalCode: recipient.postalCode,
    warnings,
  };
}

/**
 * Pirate Ship / common exports often name files:
 * `2026-08-22---Luke-Price---1ZXG9979YN44057388.pdf`
 */
export function extractFieldsFromFileName(fileName: string): {
  trackingNumber: string | null;
  carrier: string | null;
  service: string | null;
  recipientName: string | null;
} {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.pdf$/i, "").trim();
  if (!base) {
    return { trackingNumber: null, carrier: null, service: null, recipientName: null };
  }

  const parts = base.split("---").map((part) => part.trim()).filter(Boolean);
  let trackingNumber: string | null = null;
  let carrier: string | null = null;
  let recipientName: string | null = null;

  for (const part of parts) {
    const hit = extractTrackingNumber(part);
    if (hit.tracking) {
      trackingNumber = hit.tracking;
      carrier = hit.carrier;
      break;
    }
    // Filename segments sometimes glue letters to tracking; still catch 1Z…
    const upsEmbedded = part.match(/(1Z[0-9A-Z]{16})/i);
    if (upsEmbedded?.[1]) {
      trackingNumber = upsEmbedded[1].toUpperCase();
      carrier = "UPS";
      break;
    }
    const uspsEmbedded = part.match(/((?:94|93|92|91|95)\d{18})/);
    if (uspsEmbedded?.[1]) {
      trackingNumber = uspsEmbedded[1];
      carrier = "USPS";
      break;
    }
  }

  // date---Client-Name---TRACKING
  if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? "")) {
    const middle = parts[1] ?? "";
    if (middle && !extractTrackingNumber(middle).tracking && !/(1Z[0-9A-Z]{16})/i.test(middle)) {
      recipientName = middle.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    }
  } else if (parts.length >= 2) {
    const maybeName = parts.find((part) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(part)) return false;
      if (trackingNumber && part.toUpperCase().includes(trackingNumber)) return false;
      if (extractTrackingNumber(part).tracking) return false;
      return /[A-Za-z]{2}/.test(part);
    });
    if (maybeName) recipientName = maybeName.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  }

  if (recipientName && recipientName.length < 2) recipientName = null;

  return {
    trackingNumber,
    carrier,
    service: trackingNumber?.startsWith("1Z") ? "UPS" : null,
    recipientName,
  };
}

export async function extractShippingLabelFromPdf(
  filePath: string,
  fileName?: string,
): Promise<{
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
  const resolvedName = fileName || filePath.split(/[\\/]/).pop() || "";
  const fields = extractShippingLabelFields(text, resolvedName);
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

function scoreNameAgainstDeal(needle: string, contactNorm: string, dealNorm: string): {
  score: number;
  reasons: string[];
} {
  if (!needle) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;

  if (contactNorm) {
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

  if (dealNorm.includes(needle)) {
    score += 40;
    reasons.push("Name appears in deal title");
  }

  return { score, reasons };
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
  // Prefer Marketplace client from the file name; fall back to ship-to on the label.
  const primaryNeedle = fields.clientName ? normalizeName(fields.clientName) : "";
  const shipToNeedle =
    fields.recipientName && normalizeName(fields.recipientName) !== primaryNeedle
      ? normalizeName(fields.recipientName)
      : "";
  const hasNameNeedle = Boolean(primaryNeedle || shipToNeedle);
  const scored: ShippingLabelMatchCandidate[] = [];

  for (const deal of deals) {
    const contact = deal.contactName || contactFromDealName(deal.dealName) || "";
    const contactNorm = normalizeName(contact);
    const dealNorm = normalizeName(deal.dealName);
    let score = 0;
    const reasons: string[] = [];

    if (primaryNeedle) {
      const primary = scoreNameAgainstDeal(primaryNeedle, contactNorm, dealNorm);
      if (primary.score > 0) {
        score += primary.score + 20; // Prefer file-name client over ship-to-only hits.
        reasons.push(...primary.reasons.map((reason) => `${reason} (file name)`));
      }
    }

    if (shipToNeedle) {
      const shipTo = scoreNameAgainstDeal(shipToNeedle, contactNorm, dealNorm);
      if (shipTo.score > 0) {
        score += shipTo.score;
        reasons.push(...shipTo.reasons.map((reason) => `${reason} (ship-to)`));
      }
    }

    // Stage bonus is a tie-breaker only — never the sole reason to auto-select.
    let stageBonus = 0;
    if (deal.closed) {
      stageBonus = 8;
    } else if (/ready\s*to\s*ship|packag|ship/i.test(deal.stage)) {
      stageBonus = 12;
    }

    if (hasNameNeedle && score <= 0) {
      // We know who the buyer/ship-to is; skip unrelated Ready-to-Ship deals.
      continue;
    }

    if (stageBonus > 0) {
      score += stageBonus;
      reasons.push(deal.closed ? "Completed (likely shipped)" : "Ship-stage deal");
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

export const attachShippingLabelSchema = z
  .object({
    /** Single-deal attach (legacy). Prefer dealIds for shared-box shipments. */
    dealId: z
      .string()
      .trim()
      .regex(/^[0-9]{1,20}$/, "Select a valid Print Order")
      .optional(),
    /** Attach the same tracking to one or more Print Orders (same client / same box). */
    dealIds: z
      .array(z.string().trim().regex(/^[0-9]{1,20}$/, "Select a valid Print Order"))
      .min(1)
      .max(20)
      .optional(),
    trackingNumber: z.string().trim().min(6).max(120),
    notes: z.string().trim().max(2_000).optional().default(""),
    postageUsd: z
      .string()
      .trim()
      .optional()
      .default("")
      .refine(
        (value) => value === "" || Number.isFinite(Number(value.replace(/[$,\s]/g, ""))),
        "Enter a valid postage amount",
      ),
    packingDone: z.boolean().optional().default(true),
    labelBought: z.boolean().optional().default(true),
    /** Move Print Order(s) to HubSpot Completed / Closed Won after attach. */
    markComplete: z.boolean().optional().default(true),
    /** Explicit buyer-chat channel; existing orders do not carry this metadata. */
    messageChannel: z.enum(["marketplace", "offerup"]).optional().default("marketplace"),
    liveWrite: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const ids = [
      ...(value.dealIds ?? []),
      ...(value.dealId ? [value.dealId] : []),
    ].filter(Boolean);
    if (ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select at least one Print Order",
        path: ["dealIds"],
      });
    }
  })
  .transform((value) => {
    const dealIds = Array.from(
      new Set([...(value.dealIds ?? []), ...(value.dealId ? [value.dealId] : [])]),
    );
    return {
      dealIds,
      trackingNumber: value.trackingNumber,
      notes: value.notes,
      postageUsd: value.postageUsd,
      packingDone: value.packingDone,
      labelBought: value.labelBought,
      markComplete: value.markComplete,
      messageChannel: value.messageChannel,
      liveWrite: value.liveWrite,
    };
  });

export type AttachShippingLabelInput = z.infer<typeof attachShippingLabelSchema>;

