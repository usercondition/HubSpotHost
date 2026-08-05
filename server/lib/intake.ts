/**
 * Paid-order intake parsing and validation.
 *
 * Marketplace conversations can vary wildly, so this deliberately produces
 * editable suggestions instead of pretending that a parser is authoritative.
 * It never writes or retains the raw conversation text.
 */

import type { PaidOrderAnalysis, PaidOrderDraft } from "../../shared/schema";

export type { PaidOrderAnalysis, PaidOrderDraft };

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/;
const MONEY_RE = /(?:\$|USD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/i;
const PAYMENT_RE =
  /\b(?:paid(?:\s+in\s+full)?|payment\s+(?:sent|received|complete)|sent\s+(?:the\s+)?payment|invoice\s+paid)\b/i;
const NEGATED_PAYMENT_RE = /\b(?:not\s+paid|haven'?t\s+paid|will\s+pay|can\s+pay|payment\s+pending)\b/i;
const ADDRESS_RE =
  /(?:shipping\s+address|ship\s+(?:it|to)|address)\s*[:\-]?\s*([^\n]{6,160})/i;
const FIELD_RE = (names: string) => new RegExp(`(?:${names})\\s*[:\\-]\\s*([^\\n]{2,120})`, "i");

function clean(value: string | undefined, limit = 160): string {
  return (value ?? "").replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "").slice(0, limit);
}

function normalizedLines(conversation: string): string[] {
  return conversation
    .split(/\r?\n/)
    .map((line) => clean(line, 300))
    .filter(Boolean);
}

function firstMatch(conversation: string, regex: RegExp): string {
  const found = conversation.match(regex);
  return clean(found?.[1] ?? found?.[0] ?? "");
}

function inferName(lines: string[], conversation: string): string {
  const labeled = firstMatch(
    conversation,
    FIELD_RE("buyer(?:\\s+name)?|customer(?:\\s+name)?|name|from"),
  );
  if (labeled && /^[A-Za-z][A-Za-z' -]{1,80}$/.test(labeled)) return labeled;

  const greeting = lines
    .map((line) => line.match(/^(?:hi|hello|hey)[,!]?\s+(?:i(?:'m| am)\s+)?([A-Z][A-Za-z' -]{1,60})/))
    .find(Boolean);
  return clean(greeting?.[1] ?? "");
}

function inferProduct(lines: string[], conversation: string): string {
  const labeled = firstMatch(
    conversation,
    FIELD_RE("model|item|product|print(?:\\s+request)?|order"),
  );
  if (labeled && labeled.length >= 3) return labeled;

  const phrase =
    conversation.match(
      /\b(?:looking for|want(?:\s+to\s+order)?|would like|interested in|need|printing)\s+(?:an?\s+)?([^.!?\n]{4,100})/i,
    )?.[1] ?? "";
  if (clean(phrase).length >= 4) return clean(phrase);

  const modelLine = lines.find((line) =>
    /\b(?:knight|titan|miniature|model|figure|warhammer|print)\b/i.test(line),
  );
  return clean(modelLine);
}

function inferAddress(conversation: string) {
  const raw = firstMatch(conversation, ADDRESS_RE);
  if (!raw) return { address: "", city: "", state: "", postalCode: "", country: "" };

  const postal = raw.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] ?? "";
  const state = raw.match(/\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/i)?.[0] ?? "";
  const city =
    raw
      .replace(postal, "")
      .replace(new RegExp(`\\b${state}\\b`, "i"), "")
      .split(",")
      .map((part) => clean(part))
      .filter((part) => /^[A-Za-z][A-Za-z .'-]{1,50}$/.test(part))
      .at(-1) ?? "";

  return {
    address: clean(raw.replace(city, "").replace(state, "").replace(postal, "").replace(/,\s*,/g, ",")),
    city,
    state: state.toUpperCase(),
    postalCode: postal,
    country: /\b(?:usa|united states|us)\b/i.test(raw) ? "United States" : "",
  };
}

export function analyzeMarketplaceConversation(conversation: string): PaidOrderAnalysis {
  const source = conversation.trim().slice(0, 20_000);
  const lines = normalizedLines(source);
  const email = source.match(EMAIL_RE)?.[0] ?? "";
  const phone = source.match(PHONE_RE)?.[0] ?? "";
  const amount = (source.match(MONEY_RE)?.[1] ?? "").replace(/,/g, "");
  const fullName = inferName(lines, source);
  const marketplaceUsername = firstMatch(
    source,
    FIELD_RE("facebook(?:\\s+name)?|marketplace(?:\\s+name|\\s+username)?|username|profile"),
  );
  const productName = inferProduct(lines, source);
  const address = inferAddress(source);
  const paymentLanguageDetected = PAYMENT_RE.test(source) && !NEGATED_PAYMENT_RE.test(source);

  const missing = [
    !fullName && !marketplaceUsername ? "Client name or Marketplace username" : "",
    !productName ? "Model or order description" : "",
    !amount ? "Paid amount" : "",
    !paymentLanguageDetected ? "Clear payment confirmation" : "",
    !address.address ? "Shipping address, if shipping is required" : "",
  ].filter(Boolean);

  const summaryParts = [
    "Facebook Marketplace paid-order intake.",
    productName ? `Requested item: ${productName}.` : "",
    amount ? `Captured amount: $${amount}.` : "",
    paymentLanguageDetected ? "Payment language was detected in the conversation." : "",
    missing.length ? `Still verify: ${missing.join("; ")}.` : "Core order details were detected.",
  ].filter(Boolean);

  return {
    fullName,
    marketplaceUsername,
    email: clean(email),
    phone: clean(phone),
    ...address,
    productName,
    amount,
    conversationSummary: summaryParts.join(" "),
    missing,
    paymentLanguageDetected,
  };
}

export function validatePaidOrderDraft(input: PaidOrderDraft): string | null {
  if (!input.paymentConfirmed) return "Payment must be confirmed before a HubSpot order is created";
  if (!clean(input.fullName) && !clean(input.marketplaceUsername)) {
    return "Enter the client's name or Marketplace username";
  }
  if (!clean(input.productName)) return "Enter the model or order description";
  const amount = Number(String(input.amount).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a paid amount greater than zero";
  return null;
}

export function validatePaidOrderLineItems(
  lines: Array<{ productName: string; amount: string }>,
): string | null {
  if (lines.length === 0) return "Add at least one order item";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!clean(line.productName)) return `Item ${index + 1} needs a model or order description`;
    const amount = Number(String(line.amount).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      return `Item ${index + 1} needs a paid amount greater than zero`;
    }
  }
  return null;
}

export function splitName(fullName: string, fallback: string): { firstName: string; lastName: string } {
  const parts = clean(fullName).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: clean(fallback) || "Marketplace customer", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
