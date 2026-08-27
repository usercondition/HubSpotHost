import test from "node:test";
import assert from "node:assert/strict";
import {
  SHIPPING_EMAIL_BRAND,
  buildShippingEmailHtml,
  buildShippingEmailPackage,
  buildShippingEmailSubject,
  buildShippingEmailText,
} from "../shared/shipping-email-template";

test("shipping email template includes quirky copy, tracking, and image slots", () => {
  const pack = buildShippingEmailPackage({
    contactName: "Matt Cota",
    dealName: "Vulkan Primarch Series Centerpiece - Matt Cota",
    trackingNumber: "1ZXG9979YN14824499",
    carrier: "UPS",
    brand: { assetBaseUrl: "https://ops.example.com" },
  });
  assert.match(pack.subject, /Mercado Prints/i);
  assert.match(pack.subject, /on its way/i);
  assert.match(pack.subject, /Vulkan/i);
  assert.match(pack.text, /Miguel at Mercado Prints/);
  assert.match(pack.text, /Mercado Prints/);
  assert.match(pack.text, /out of the studio/i);
  assert.match(pack.text, /1ZXG9979YN14824499/);
  assert.match(pack.html, /1ZXG9979YN14824499/);
  assert.match(pack.html, /DOCTYPE html/i);
  assert.match(pack.html, /out of the studio/i);
  assert.match(pack.html, /resin dust/i);
  assert.match(pack.html, new RegExp(SHIPPING_EMAIL_BRAND.accentHex.replace("#", "#?")));
  assert.match(pack.html, /https:\/\/ops\.example\.com\/email\/shipped-hero\.jpg/);
  assert.match(pack.html, /https:\/\/ops\.example\.com\/email\/shipped-stamp\.jpg/);
});

test("shipping email subject falls back without deal name", () => {
  const subject = buildShippingEmailSubject({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
  });
  assert.match(subject, /on its way/i);
  const text = buildShippingEmailText({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
    service: "UPS Ground",
  });
  assert.match(text, /UPS Ground/);
  assert.match(text, /resin dust/i);
  const html = buildShippingEmailHtml({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
    dealName: 'Knight & "Dragon"',
  });
  assert.match(html, /Hi Matt/);
  assert.match(html, /Knight &amp; &quot;Dragon&quot;/);
  // Without assetBaseUrl, hero/stamp img tags are omitted
  assert.doesNotMatch(html, /shipped-hero\.jpg/);
});
