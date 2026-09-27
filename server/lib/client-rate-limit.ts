/**
 * Small in-memory throttle for public client routes.
 * The token space is large; this blunts automated probing.
 */
const clientAttempts = new Map<string, { count: number; resetAt: number }>();
const CLIENT_ATTEMPT_WINDOW_MS = 60_000;
const CLIENT_ATTEMPT_LIMIT = 40;

/** True when this IP has exceeded the public route limit. */
export function consumeClientAttempt(ip: string, now = Date.now()): boolean {
  const key = ip.trim() || "unknown";
  const entry = clientAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    clientAttempts.set(key, { count: 1, resetAt: now + CLIENT_ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > CLIENT_ATTEMPT_LIMIT;
}

export function resetClientAttemptLimits(): void {
  clientAttempts.clear();
}

export const CLIENT_ATTEMPT_LIMIT_PER_MINUTE = CLIENT_ATTEMPT_LIMIT;
