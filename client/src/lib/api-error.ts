/**
 * Parse errors thrown by `apiRequest` (`${status}: ${body}`).
 * Prefer the JSON `error` field when present.
 */
export function parseApiError(error: unknown): { status: number | null; message: string } {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const statusMatch = raw.match(/^(\d{3}):\s*/);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const body = statusMatch ? raw.slice(statusMatch[0].length) : raw;

  const jsonError = body.match(/"error"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  if (jsonError) {
    return { status, message: jsonError.replace(/\\"/g, '"') };
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return { status, message: parsed.error.trim() };
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return { status, message: parsed.message.trim() };
    }
  } catch {
    // not JSON
  }

  return { status, message: body.trim().slice(0, 220) || "Something went wrong" };
}

export function describeOwnerAuthError(error: unknown): string {
  const { status, message } = parseApiError(error);
  if (status === 401) {
    if (message.includes("does not match")) {
      return "The live server has a different owner code than the one entered.";
    }
    if (message.includes("No intake access code")) {
      return "Your browser did not deliver the owner code. Refresh and try again.";
    }
    return "Check the code and try again. Nothing was unlocked.";
  }
  if (status === 503) {
    return "Owner access is not configured on this service yet.";
  }
  return message.slice(0, 180);
}
