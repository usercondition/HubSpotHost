/**
 * Daily follow-up reminder digest: one Telegram message listing open
 * follow-ups due today or overdue. Also retries Notion writes that failed.
 */
import { shopToday, type Followup } from "../../shared/inbox";
import { getMeta, listDueFollowups, listUnsyncedFollowups, setFollowupNotion, setInboxMeta } from "./inbox-cards-store";
import { writeFollowupToNotion } from "./notion-followups";
import { sendTelegramMessage, telegramConfigured } from "./telegram";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildFollowupDigest(due: Followup[], today: string, appUrl = ""): string | null {
  if (due.length === 0) return null;
  const lines = [`<b>Client follow-ups due (${due.length})</b>`];
  for (const f of due.slice(0, 25)) {
    const overdue = f.reminderDate && f.reminderDate < today ? ` · overdue since ${f.reminderDate}` : "";
    const listing = f.listing ? ` — ${escapeHtml(f.listing.slice(0, 60))}` : "";
    lines.push(`• <b>${escapeHtml(f.client)}</b>${listing}${overdue}\n  ↳ ${escapeHtml(f.nextAction || "follow up")}`);
  }
  if (due.length > 25) lines.push(`…and ${due.length - 25} more`);
  if (appUrl) lines.push(`\nOpen: ${escapeHtml(appUrl.replace(/\/$/, ""))}/#/inbox?tab=followups`);
  return lines.join("\n");
}

export type ReminderRunResult = {
  today: string;
  due: number;
  sent: boolean;
  skipped?: string;
  notionRetried: number;
  notionFailed: number;
  error?: string;
};

export async function runFollowupReminders(
  opts: { force?: boolean; now?: Date; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<ReminderRunResult> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const today = shopToday(opts.now ?? new Date());

  let notionRetried = 0;
  let notionFailed = 0;
  for (const f of listUnsyncedFollowups()) {
    const r = await writeFollowupToNotion(f, env, fetchImpl);
    notionRetried += 1;
    if (r.ok) setFollowupNotion(f.id, { pageId: r.pageId, url: r.url, error: null });
    else {
      notionFailed += 1;
      setFollowupNotion(f.id, { error: r.error });
    }
  }

  const due = listDueFollowups(today);
  const base = { today, due: due.length, notionRetried, notionFailed };
  if (!opts.force && getMeta("followup_digest_sent_on") === today) return { ...base, sent: false, skipped: "already sent today" };
  const message = buildFollowupDigest(due, today, env.PUBLIC_BASE_URL?.trim() || "");
  if (!message) return { ...base, sent: false, skipped: "nothing due" };
  if (!telegramConfigured(env)) return { ...base, sent: false, skipped: "telegram not configured" };
  const sent = await sendTelegramMessage(message, env, fetchImpl, { parseMode: "HTML" });
  if (!sent.ok) return { ...base, sent: false, error: sent.error };
  setInboxMeta("followup_digest_sent_on", today);
  return { ...base, sent: true };
}
