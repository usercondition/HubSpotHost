/**
 * Non-sensitive webhook diagnostics for deployment troubleshooting.
 * Never store signature values, request bodies, headers, or secrets.
 */
export interface WebhookDiagnostic {
  receivedAt: string;
  result: "accepted" | "rejected";
  version: "v1" | "v3" | null;
  reason: string;
}

let latest: WebhookDiagnostic | null = null;

export function recordWebhookDiagnostic(
  diagnostic: Omit<WebhookDiagnostic, "receivedAt">,
): WebhookDiagnostic {
  latest = { receivedAt: new Date().toISOString(), ...diagnostic };
  return latest;
}

export function getLatestWebhookDiagnostic(): WebhookDiagnostic | null {
  return latest;
}
