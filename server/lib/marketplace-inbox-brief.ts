/**
 * Marketplace inbox “secretary” brief.
 *
 * Takes scanned threads (from the Chrome helper or paste) and produces a
 * morning-style briefing: who needs a reply, who’s ready to book, who’s stale,
 * and concrete next actions + optional reply drafts.
 *
 * Deterministic rules only for V1 — no HubSpot writes, no auto-send to buyers.
 */
import { analyzeMarketplaceConversation } from "./intake";

export type MarketplaceThreadInput = {
  /** Stable-ish id from the scanner (href, list index, etc.). */
  id?: string;
  title: string;
  conversation: string;
  unread?: boolean;
  /** ISO or display string if the scanner captured it. */
  lastActivityAt?: string | null;
};

export type MarketplaceThreadStatus =
  | "your_turn"
  | "awaiting_payment"
  | "paid_needs_details"
  | "ready_to_book"
  | "waiting_on_buyer"
  | "stale"
  | "done"
  | "unclear";

export type MarketplaceBriefAction = {
  id: string;
  label: string;
  href?: string;
  kind: "reply" | "ops" | "info";
};

export type MarketplaceThreadBrief = {
  id: string;
  title: string;
  unread: boolean;
  status: MarketplaceThreadStatus;
  statusLabel: string;
  priority: number;
  why: string[];
  nextActions: MarketplaceBriefAction[];
  draftReply: string | null;
  signals: {
    paymentLanguageDetected: boolean;
    hasAmount: boolean;
    hasAddress: boolean;
    hasEmail: boolean;
    lastSpeaker: "you" | "buyer" | "unknown";
    preview: string;
  };
};

export type MarketplaceInboxBrief = {
  generatedAt: string;
  threadCount: number;
  headline: string;
  doFirst: MarketplaceThreadBrief[];
  then: MarketplaceThreadBrief[];
  waiting: MarketplaceThreadBrief[];
  threads: MarketplaceThreadBrief[];
};

const STALE_HINT_RE =
  /\b(?:last week|few days ago|days ago|a week ago|no response|still waiting|bump|following up)\b/i;
