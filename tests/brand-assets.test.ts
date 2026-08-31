import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, readFileSync } from "node:fs";
import { SHIPPING_EMAIL_BRAND } from "../shared/shipping-email-template";

const BRAND_FILES = [
  "client/public/brand/logo-mark.jpg",
  "client/public/brand/logo-mark-128.jpg",
  "client/public/brand/wordmark.jpg",
  "client/public/brand/studio-hero.jpg",
  "client/public/brand/apple-touch-icon.png",
  "client/public/email/shipped-hero.jpg",
  "client/public/email/shipped-stamp.jpg",
  "client/public/favicon.svg",
  "tools/messenger-send-to-print-ops/icons/icon16.png",
  "tools/messenger-send-to-print-ops/icons/icon48.png",
  "tools/messenger-send-to-print-ops/icons/icon128.png",
];

test("Print Ops brand artwork files are present", () => {
  for (const file of BRAND_FILES) {
    accessSync(file);
  }
  const favicon = readFileSync("client/public/favicon.svg", "utf8");
  assert.match(favicon, /#2EC4C0/);
  assert.match(favicon, /#34D399/);
  assert.equal(SHIPPING_EMAIL_BRAND.accentHex, "#1F8A94");
});
