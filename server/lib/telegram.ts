/**
 * Minimal Telegram Bot API helper for owner digests / health nudges.
 * Credentials stay in env — never logged.
 */

export type TelegramConfig = {
  token: string;
  chatId: string;
};

export type TelegramSendResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string; status?: number };

export type TelegramInlineButton = {
  text: string;
  url: string;
};

export type TelegramSendOptions = {
  /** Default HTML so digests can use <a href> instead of raw URLs. */
  parseMode?: "HTML" | "MarkdownV2";
  /** Optional URL button rows (max ~8 per row; keep short labels). */
  inlineKeyboard?: TelegramInlineButton[][];
  fetchImpl?: typeof fetch;
};

export function getTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || "";
  if (!token || !chatId) return null;
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return null;
  if (!/^-?\d+$/.test(chatId)) return null;
  return { token, chatId };
}

export function telegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getTelegramConfig(env) !== null;
}

/** Escape text for Telegram HTML parse_mode. */
export function escapeTelegramHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Compact HTML anchor — label only shows in chat, full URL stays in the href. */
export function telegramHtmlLink(label: string, href: string): string {
  const safeHref = String(href ?? "").replace(/"/g, "%22");
  return `<a href="${safeHref}">${escapeTelegramHtml(label)}</a>`;
}

export async function sendTelegramMessage(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  options: TelegramSendOptions = {},
): Promise<TelegramSendResult> {
  const config = getTelegramConfig(env);
  if (!config) {
    return { ok: false, error: "Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)" };
  }

  const body = text.trim();
  if (!body) return { ok: false, error: "Message text is empty" };
  // Telegram hard limit is 4096 characters.
  const clipped = body.length > 4000 ? `${body.slice(0, 3990)}\n…` : body;
  const parseMode = options.parseMode ?? "HTML";
  const fetchImpl = options.fetchImpl ?? fetch;

  const payloadBody: Record<string, unknown> = {
    chat_id: config.chatId,
    text: clipped,
    disable_web_page_preview: true,
    parse_mode: parseMode,
  };

  if (options.inlineKeyboard && options.inlineKeyboard.length > 0) {
    payloadBody.reply_markup = {
      inline_keyboard: options.inlineKeyboard.map((row) =>
        row.map((button) => ({ text: button.text, url: button.url })),
      ),
    };
  }

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadBody),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;

    if (!response.ok || !payload?.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.description || `Telegram send failed (${response.status})`,
      };
    }

    return { ok: true, messageId: Number(payload.result?.message_id) || 0 };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Telegram request failed",
    };
  }
}
