/**
 * Quirky-but-professional “your order is on its way” email for Labels.
 * Hipster-maker vibe: hero art, postage stamp, warm copy, table-based HTML.
 * Images load from assetBaseUrl (your app origin) — required for HTML preview + future senders.
 * Configure brand defaults below — no live send from Print Ops yet.
 */

export type ShippingEmailBrandConfig = {
  /** Shop / brand shown in the email header. */
  shopName: string;
  /** Short line under the shop name (eyebrow). */
  tagline: string;
  /** Accent color (hex) for header bar + CTA. */
  accentHex: string;
  /** Optional support line shown in the footer. */
  supportLine: string;
  /** Reply-to / from display when you wire a real sender later. */
  fromDisplayName: string;
  /**
   * Absolute origin for email images, e.g. https://your-app.up.railway.app
   * Leave empty to omit remote images (plain layout still works).
   */
  assetBaseUrl: string;
  /** Path under assetBaseUrl for the hero illustration. */
  heroImagePath: string;
  /** Path under assetBaseUrl for the postage-stamp graphic. */
  stampImagePath: string;
};

/** Defaults — tweak shop name / accent when you add a sending address. */
export const SHIPPING_EMAIL_BRAND: ShippingEmailBrandConfig = {
  shopName: "Print Ops",
  tagline: "from the studio bench",
  accentHex: "#3F5D4A",
  supportLine: "Questions, photos, or praise? Just reply — a human reads these.",
  fromDisplayName: "The studio desk",
  assetBaseUrl: "",
  heroImagePath: "/email/shipped-hero.jpg",
  stampImagePath: "/email/shipped-stamp.jpg",
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

function joinAssetUrl(base: string, path: string): string | null {
  const b = String(base ?? "").trim().replace(/\/$/, "");
  const p = String(path ?? "").trim();
  if (!b || !p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return `${b}${p.startsWith("/") ? p : `/${p}`}`;
}

export function buildShippingEmailSubject(input: ShippingEmailTemplateInput): string {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  const deal = String(input.dealName ?? "").trim();
  if (deal) return `${brand.shopName}: your order’s on its way — ${deal.slice(0, 64)}`;
  return `${brand.shopName}: your order’s on its way`;
}

/** Plain-text body for mailto / Marketplace-adjacent paste. */
export function buildShippingEmailText(input: ShippingEmailTemplateInput): string {
  const brand = { ...SHIPPING_EMAIL_BRAND, ...input.brand };
  const who = resolveWho(input);
  const service = serviceLabel(input);
  const lines = [
    `Hi ${who},`,
    "",
    "It’s out of the studio and on the road.",
    "Packed with care (we wiped the resin dust, promise).",
    "",
    service ? `Carrier / service: ${service}` : null,
    `Tracking number: ${input.trackingNumber}`,
    input.dealName ? `Order: ${input.dealName}` : null,
    "",
    brand.supportLine,
    "",
    `— ${brand.fromDisplayName}`,
    brand.shopName,
  ].filter((line): line is string => line != null);
  return lines.join("\n");
}

/**
 * Table-based HTML email (works in Gmail / Apple Mail / Outlook).
 * Inline styles only — safe for future transactional senders.
 * Pass brand.assetBaseUrl so hero + stamp images resolve.
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
  const heroUrl = joinAssetUrl(brand.assetBaseUrl, brand.heroImagePath);
  const stampUrl = joinAssetUrl(brand.assetBaseUrl, brand.stampImagePath);
  const subjectSafe = escapeHtml(buildShippingEmailSubject(input));

  const heroBlock = heroUrl
    ? `<tr>
            <td style="padding:0;line-height:0;font-size:0;">
              <img
                src="${escapeHtml(heroUrl)}"
                width="560"
                alt="Your order packed and ready to ship"
                style="display:block;width:100%;max-width:560px;height:auto;border:0;"
              />
            </td>
          </tr>`
    : "";

  const stampBlock = stampUrl
    ? `<td width="96" valign="top" style="padding-left:12px;">
                    <img
                      src="${escapeHtml(stampUrl)}"
                      width="88"
                      height="88"
                      alt="Shipped stamp"
                      style="display:block;width:88px;height:88px;border:0;border-radius:8px;"
                    />
                  </td>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${subjectSafe}</title>
</head>
<body style="margin:0;padding:0;background:#e8e2d6;font-family:Georgia,'Iowan Old Style','Palatino Linotype',serif;color:#1f1a14;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e8e2d6;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#fffdf8;border-radius:4px;overflow:hidden;border:1px solid #d9d0c0;box-shadow:0 1px 0 rgba(31,26,20,0.04);">
          <tr>
            <td style="background:${accent};padding:18px 26px 16px;">
              <div style="font-family:'Avenir Next',Avenir,Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,253,248,0.78);font-weight:700;">${shop}</div>
              <div style="margin-top:6px;font-family:Georgia,'Iowan Old Style',serif;font-size:13px;font-style:italic;color:rgba(255,253,248,0.92);">${tagline}</div>
            </td>
          </tr>
          ${heroBlock}
          <tr>
            <td style="padding:26px 28px 8px;">
              <p style="margin:0 0 6px;font-family:'Avenir Next',Avenir,Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#6b6458;font-weight:700;">Shipped</p>
              <h1 style="margin:0 0 14px;font-size:28px;line-height:1.2;font-weight:700;color:#1f1a14;">
                It’s out of the studio.<br />Onto the road.
              </h1>
              <p style="margin:0 0 12px;font-size:17px;line-height:1.55;">Hi ${who},</p>
              <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#3d3830;">
                Your print left the bench today — packed with care
                <span style="font-style:italic;">(we wiped the resin dust, promise)</span>.
                Here’s your tracking so you can watch it wander toward your door.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f1e6;border:1px dashed #cbbfa8;border-radius:2px;">
                <tr>
                  <td style="padding:16px 18px;font-family:'Avenir Next',Avenir,Helvetica,Arial,sans-serif;" valign="top">
                    ${
                      serviceSafe
                        ? `<div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7a7264;font-weight:700;">Carrier</div>
                    <div style="margin:3px 0 12px;font-size:15px;color:#1f1a14;">${serviceSafe}</div>`
                        : ""
                    }
                    <div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7a7264;font-weight:700;">Tracking</div>
                    <div style="margin:3px 0 0;font-size:18px;font-weight:700;letter-spacing:0.04em;color:#1f1a14;font-family:ui-monospace,Consolas,monospace;">${tracking}</div>
                    ${
                      dealSafe
                        ? `<div style="margin-top:12px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#7a7264;font-weight:700;">Order</div>
                    <div style="margin:3px 0 0;font-size:14px;color:#3d3830;">${dealSafe}</div>`
                        : ""
                    }
                  </td>
                  ${stampBlock}
                </tr>
              </table>
              <p style="margin:22px 0 0;font-size:15px;line-height:1.6;color:#3d3830;">${support}</p>
              <p style="margin:16px 0 0;font-size:15px;color:#1f1a14;">— ${fromName}<br />
                <span style="font-size:13px;color:#6b6458;">${shop}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 22px;font-family:'Avenir Next',Avenir,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.45;color:#9a9183;">
              Template preview from ${shop}. Marketplace messages stay separate. Images host from your app when assetBaseUrl is set.
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
