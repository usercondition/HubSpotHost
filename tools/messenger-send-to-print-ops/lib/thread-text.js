/**
 * Pure helpers for the Chrome extension (kept parallel to server/lib/messenger-thread-text.ts).
 */
export function cleanBubbleText(raw) {
  return String(raw || "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE_RE =
  /^(?:you sent|enter|delivery|reacted|liked a message|sent an attachment|today|yesterday|\d{1,2}:\d{2}\s*(?:am|pm)?)$/i;

export function isNoiseBubble(text) {
  const cleaned = cleanBubbleText(text);
  if (!cleaned) return true;
  if (cleaned.length <= 2 && !/[a-z0-9]/i.test(cleaned)) return true;
  return NOISE_RE.test(cleaned);
}

export function formatMessengerThread(bubbles, options = {}) {
  const lines = [];
  const title = cleanBubbleText(options.title || "");
  if (title) lines.push(`Thread: ${title}`);

  for (const bubble of bubbles) {
    const text = cleanBubbleText(bubble.text);
    if (isNoiseBubble(text)) continue;
    const label =
      bubble.speaker === "you" ? "You" : bubble.speaker === "buyer" ? "Buyer" : "Message";
    lines.push(`${label}: ${text}`);
  }
  return lines.join("\n").trim();
}

export function guessSpeaker(label, outgoingHint) {
  if (outgoingHint === true) return "you";
  if (outgoingHint === false) return "buyer";
  const normalized = cleanBubbleText(label).toLowerCase();
  if (!normalized) return "unknown";
  if (/^(you|me|seller|shop)$/i.test(normalized)) return "you";
  return "buyer";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
