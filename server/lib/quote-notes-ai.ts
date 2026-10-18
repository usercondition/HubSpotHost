/**
 * Optional AI fallback for Quote client notes the deterministic parser could
 * not read. Server side only: the key never reaches the browser.
 *
 * Reuses the existing OpenAI-compatible tracker assistant key
 * (TRACKER_ASSISTANT_API_KEY / XAI_API_KEY / OPENAI_API_KEY, optional
 * TRACKER_ASSISTANT_BASE_URL + TRACKER_ASSISTANT_MODEL, see .env.example).
 * Without a key the feature reports unavailable and nothing is called.
 *
 * Output is validated by validateAiChanges(): every chip must quote the note
 * verbatim and every number must appear in that quote. Chips come back as
 * "suggested", so nothing applies until the owner accepts it.
 */
import { validateAiChanges, type NoteChip } from "../../shared/quote-notes";

export type NotesAiConfig = { apiKey: string; baseUrl: string; model: string };

export function notesAiConfig(env: NodeJS.ProcessEnv): NotesAiConfig | null {
  const apiKey = (env.TRACKER_ASSISTANT_API_KEY || env.XAI_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const xaiOnly = !env.TRACKER_ASSISTANT_API_KEY?.trim() && !!env.XAI_API_KEY?.trim();
  const baseUrl = (env.TRACKER_ASSISTANT_BASE_URL?.trim() || (xaiOnly ? "https://api.x.ai/v1" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  const model = env.TRACKER_ASSISTANT_MODEL?.trim() || (/api\.x\.ai/.test(baseUrl) ? "grok-3-mini" : "gpt-4o-mini");
  return { apiKey, baseUrl, model };
}

export const NOTES_AI_SYSTEM_PROMPT = `You read a 3D print shop owner's client notes and extract ONLY explicit quote modifiers.
Return JSON: {"changes":[...]}. Each change has "field" and "source" (the exact words copied verbatim from the notes).
Fields:
- size: {"field":"size","mode":"height"|"width"|"depth"|"longest","value":number,"unit":"mm"|"cm"|"in"} or {"field":"size","value":number,"unit":"percent"}
- quantity: {"field":"quantity","value":integer}
- rush: {"field":"rush","on":true|false,"usd"?:number}
- baseMagnet: {"field":"baseMagnet","on":true|false,"usdEach"?:number}
- finishing (painting, priming, support cleanup): {"field":"finishing","on":true|false,"hours"?:number}
- hollow: {"field":"hollow","on":true|false}
- separatePackages: {"field":"separatePackages","on":true|false}
- custom fee: {"field":"custom","usd":number,"label":string}
Rules: never guess or compute numbers; every number must appear in "source". If nothing is explicit, return {"changes":[]}.`;

export type NotesAiResult = { ok: true; chips: NoteChip[]; model: string } | { ok: false; error: string; status: number };

export async function interpretNotesWithAi(
  notes: string,
  unparsed: string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<NotesAiResult> {
  const cfg = notesAiConfig(env);
  if (!cfg) return { ok: false, status: 503, error: "No AI key is configured on the server" };
  const pieces = unparsed.map((u) => String(u).trim()).filter(Boolean).slice(0, 10);
  const text = pieces.join("\n").slice(0, 1000);
  if (!text) return { ok: true, chips: [], model: cfg.model };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: NOTES_AI_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return { ok: false, status: 502, error: `AI request failed (HTTP ${res.status})` };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return { ok: false, status: 502, error: "AI reply was not JSON" };
    }
    // Validate against the text actually sent AND the full notes.
    const chips = validateAiChanges(parsed, text).filter((c) => notes.toLowerCase().includes(c.source.toLowerCase()));
    return { ok: true, chips, model: cfg.model };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, status: 504, error: aborted ? "AI request timed out" : "AI request failed" };
  } finally {
    clearTimeout(timer);
  }
}
