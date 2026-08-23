/**
 * Professional shipped-order email template for Labels.
 * Stored here so a future sender (Resend / HubSpot / Gmail) can reuse the same HTML.
 * Configure brand defaults below — no live send from Print Ops yet.
 */

export type ShippingEmailBrandConfig = {
  /** Shop / brand shown in the email header. */
  shopName: string;
  /** Short tagline under the shop name. */
  tagline: string;
  /** Accent color (hex) for header bar + CTA. */
  accentHex: string;
  /** Optional support line shown in the footer. */
  supportLine: string;
  /** Reply-to / from display when you wire a real sender later. */
  fromDisplayName: string;
};

/** Defaults — tweak later when you add a sending address. */
export const SHIPPING_EMAIL_BRAND: ShippingEmailBrandConfig = {
  shopName: "Print Ops",
  tagline: "Your order is on the way",
  accentHex: "#C47A3A",
  supportLine: "Questions? Just reply to this email.",
  fromDisplayName: "Print Ops Shipping",
};

export type ShippingEmailTemplateInput = {
  contactName?: string | null;
  dealName?: string | null;
  trackingNumber: string;
  service?: string | null;
  carrier?: string | null;
  brand?: Partial<ShippingEmailBrandConfig>;
};

function firstNameFrom(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return "there";
  const first = cleaned.split(/\s+/)[0] ?? "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveWho(input: ShippingEmailTemplateInput): string {
  if (input.contactName && firstNameFrom(input.contactName) !== "there") {
    return firstNameFrom(input.contactName);
  }
  if (input.dealName?.includes(" - ")) {
    return firstNameFrom(input.dealName.slice(input.dealName.lastIndexOf(" - ") + 3));
  }
  return "there";
}

function serviceLabel(input: ShippingEmailTemplateInput): string | null {
  return input.service || input.carrier || null;
}

export function buildShippingEmailSubject(input: ShippingEmailTemplateInput): string {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  const deal = String(input.dealName ?? "").trim();
  if (deal) return `${brand.shopName}: your order shipped — ${deal.slice(0, 72)}`;
  return `${brand.shopName}: your print order shipped`;
}

/** Plain-text body for mailto / Marketplace-adjacent paste. */
export function buildShippingEmailText(input: ShippingEmailTemplateInput): string {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  const who = resolveWho(input);
  const service = serviceLabel(input);
  const lines = [
    `Hi ${who},`,
    "",
    "Great news — your print order has shipped.",
    "",
    service ? `Carrier / service: ${service}` : null,
    `Tracking number: ${input.trackingNumber}`,
    input.dealName ? `Order: ${input.dealName}` : null,
    "",
    brand.supportLine,
    "",
    `— ${brand.fromDisplayName}`,
  ].filter((line): line is string => line != null);
  return lines.join("\n");
}

/**
 * Table-based HTML email (works in Gmail / Apple Mail / Outlook).
 * Inline styles only — safe for future transactional senders.
 */
export function buildShippingEmailHtml(input: ShippingEmailTemplateInput): string {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  const who = escapeHtml(resolveWho(input));
  const tracking = escapeHtml(input.trackingNumber);
  const service = serviceLabel(input);
  const serviceSafe = service ? escapeHtml(service) : null;
  const dealSafe = input.dealName ? escapeHtml(input.dealName) : null;
  const shop = escapeHtml(brand.shopName);
  const tagline = escapeHtml(brand.tagline);
  const support = escapeHtml(brand.supportLine);
  const fromName = escapeHtml(brand.fromDisplayName);
  const accent = brand.accentHex;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(buildShippingEmailSubject(input))}</title>
</head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Georgia,'Times New Roman',serif;color:#1c1917;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ec;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e7e0d6;">
          <tr>
            <td style="background:${accent};padding:22px 28px;">
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.85);font-weight:700;">${shop}</div>
              <div style="margin-top:8px;font-size:26px;line-height:1.25;color:#ffffff;font-weight:700;">${tagline}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 14px;font-size:17px;line-height:1.5;">Hi ${who},</p>
              <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#44403c;">
                Your print order is packed and on the way. Here’s everything you need to track it.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf7f2;border:1px solid #ebe4da;border-radius:10px;">
                <tr>
                  <td style="padding:18px 20px;font-family:Arial,Helvetica,sans-serif;">
                    ${
                      serviceSafe
                        ? `<div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#78716c;font-weight:700;">Service</div>
                    <div style="margin:4px 0 14px;font-size:15px;color:#1c1917;">${serviceSafe}</div>`
                        : ""
                    }
                    <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#78716c;font-weight:700;">Tracking</div>
                    <div style="margin:4px 0 0;font-size:18px;font-weight:700;letter-spacing:0.02em;color:#1c1917;">${tracking}</div>
                    ${
                      dealSafe
                        ? `<div style="margin-top:14px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#78716c;font-weight:700;">Order</div>
                    <div style="margin:4px 0 0;font-size:14px;color:#44403c;">${dealSafe}</div>`
                        : ""
                    }
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 0;font-size:15px;line-height:1.55;color:#44403c;">${support}</p>
              <p style="margin:18px 0 0;font-size:15px;color:#1c1917;">— ${fromName}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 20px;border-top:1px solid #ebe4da;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.45;color:#a8a29e;">
              Sent from ${shop}. This template is ready for a future email sender — Marketplace copy stays separate.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildShippingEmailPackage(input: ShippingEmailTemplateInput): {
  subject: string;
  text: string;
  html: string;
  brand: ShippingEmailBrandConfig;
} {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  return {
    subject: buildShippingEmailSubject(input),
    text: buildShippingEmailText(input),
    html: buildShippingEmailHtml(input),
    brand,
  };
}
