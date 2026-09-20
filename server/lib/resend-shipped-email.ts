/**
 * Resend transactional email — shipped notices after label attach / buy.
 * Requires RESEND_API_KEY + RESEND_FROM_EMAIL (verified domain or onboarding@resend.dev).
 */
import {
  buildShippingEmailPackage,
  type ShippingEmailTemplateInput,
} from "../../shared/shipping-email-template";

export type ResendSendResult =
  | { ok: true; id: string; skipped?: false }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

function envTrim(name: string): string {
  return String(process.env[name] ?? "").trim();
}

export function resendConfigured(): boolean {
  return Boolean(envTrim("RESEND_API_KEY") && envTrim("RESEND_FROM_EMAIL"));
}

export function getResendFromEmail(): string {
  return envTrim("RESEND_FROM_EMAIL");
}

/** Public origin for email images (hero/stamp). */
export function getShippingEmailAssetBaseUrl(): string {
  return envTrim("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

/**
 * Send one shipped email via Resend.
 * Caller must enforce idempotency (same deal+tracking only once).
 */
export async function sendShippedEmailViaResend(input: {
  to: string;
  contactName?: string | null;
  dealName?: string | null;
  trackingNumber: string;
  service?: string | null;
  carrier?: string | null;
}): Promise<ResendSendResult> {
  const apiKey = envTrim("RESEND_API_KEY");
  const from = envTrim("RESEND_FROM_EMAIL");
  const to = input.to.trim();
  if (!apiKey || !from) {
    return { ok: true, skipped: true, reason: "Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL)" };
  }
  if (!to.includes("@")) {
    return { ok: true, skipped: true, reason: "No buyer email on HubSpot contact" };
  }

  const packInput: ShippingEmailTemplateInput = {
    contactName: input.contactName,
    dealName: input.dealName,
    trackingNumber: input.trackingNumber,
    service: input.service,
    carrier: input.carrier,
    brand: {
      assetBaseUrl: getShippingEmailAssetBaseUrl(),
    },
  };
  const pack = buildShippingEmailPackage(packInput);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: pack.subject,
        html: pack.html,
        text: pack.text,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!response.ok) {
      const detail = body.message || body.name || `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, id: String(body.id ?? "") };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Resend request failed",
    };
  }
}
