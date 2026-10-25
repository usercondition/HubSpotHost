/**
 * Gmail-first ingest for eBay, Etsy, and MyMiniFactory buyer mail.
 *
 * Print Ops does not read Gmail itself. A watcher (or a later cron) searches
 * the shop mailbox and POSTs the matching messages to `/api/inbox/ingest`
 * with the inbox push token. Queries below match notification shapes already
 * seen on streetsofmerchant@gmail.com. Listing confirmations and promo mail
 * are not chats. This module never invents message text.
 */
import type { InboxCard, InboxMessage, SellerInboxChannel } from "./inbox";
import { sellerInboxChannel } from "./inbox";

export const SELLER_MAIL_QUERIES: Record<SellerInboxChannel, string> = {
  ebay: 'from:members.ebay subject:"sent a message" newer_than:14d',
  etsy: 'from:(conversations@mail.etsy.com OR no-reply@account.etsy.com) subject:"Etsy Conversation" newer_than:14d',
  myminifactory: 'from:no-reply@myminifactory.com subject:"You have a new message" newer_than:14d',
};

export type SellerMailInput = {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  text?: string;
  date?: string;
  channel?: string;
  buyer?: string;
  listing?: string;
  listingUrl?: string;
};

function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim().toLowerCase();
}

function cleanMailText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function httpsUrl(value: string | undefined): string {
  const s = (value ?? "").trim();
  return /^https:\/\//i.test(s) ? s.slice(0, 1000) : "";
}

/** Buyer-message notifications only. Listing, promo, security, and Facebook mail return null. */
export function classifySellerMail(input: { from?: string; subject?: string }): SellerInboxChannel | null {
  const from = input.from ?? "";
  const subject = input.subject ?? "";
  const addr = addressOf(from);
  if (/@members\.ebay\./i.test(addr) && /sent a message/i.test(subject) && !/has been listed/i.test(subject)) return "ebay";
  if (
    /^(conversations@mail\.etsy\.com|no-reply@account\.etsy\.com)$/i.test(addr) &&
    /etsy conversation|unread message/i.test(subject)
  ) {
    return "etsy";
  }
  if (/^no-reply@myminifactory\.com$/i.test(addr) && /^you have a new message$/i.test(subject.trim())) return "myminifactory";
  return null;
}

function ebayBuyer(from: string): string {
  return from.match(/eBay\s*-\s*([^<]+)/i)?.[1]?.trim().slice(0, 160) || "";
}

function ebayListing(subject: string): string {
  return subject.match(/sent a message about\s+(.+?)(?:\s+#\d{6,})?\s*$/i)?.[1]?.trim().slice(0, 300) || "";
}

function etsyBuyer(subject: string): string {
  return subject.match(/Etsy Conversation with\s+(.+?)(?:\s+from\s+|\s+about\s+|$)/i)?.[1]?.trim().slice(0, 160) || "";
}

function etsyListing(subject: string): string {
  const shop = subject.match(/\bfrom\s+(.+?)(?:\s+about\b|$)/i)?.[1]?.trim();
  const order = subject.match(/\bOrder\s+#\d+/i)?.[0];
  return [shop, order].filter(Boolean).join(" · ").slice(0, 300);
}

function cardId(channel: SellerInboxChannel, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
  return `gmail.${channel}.${safe || "message"}`;
}

function pausedChannel(value: string | undefined): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return false;
  return !sellerInboxChannel(raw) && /facebook|messenger|marketplace/i.test(raw);
}

/**
 * Turn a watcher batch into inbox cards. Unclassified mail is counted in
 * `skipped` and dropped. Messages that share a Gmail thread become one card.
 */
export function normalizeSellerMailBatch(messages: readonly SellerMailInput[]): { cards: InboxCard[]; skipped: number } {
  const groups = new Map<string, { channel: SellerInboxChannel; items: Array<SellerMailInput & { text: string; at: string | null }> }>();
  let skipped = 0;
  for (const raw of messages) {
    if (pausedChannel(raw.channel)) {
      skipped += 1;
      continue;
    }
    const channel = sellerInboxChannel(raw.channel ?? "") ?? classifySellerMail(raw);
    const text = cleanMailText(raw.text || raw.snippet || raw.subject || "");
    if (!channel || !raw.id?.trim() || !text) {
      skipped += 1;
      continue;
    }
    const at = raw.date?.trim().slice(0, 40) || null;
    const key = `${channel}:${(raw.threadId || raw.id).trim()}`;
    const group = groups.get(key) ?? { channel, items: [] };
    group.items.push({ ...raw, text, at });
    groups.set(key, group);
  }

  const cards: InboxCard[] = [];
  for (const group of groups.values()) {
    const items = [...group.items].sort((a, b) => (a.at && b.at && a.at !== b.at ? (a.at < b.at ? -1 : 1) : 0));
    const seen = new Set<string>();
    const history: InboxMessage[] = [];
    for (const item of items) {
      const key = `buyer|${item.at ?? ""}|${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      history.push({ who: "buyer", when: "", at: item.at, text: item.text });
    }
    const last = history[history.length - 1];
    const first = items[0];
    const subject = first.subject ?? "";
    const from = first.from ?? "";
    const name =
      items.map((i) => i.buyer?.trim()).find(Boolean) ||
      (group.channel === "ebay" ? ebayBuyer(from) : group.channel === "etsy" ? etsyBuyer(subject) : "") ||
      "Buyer";
    const listing =
      items.map((i) => i.listing?.trim()).find(Boolean) ||
      (group.channel === "ebay" ? ebayListing(subject) : group.channel === "etsy" ? etsyListing(subject) : "");
    const threadKey = (first.threadId || first.id).trim();
    cards.push({
      id: cardId(group.channel, threadKey),
      source: group.channel,
      name: name.slice(0, 160),
      listing: listing.slice(0, 300),
      listingUrl: httpsUrl(items.map((i) => i.listingUrl).find(Boolean)),
      lastMessage: last?.text ?? "",
      lastMessageAt: last?.at ?? null,
      timeLabel: "",
      lastSpeaker: "buyer",
      owesReply: true,
      needsYou: true,
      category: "question",
      stage: "",
      nextAction: "",
      suggestedReply: "",
      threadUrl: "",
      threadHint: "Gmail notification. Sending from Print Ops is off.",
      risk: null,
      recent: history.slice(-8),
      history,
      analysis: null,
      firstSeen: history[0]?.at ?? null,
      lastScraped: last?.at ?? null,
      notInLatestRead: false,
      lastSeenInList: last?.at ?? null,
    });
  }
  return { cards, skipped };
}