const DONE_RE =
  /\b(?:tracking\s*(?:number|#|is)|package (?:was )?delivered|received the package|order complete|all done|thanks again|got the package)\b/i;
const PRICE_ASK_RE =
  /\b(?:how much|what(?:'s| is) (?:your )?price|quote|do you (?:still )?print|interested in|looking for|shipped to)\b/i;
const WAITING_BUYER_RE =
  /\b(?:let me know|when you(?:'re| are) ready|send (?:me )?(?:the )?(?:address|payment|paypal)|whenever you(?:'re| are) ready)\b/i;

function clean(value: string, limit = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function linesOf(conversation: string): string[] {
  return conversation
    .split(/\r?\n/)
    .map((line) => clean(line, 500))
    .filter(Boolean);
}

function lastSpeaker(lines: string[]): "you" | "buyer" | "unknown" {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/^you\s*:/i.test(line)) return "you";
    if (/^buyer\s*:/i.test(line) || /^message\s*:/i.test(line)) return "buyer";
  }
  return "unknown";
}

function previewFrom(lines: string[]): string {
  const content = lines.filter((line) => !/^thread\s*:/i.test(line));
  return clean(content.slice(-3).join(" · ") || content[0] || "", 180);
}

function statusLabel(status: MarketplaceThreadStatus): string {
  switch (status) {
    case "your_turn":
      return "Your turn to reply";
    case "awaiting_payment":
      return "Waiting on payment";
    case "paid_needs_details":
      return "Paid — need shipping details";
    case "ready_to_book":
      return "Ready to book in Print Ops";
    case "waiting_on_buyer":
      return "Waiting on buyer";
    case "stale":
      return "Stale — consider a nudge";
    case "done":
      return "Looks finished";
    default:
      return "Needs a human look";
  }
}

function draftFor(status: MarketplaceThreadStatus, title: string): string | null {
  const name = clean(title.replace(/\(.*?\)/g, ""), 40) || "there";
  switch (status) {
    case "your_turn":
      return `Hi ${name} — thanks for the message. I can help with that print. What size/model did you want, and are you local pickup or shipping?`;
    case "awaiting_payment":
      return `Hi ${name} — whenever you’re ready I can hold the spot. PayPal works; once it lands I’ll confirm and get your shipping address.`;
    case "paid_needs_details":
      return `Payment received — thank you! Please send the full shipping name + street address, city, state, and ZIP so I can start the plate.`;
    case "ready_to_book":
      return `All set on my side — I’ll book this into production and update you when the plate is running.`;
    case "stale":
      return `Hi ${name} — just checking in. Still interested in the print we talked about? Happy to hold or adjust if you need.`;
    case "waiting_on_buyer":
      return null;
    default:
      return null;
  }
}

function classifyThread(input: MarketplaceThreadInput, index: number): MarketplaceThreadBrief {
  const title = clean(input.title || `Thread ${index + 1}`, 120) || `Thread ${index + 1}`;
  const conversation = String(input.conversation || "").trim().slice(0, 40_000);
  const lines = linesOf(conversation);
  const analysis = analyzeMarketplaceConversation(conversation.length >= 20 ? conversation : `${title}\n${conversation}`);
  const speaker = lastSpeaker(lines);
  const unpaidNegation = /\b(?:not paid|haven'?t paid|will pay|can pay|payment pending)\b/i.test(conversation);
  const paid = analysis.paymentLanguageDetected && !unpaidNegation;
  const hasAmount = Boolean(analysis.amount);
  const hasAddress = Boolean(analysis.address);
  const hasEmail = Boolean(analysis.email);
  const looksDone = DONE_RE.test(conversation);
  const staleHint = STALE_HINT_RE.test(conversation) || Boolean(input.lastActivityAt && /day|week/i.test(input.lastActivityAt));
  const priceAsk = PRICE_ASK_RE.test(conversation);
  const youAskedThem = WAITING_BUYER_RE.test(conversation) && speaker === "you";

  let status: MarketplaceThreadStatus = "unclear";
  const why: string[] = [];

  if (looksDone && !priceAsk && (speaker === "buyer" || /tracking|delivered|package/i.test(conversation))) {
    status = "done";
    why.push("Shipping / completion language found.");
  } else if (paid && hasAddress) {
    status = "ready_to_book";
    why.push("Payment language + shipping address detected.");
    if (hasAmount) why.push(`Amount signal: $${analysis.amount}.`);
  } else if (paid && !hasAddress) {
    status = "paid_needs_details";
    why.push("Payment language detected, but no shipping address yet.");
  } else if (!paid && (hasAmount || /\bpaypal|venmo|zelle|invoice\b/i.test(conversation)) && speaker === "you") {
    status = "awaiting_payment";
    why.push("Price/payment path discussed; ball seems with the buyer.");
  } else if (speaker === "buyer" || input.unread) {
    status = "your_turn";
    why.push(input.unread ? "Marked unread in the inbox." : "Buyer appears to have sent the last message.");
    if (priceAsk) why.push("Looks like an inquiry / price ask.");
  } else if (youAskedThem || speaker === "you") {
    status = staleHint ? "stale" : "waiting_on_buyer";
    why.push(staleHint ? "You last wrote, and the thread looks cold." : "You last wrote — waiting on the buyer.");
  } else if (staleHint) {
    status = "stale";
    why.push("Stale / bump language detected.");
  } else {
    status = "unclear";
    why.push("Couldn’t confidently classify — skim this one.");
  }

  const nextActions: MarketplaceBriefAction[] = [];
  if (status === "your_turn" || status === "stale" || status === "paid_needs_details" || status === "awaiting_payment") {
    nextActions.push({ id: "reply", label: "Reply in Messenger", kind: "reply" });
  }
  if (status === "ready_to_book" || status === "paid_needs_details") {
    nextActions.push({
      id: "manual",
      label: "Open Manual entry",
      href: "/paid-orders",
      kind: "ops",
    });
  }
  if (status === "awaiting_payment" || status === "your_turn") {
    nextActions.push({
      id: "intake",
      label: "Send / open Intake link",
      href: "/orders",
      kind: "ops",
    });
  }
  if (status === "unclear") {
    nextActions.push({ id: "review", label: "Review thread", kind: "info" });
  }

  const priority =
    status === "your_turn"
      ? 100
      : status === "paid_needs_details"
        ? 90
        : status === "ready_to_book"
          ? 85
          : status === "awaiting_payment"
            ? 70
            : status === "stale"
              ? 60
              : status === "waiting_on_buyer"
                ? 40
                : status === "done"
                  ? 10
                  : 30;

  return {
    id: clean(input.id || `${index}-${title}`, 160) || `thread-${index}`,
    title,
    unread: Boolean(input.unread),
    status,
    statusLabel: statusLabel(status),
    priority: input.unread ? priority + 8 : priority,
    why,
    nextActions,
    draftReply: draftFor(status, title),
    signals: {
      paymentLanguageDetected: paid,
      hasAmount,
      hasAddress,
      hasEmail,
      lastSpeaker: speaker,
      preview: previewFrom(lines),
    },
  };
}

export function buildMarketplaceInboxBrief(threads: MarketplaceThreadInput[]): MarketplaceInboxBrief {
  const classified = threads
    .filter((thread) => clean(thread.conversation || thread.title || "").length >= 8)
    .map((thread, index) => classifyThread(thread, index))
    .sort((a, b) => b.priority - a.priority);

  const doFirst = classified.filter((t) =>
    ["your_turn", "paid_needs_details", "ready_to_book"].includes(t.status),
  );
  const then = classified.filter((t) => ["awaiting_payment", "stale"].includes(t.status));
  const waiting = classified.filter((t) => ["waiting_on_buyer", "done", "unclear"].includes(t.status));

  const counts = {
    yourTurn: classified.filter((t) => t.status === "your_turn").length,
    ready: classified.filter((t) => t.status === "ready_to_book" || t.status === "paid_needs_details").length,
    waitingPay: classified.filter((t) => t.status === "awaiting_payment").length,
    stale: classified.filter((t) => t.status === "stale").length,
  };

  const parts = [
    counts.yourTurn ? `${counts.yourTurn} need your reply` : "",
    counts.ready ? `${counts.ready} ready to book / need details` : "",
    counts.waitingPay ? `${counts.waitingPay} waiting on payment` : "",
    counts.stale ? `${counts.stale} stale` : "",
  ].filter(Boolean);

  const headline =
    classified.length === 0
      ? "No Marketplace threads were scanned."
      : parts.length
        ? `Secretary brief: ${parts.join(", ")}.`
        : `Secretary brief: reviewed ${classified.length} thread${classified.length === 1 ? "" : "s"} — nothing urgent.`;

  return {
    generatedAt: new Date().toISOString(),
    threadCount: classified.length,
    headline,
    doFirst,
    then,
    waiting,
    threads: classified,
  };
}
