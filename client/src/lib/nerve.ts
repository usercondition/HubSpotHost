/**
 * Nerve section (feature flag, OFF by default).
 *
 * Enable at build time with VITE_NERVE_SECTION_ENABLED=true (Railway variable, needs a rebuild).
 * Data goes through the Print Ops server: GET /api/nerve/* (server/lib/nerve-proxy.ts) authenticated with
 * the normal Print Ops owner code. The server adds the Nerve key from its own env (NERVE_KEY); the
 * browser never asks for, holds, or stores a Nerve key. Read-only paths only.
 */
export const NERVE_SECTION_ENABLED = import.meta.env.VITE_NERVE_SECTION_ENABLED === "true";
/** Legacy storage names an older build might have used for a Nerve key. Removed on load; never written. */
const LEGACY_NERVE_STORAGE_KEYS = ["nerve-key", "nerveKey", "print-ops-nerve-key", "x-nerve-key"];
export function clearLegacyNerveKeyStorage() {
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    if (!store) continue;
    for (const k of LEGACY_NERVE_STORAGE_KEYS) {
      try {
        store.removeItem(k);
      } catch {
        /* blocked storage */
      }
    }
  }
}

export type NerveError = { kind: "locked" | "offline" | "error"; message: string };

/**
 * Read a Nerve path through the Print Ops server. ownerCode is the Print Ops key already in the owner
 * session. A Nerve-side failure is never reported as 401, so it can't lock the Print Ops session.
 */
export async function nerveGet<T>(path: string, ownerCode: string): Promise<T> {
  if (!ownerCode) throw { kind: "locked", message: "Unlock Print Ops to load Nerve." } satisfies NerveError;
  let res: Response;
  try {
    res = await fetch("/api/nerve" + path, {
      method: "GET",
      headers: { "x-paid-order-access-code": ownerCode },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw { kind: "offline", message: "Can't reach Print Ops. Check your connection and retry." } satisfies NerveError;
  }
  if (res.status === 401) throw { kind: "locked", message: "Print Ops key was not accepted." } satisfies NerveError;
  if (res.status === 502) throw { kind: "offline", message: "The server can't reach Nerve on the Mac mini right now." } satisfies NerveError;
  if (res.status === 503) throw { kind: "error", message: "Nerve is not configured on the server yet." } satisfies NerveError;
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
  agents: Array<{ name: string; role?: string; status: string; model?: string; adapter_type?: string; b?: number; s?: number; last_heartbeat_at?: string; paused_at?: string | null; planned?: boolean }>;
  needs?: Array<{ t: string; s?: string; st?: string }>;
  runs: NerveRun[];
  issues: NerveIssue[];
  runCounts: Array<{ agent: string; status: string; n: number }>;
  hc: Array<{ name: string; status: string; last_ping?: string }>;
  services: Array<{ name: string; what?: string; monitor?: string; state: string; red?: string }>;
  verdict: { systemRed: string[]; stale: string[]; unknown: string[]; needs: number };
  refresh?: { running: boolean; dataAgeMs: number; lastResult?: string; staleMin: number };
};

/* GET /api/messages and /api/messages/thread (read-only). Rendered by the Print Ops Inbox (Chats tab), not by Nerve. */
export type NerveThreadSummary = {
  uid: string; name: string; listing: string; when: string; at?: string | null; sortAt?: string | null; owes: boolean; handled: boolean;
  category: string; stage: string; last: string; lastSpeaker: string; archived: boolean; deleted: boolean; softDeleted?: boolean; source: string;
};
export type NerveThreadList = { updated: string; threads: NerveThreadSummary[] };
export type NerveMessage = {
  id: string; who: string; when: string; at: number; text: string; divider: boolean; dividerLabel: string;
  attachments?: Array<{ kind?: string; label?: string }>;
};
export type NerveThread = {
  uid: string; name: string; listing: string; stage: string; owes: boolean; summary: string; nextAction: string;
  messages: NerveMessage[]; total?: number; hasMore: boolean; updated: string; archived?: boolean; deleted?: boolean;
};
export type NerveRun = { id: string; agent: string; status: string; error_code?: string | null; err?: string; created_at: string; started_at?: string | null; finished_at?: string | null; issue?: string; title?: string };
export type NerveIssue = { identifier: string; title: string; status: string; agent: string; updated_at: string };
