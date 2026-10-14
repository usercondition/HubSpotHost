/**
 * Minimal Notion REST client for the "Client Follow-ups" database.
 * Configured with NOTION_TOKEN (internal integration secret, shared with the
 * database) and NOTION_FOLLOWUPS_DB_ID. Never logs or returns the token.
 */
import type { Followup } from "../../shared/inbox";

const NOTION_VERSION = "2022-06-28";

export type NotionConfig = { token: string; databaseId: string };

export function getNotionFollowupsConfig(env: NodeJS.ProcessEnv = process.env): NotionConfig | null {
  const token = env.NOTION_TOKEN?.trim() || "";
  const databaseId = (env.NOTION_FOLLOWUPS_DB_ID?.trim() || "").replace(/-/g, "");
  if (!token || !/^[0-9a-f]{32}$/i.test(databaseId)) return null;
  return { token, databaseId };
}

function text(value: string) {
  const content = value.slice(0, 1900);
  return { rich_text: content ? [{ type: "text", text: { content } }] : [] };
}
function url(value: string) {
  return { url: value || null };
}
const STATUS_LABEL: Record<Followup["status"], string> = { open: "Open", done: "Done", snoozed: "Snoozed" };

export function followupToNotionProperties(f: Followup): Record<string, unknown> {
  const title = [f.client, f.listing].filter(Boolean).join(" – ").slice(0, 200) || "Follow-up";
  return {
    Name: { title: [{ type: "text", text: { content: title } }] },
    Client: text(f.client),
    Listing: text(f.listing),
    "Listing URL": url(f.listingUrl),
    Channel: { select: { name: f.channel } },
    "What was said": text(f.said),
    "Next action": text(f.nextAction),
    Reminder: { date: f.reminderDate ? { start: f.reminderDate } : null },
    Status: { select: { name: STATUS_LABEL[f.status] } },
    Outcome: { select: { name: f.outcome === "handled" ? "Handled" : "Replied" } },
    Stage: text(f.stage),
    "HubSpot deal": url(f.hubspotUrl),
    "Card ID": text(f.cardId ?? ""),
  };
}

export type NotionWriteResult = { ok: true; pageId: string; url: string | null } | { ok: false; error: string };

async function call(
  config: NotionConfig,
  method: "POST" | "PATCH",
  pathName: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<NotionWriteResult> {
  try {
    const res = await fetchImpl(`https://api.notion.com/v1/${pathName}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; url?: string; message?: string };
    if (!res.ok || !json.id) return { ok: false, error: `Notion ${res.status}: ${json.message || res.statusText}`.slice(0, 300) };
    return { ok: true, pageId: json.id, url: json.url ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Notion request failed" };
  }
}

export async function writeFollowupToNotion(
  f: Followup,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionWriteResult> {
  const config = getNotionFollowupsConfig(env);
  if (!config) return { ok: false, error: "Notion is not configured (NOTION_TOKEN / NOTION_FOLLOWUPS_DB_ID)" };
  const properties = followupToNotionProperties(f);
  if (f.notionPageId) return call(config, "PATCH", `pages/${f.notionPageId}`, { properties }, fetchImpl);
  return call(config, "POST", "pages", { parent: { database_id: config.databaseId }, properties }, fetchImpl);
}
