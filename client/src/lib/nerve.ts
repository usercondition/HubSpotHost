/**
 * Nerve section (feature flag, OFF by default).
 *
 * Enable at build time with VITE_NERVE_SECTION_ENABLED=true (Railway variable, needs a rebuild).
 * Data never passes through this server: the browser fetches the Mac mini's Nerve v3 API over
 * Tailscale (option A in ~/nerve-center/docs/plan-nerve-printops-merge-20261017.md). Off the tailnet
 * the section shows a "Connect Tailscale" state and the rest of Print Ops is unaffected.
 *
 * Auth: the Nerve key is typed in by the owner and held in page memory only (never storage, cookies,
 * the bundle, or Railway). Sent as header x-nerve-key. Nerve v3 only allows this origin to GET
 * read-only paths; every write (send, archive, delete) stays on the Mac mini under the FB lock.
 */
export const NERVE_SECTION_ENABLED = import.meta.env.VITE_NERVE_SECTION_ENABLED === "true";
export const NERVE_API_BASE: string =
  (import.meta.env.VITE_NERVE_API_BASE as string | undefined) || "https://miguels-mac-mini.tailc0d52c.ts.net/nerve";

let nerveKey: string | null = null;
const listeners = new Set<() => void>();
export function getNerveKey() {
  return nerveKey;
}
export function setNerveKey(k: string | null) {
  nerveKey = k && k.trim() ? k.trim() : null;
  listeners.forEach((fn) => fn());
}
export function onNerveKeyChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export type NerveError = { kind: "locked" | "offline" | "error"; message: string };

export async function nerveGet<T>(path: string): Promise<T> {
  if (!nerveKey) throw { kind: "locked", message: "Enter the Nerve key to load this section." } satisfies NerveError;
  let res: Response;
  try {
    res = await fetch(NERVE_API_BASE + path, {
      method: "GET",
      headers: { "x-nerve-key": nerveKey },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw { kind: "offline", message: "Can't reach the Mac mini. Connect Tailscale on this device and retry." } satisfies NerveError;
  }
  if (res.status === 401) {
    setNerveKey(null);
    throw { kind: "locked", message: "Nerve key was not accepted." } satisfies NerveError;
  }
  if (!res.ok) throw { kind: "error", message: `Nerve answered ${res.status}.` } satisfies NerveError;
  return (await res.json()) as T;
}

/* Subset of GET /api/v3 used here. Titles, states and counts only; no buyer text is rendered. */
export type NerveTile = { id: string; title: string; state: string; value?: string; asOf?: string; ageS?: number; maxAgeS?: number; source?: string };
export type NerveModel = {
  ok: boolean;
  at: string;
  glance: {
    status: { red: string[]; stale: string[]; unknown: string[]; allClear: boolean; oldest?: { title: string; ageS: number } };
    sections: Array<{ id: string; title: string; tiles: NerveTile[] }>;
  };
  agents: Array<{ name: string; role?: string; status: string; model?: string; last_heartbeat_at?: string; paused_at?: string | null }>;
  runs: NerveRun[];
  issues: NerveIssue[];
  runCounts: Array<{ agent: string; status: string; n: number }>;
  hc: Array<{ name: string; status: string; last_ping?: string }>;
  services: Array<{ name: string; what?: string; monitor?: string; state: string; red?: string }>;
  verdict: { systemRed: string[]; stale: string[]; unknown: string[]; needs: number };
  refresh?: { running: boolean; dataAgeMs: number; lastResult?: string; staleMin: number };
};

/* GET /api/messages and /api/messages/thread (read-only). */
export type NerveThreadSummary = {
  uid: string; name: string; listing: string; when: string; owes: boolean; handled: boolean;
  category: string; stage: string; last: string; lastSpeaker: string; archived: boolean; deleted: boolean; source: string;
};
export type NerveThreadList = { updated: string; threads: NerveThreadSummary[] };
export type NerveMessage = { id: string; who: string; when: string; at: number; text: string; divider: boolean; dividerLabel: string };
export type NerveThread = {
  uid: string; name: string; listing: string; stage: string; owes: boolean; summary: string; nextAction: string;
  messages: NerveMessage[]; total: number; hasMore: boolean; updated: string;
};
export type NerveRun = { id: string; agent: string; status: string; error_code?: string | null; created_at: string; finished_at?: string | null; issue?: string; title?: string };
export type NerveIssue = { identifier: string; title: string; status: string; agent: string; updated_at: string };
