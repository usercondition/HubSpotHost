/**
 * Normalize Messenger-like chat bubbles into plain text for paid-order analyze.
 * Used by the bridge tests and kept in sync with the Chrome extension formatter.
 */

export type MessengerBubble = {
  speaker: "you" | "buyer" | "unknown";
  text: string;
};

const NOISE_RE =
  /^(?:you sent|enter|delivery|reacted|liked a message|sent an attachment|today|yesterday|\d{1,2}:\d{2}\s*(?:am|pm)?)$/i;

export function cleanBubbleText(raw: string): string {
  return String(raw || "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoiseBubble(text: string): boolean {
  const cleaned = cleanBubbleText(text);
  if (!cleaned) return true;
  if (cleaned.length <= 2 && !/[a-z0-9]/i.test(cleaned)) return true;
  return NOISE_RE.test(cleaned);
}

export function formatMessengerThread(
  bubbles: MessengerBubble[],
  options?: { title?: string },
): string {
  const lines: string[] = [];
  const title = cleanBubbleText(options?.title || "");
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

export function guessSpeaker(label: string, outgoingHint?: boolean): MessengerBubble["speaker"] {
  if (outgoingHint === true) return "you";
  if (outgoingHint === false) return "buyer";
  const normalized = cleanBubbleText(label).toLowerCase();
  if (!normalized) return "unknown";
  if (/^(you|me|seller|shop)$/i.test(normalized)) return "you";
  return "buyer";
}
