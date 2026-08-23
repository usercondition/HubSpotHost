import test from "node:test";
import assert from "node:assert/strict";
import {
  SHIPPING_EMAIL_BRAND,
  buildShippingEmailHtml,
  buildShippingEmailPackage,
  buildShippingEmailSubject,
  buildShippingEmailText,
} from "../shared/shipping-email-template";

test("shipping email template includes tracking and professional markup", () => {
  const pack = buildShippingEmailPackage({
    contactName: "Matt Cota",
    dealName: "Vulkan Primarch Series Centerpiece - Matt Cota",
    trackingNumber: "1ZXG9979YN14824499",
    carrier: "UPS",
  });
  assert.match(pack.subject, /Print Ops/i);
  assert.match(pack.subject, /Vulkan/i);
  assert.match(pack.text, /Hi Matt/);
  assert.match(pack.text, /1ZXG9979YN14824499/);
  assert.match(pack.html, /1ZXG9979YN14824499/);
  assert.match(pack.html, /DOCTYPE html/i);
  assert.match(pack.html, new RegExp(SHIPPING_EMAIL_BRAND.accentHex.replace("#", "#?")));
  assert.match(pack.html, /Your print order is packed/i);
});

test("shipping email subject falls back without deal name", () => {
  const subject = buildShippingEmailSubject({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
  });
  assert.match(subject, /print order shipped/i);
  const text = buildShippingEmailText({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
    service: "UPS Ground",
  });
  assert.match(text, /UPS Ground/);
  const html = buildShippingEmailHtml({
    trackingNumber: "1ZXG9979YN14824499",
    contactName: "Matt",
    dealName: 'Knight & "Dragon"',
  });
  assert.match(html, /Hi Matt/);
  assert.match(html, /Knight &amp; &quot;Dragon&quot;/);
});
