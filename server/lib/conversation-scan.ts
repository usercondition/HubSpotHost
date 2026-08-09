/**
 * Marketplace conversation scan: labeled buyer/you turns → stage + nudges.
 *
 * Used by the Chrome helper and by paste-with-labels testing. Never writes to
 * HubSpot. Raw messages are not persisted; only watchlist summaries are saved.
 */

import crypto from "node:crypto";
import {
  CONVERSATION_STAGE_LABELS,
  type ConversationMessage,
  type ConversationMessageRole,
  type ConversationNudge,
  type ConversationScanResult,
  type ConversationStage,
  type ConversationWaitingOn,
  type PaidOrderAnalysis,
} from "../../shared/schema";
import { analyzeMarketplaceConversation } from "./intake";

const ROLE_LABEL: Record<ConversationMessageRole, string> = {
  buyer: "buyer",
  you: "you",
  system: "system",
};

const MONEY_RE = /(?:\$|USD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/i;
const PAYMENT_RE =
  /\b(?:paid(?:\s+in\s+full)?|payment\s+(?:sent|received|complete)|sent\s+(?:the\s+)?payment|venmo(?:'d|ed)?|zelle(?:'d|ed)?|cash\s*app|invoice\s+paid)\b/i;
const NEGATED_PAYMENT_RE = /\b(?:not\s+paid|haven'?t\s+paid|will\s+pay|can\s+pay|payment\s+pending|waiting\s+(?:on|for)\s+payment)\b/i;
const PRICE_OFFER_RE =
  /\b(?:\$\d|\d+\s*(?:usd|bucks)|i\s+can\s+do|would\s+be|price\s+is|shipped\s+for|total\s+(?:is|of))\b/i;
const DETAILS_RE =
  /\b(?:shipping\s+address|ship\s+(?:it\s+)?to|my\s+address|email|phone|pickup|order\s+form|fill\s+(?:this|out)|details\s+link)\b/i;
const FULFILLMENT_RE =
  /\b(?:tracking(?:\s+number)?|it'?s\s+printing|on\s+the\s+printer|in\s+the\s+printer|curing|packed|out\s+for\s+delivery|on\s+the\s+way|ready\s+(?:for\s+)?pickup|eta\s+(?:is|for)|update\s+on\s+(?:my|the)\s+order|shipped\s+(?:it|today|your|the)|just\s+shipped)\b/i;
const INTEREST_RE =
  /\b(?:interested|still\s+available|do\s+you\s+(?:print|make)|looking\s+for|how\s+much|what(?:'?s|\s+is)\s+the\s+price)\b/i;

export type ConversationScanInput = {
  messages?: ConversationMessage[];
  /** Fallback: labeled or unlabeled text (same as Manual paste). */
  conversation?: string;
  counterpartName?: string;
  threadUrl?: string;
  threadKey?: string;
  /** When true, upsert the watchlist row for buried follow-up reminders. */
  saveToWatchlist?: boolean;
};

function clean(value: string | undefined, limit = 400): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeRole(value: unknown): ConversationMessageRole | null {
  const role = String(value ?? "")
    .trim()
    .toLowerCase();
  if (role === "buyer" || role === "them" || role === "customer" || role === "left" || role === "inbound") {
    return "buyer";
  }
  if (role === "you" || role === "me" || role === "seller" || role === "right" || role === "outbound") {
    return "you";
  }
  if (role === "system" || role === "notice" || role === "meta") return "system";
  return null;
}

/** Parse `[buyer] hi` / `buyer: hi` / `L: hi` style lines into messages. */
export function parseLabeledConversation(text: string): ConversationMessage[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const messages: ConversationMessage[] = [];
  for (const line of lines) {
    const bracket = line.match(/^\[(buyer|you|system|them|me|seller|customer|left|right|l|r)\]\s*(.+)$/i);
    const colon = line.match(/^(buyer|you|system|them|me|seller|customer|left|right|l|r)\s*[:\-]\s*(.+)$/i);
    const hit = bracket || colon;
    if (hit) {
      const role = normalizeRole(hit[1]);
      const body = clean(hit[2], 2000);
      if (role && body) messages.push({ role, text: body });
      continue;
    }
    // Unlabeled continuation: attach to previous non-system turn, else buyer.
    const body = clean(line, 2000);
    if (!body) continue;
    const prev = messages.at(-1);
    if (prev && prev.role !== "system") {
      prev.text = clean(`${prev.text} ${body}`, 2000);
    } else {
      messages.push({ role: "buyer", text: body });
    }
  }
  return messages;
}

export function normalizeScanMessages(input: ConversationScanInput): ConversationMessage[] {
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    return input.messages
      .map((row) => {
        const role = normalizeRole(row?.role);
        const text = clean(typeof row?.text === "string" ? row.text : "", 2000);
        if (!role || !text) return null;
        const sentAt =
          typeof row.sentAt === "string" && !Number.isNaN(Date.parse(row.sentAt))
            ? new Date(row.sentAt).toISOString()
            : undefined;
        return { role, text, ...(sentAt ? { sentAt } : {}) } satisfies ConversationMessage;
      })
      .filter((row): row is ConversationMessage => Boolean(row))
      .slice(0, 400);
  }
  const raw = typeof input.conversation === "string" ? input.conversation : "";
  return parseLabeledConversation(raw).slice(0, 400);
}

export function formatLabeledTranscript(messages: ConversationMessage[]): string {
  return messages.map((message) => `[${ROLE_LABEL[message.role]}] ${message.text}`).join("\n");
}

export function deriveThreadKey(input: {
  threadKey?: string;
  threadUrl?: string;
  counterpartName?: string;
  labeledTranscript: string;
}): string {
  const explicit = clean(input.threadKey, 120);
  if (explicit) return explicit.toLowerCase();

  const url = clean(input.threadUrl, 500);
  const marketplaceThread = url.match(/marketplace\/t\/([^/?#]+)/i)?.[1];
  if (marketplaceThread) return `mp:${marketplaceThread}`;
  const messageThread = url.match(/\/(?:messages|t)\/t\.([^/?#]+)/i)?.[1];
  if (messageThread) return `msg:${messageThread}`;

  const name = clean(input.counterpartName, 80).toLowerCase();
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${name}|${input.labeledTranscript.slice(0, 400)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return name ? `name:${name.replace(/\s+/g, "-")}:${fingerprint}` : `anon:${fingerprint}`;
}

function joinedText(messages: ConversationMessage[], role?: ConversationMessageRole): string {
  return messages
    .filter((message) => (role ? message.role === role : true))
    .map((message) => message.text)
    .join("\n");
}

function lastNonSystem(messages: ConversationMessage[]): ConversationMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "system") return message;
  }
  return null;
}

export function inferWaitingOn(messages: ConversationMessage[]): ConversationWaitingOn {
  const last = lastNonSystem(messages);
  if (!last) return "none";
  if (last.role === "buyer") return "you";
  if (last.role === "you") return "buyer";
  return "none";
}

export function inferConversationStage(
  messages: ConversationMessage[],
  analysis: PaidOrderAnalysis,
): ConversationStage {
  const all = joinedText(messages);
  const buyer = joinedText(messages, "buyer");
  const you = joinedText(messages, "you");

  const paymentClaimed =
    (PAYMENT_RE.test(buyer) && !NEGATED_PAYMENT_RE.test(buyer)) || analysis.paymentLanguageDetected;
  const hasAmount = Boolean(analysis.amount) || MONEY_RE.test(all);
  const priceDiscussed = PRICE_OFFER_RE.test(all) || hasAmount;
  const detailsPresent =
    DETAILS_RE.test(all) ||
    Boolean(analysis.address || analysis.email || analysis.phone);
  const fulfillment = FULFILLMENT_RE.test(all);
  const inquiry = INTEREST_RE.test(buyer) || messages.length <= 2;

  if (fulfillment && paymentClaimed) return "fulfillment_chat";
  if (paymentClaimed && detailsPresent && hasAmount && analysis.productName) return "ready_for_intake";
  if (paymentClaimed && detailsPresent) return "collecting_details";
  if (paymentClaimed) return "payment_claimed";
  if (fulfillment) return "fulfillment_chat";
  if (priceDiscussed && (/\b(?:works|deal|sounds good|i'?ll take|agreed)\b/i.test(buyer) || /venmo|zelle|pay/i.test(you))) {
    return "awaiting_payment";
  }
  if (priceDiscussed) return "negotiating";
  if (inquiry) return "inquiry";
  return messages.length > 0 ? "negotiating" : "unknown";
}

function buildNudges(input: {
  stage: ConversationStage;
  waitingOn: ConversationWaitingOn;
  analysis: PaidOrderAnalysis;
  counterpartName: string;
}): ConversationNudge[] {
  const { stage, waitingOn, analysis, counterpartName } = input;
  const who = counterpartName || "this buyer";
  const nudges: ConversationNudge[] = [];

  if (waitingOn === "you") {
    nudges.push({
      priority: "high",
      title: `${who} is waiting on your reply`,
      detail: "Their last message is unanswered. Reply or snooze this watchlist item if you already handled it elsewhere.",
    });
  }

  switch (stage) {
    case "inquiry":
      nudges.push({
        priority: waitingOn === "you" ? "high" : "medium",
        title: "Send availability + ballpark price",
        detail: "Confirm you can print it, ask size/material preferences, and quote shipped vs pickup.",
        suggestedReply: `Hey! Yes I can print that. Do you want it shipped or pickup? I can do it for $XX shipped (or less for pickup).`,
      });
      break;
    case "negotiating":
      nudges.push({
        priority: "medium",
        title: "Close on price and payment method",
        detail: analysis.amount
          ? `Amount $${analysis.amount} was mentioned — confirm the total and how they should pay.`
          : "No clear amount yet — send a firm quote before asking for payment.",
        suggestedReply: analysis.amount
          ? `Sounds good — $${analysis.amount} total. Venmo/Zelle works. Once paid I’ll send a short form for shipping details.`
          : `I can do this for $XX shipped. If that works, pay via Venmo/Zelle and I’ll send the details form.`,
      });
      break;
    case "awaiting_payment":
      nudges.push({
        priority: waitingOn === "buyer" ? "low" : "high",
        title: waitingOn === "buyer" ? "Waiting on their payment" : "Buyer may be stuck on payment",
        detail: "Don’t create a HubSpot deal until payment is confirmed.",
        suggestedReply:
          waitingOn === "buyer"
            ? `Just checking in — whenever payment lands I’ll send the order form for your shipping details.`
            : `Happy to hold it. Payment via Venmo/Zelle, then I’ll send the private order form.`,
      });
      break;
    case "payment_claimed":
      nudges.push({
        priority: "high",
        title: "Verify payment, then send the order link",
        detail: "Buyer claims they paid. Confirm it cleared, then create an Order link and paste it in chat.",
        suggestedReply: `Got it — once I confirm payment I’ll send a private link for your shipping details (takes a minute).`,
        actionHref: "/orders",
      });
      break;
    case "collecting_details":
      nudges.push({
        priority: "high",
        title: "Finish collecting details or nudge the form",
        detail: analysis.missing.length
          ? `Still missing: ${analysis.missing.join("; ")}.`
          : "Details look mostly present — review and create the Print Order when payment is verified.",
        suggestedReply: `Quick nudge on the details form whenever you have a sec — then I can get it into the print queue.`,
        actionHref: "/orders",
      });
      break;
    case "ready_for_intake":
      nudges.push({
        priority: "high",
        title: "Ready for Manual / Order link intake",
        detail: "Payment language + product/amount/details detected. Create the Contact + Print Order after you verify payment.",
        actionHref: "/manual",
      });
      break;
    case "fulfillment_chat":
      nudges.push({
        priority: waitingOn === "you" ? "high" : "medium",
        title: waitingOn === "you" ? "Buyer wants a status update" : "Fulfillment chat — keep HubSpot stage current",
        detail: "Reply with ETA / tracking, and update the Print Order stage if the plate already shipped.",
        suggestedReply: `Thanks for checking in — it’s currently [printing / curing / packing / shipped]. I’ll update you as soon as there’s tracking or pickup ready.`,
        actionHref: "/prints",
      });
      break;
    default:
      nudges.push({
        priority: "low",
        title: "Scan captured, stage unclear",
        detail: "Skim the labeled transcript and save to the watchlist so buried follow-ups still surface.",
      });
  }

  if (waitingOn === "buyer" && stage !== "awaiting_payment") {
    nudges.push({
      priority: "low",
      title: "Ball is in their court",
      detail: "No action required unless this goes quiet too long — the watchlist will remind you.",
    });
  }

  return nudges.slice(0, 4);
}

function buildHeadline(stage: ConversationStage, waitingOn: ConversationWaitingOn, counterpartName: string): string {
  const who = counterpartName || "Buyer";
  if (waitingOn === "you") {
    return `${who} is waiting on you · ${CONVERSATION_STAGE_LABELS[stage]}`;
  }
  if (waitingOn === "buyer") {
    return `Waiting on ${who} · ${CONVERSATION_STAGE_LABELS[stage]}`;
  }
  return CONVERSATION_STAGE_LABELS[stage];
}

export function scanConversation(input: ConversationScanInput): Omit<ConversationScanResult, "watchlistId"> {
  const messages = normalizeScanMessages(input);
  if (messages.length === 0) {
    throw new Error("Add at least one labeled Marketplace message to scan");
  }

  const labeledTranscript = formatLabeledTranscript(messages);
  const analysis = analyzeMarketplaceConversation(labeledTranscript);
  const counterpartName =
    clean(input.counterpartName, 100) ||
    clean(analysis.fullName, 100) ||
    clean(analysis.marketplaceUsername, 100);
  const stage = inferConversationStage(messages, analysis);
  const waitingOn = inferWaitingOn(messages);
  const last = lastNonSystem(messages);
  const nudges = buildNudges({ stage, waitingOn, analysis, counterpartName });
  const threadKey = deriveThreadKey({
    threadKey: input.threadKey,
    threadUrl: input.threadUrl,
    counterpartName,
    labeledTranscript,
  });

  return {
    ok: true,
    stage,
    stageLabel: CONVERSATION_STAGE_LABELS[stage],
    waitingOn,
    headline: buildHeadline(stage, waitingOn, counterpartName),
    nudges,
    labeledTranscript,
    counterpartName,
    threadKey,
    messageCount: messages.length,
    lastMessageRole: last?.role ?? null,
    lastMessagePreview: clean(last?.text ?? "", 160),
    analysis,
  };
}

export function lastMessageAtFrom(messages: ConversationMessage[], fallbackIso: string): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const sentAt = messages[i]?.sentAt;
    if (sentAt && !Number.isNaN(Date.parse(sentAt))) return new Date(sentAt).toISOString();
  }
  return fallbackIso;
}
