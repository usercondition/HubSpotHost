import test from "node:test";
import assert from "node:assert/strict";
import {
  getConfig,
  getWebhookSecret,
  liveWriteReady,
  resolveWriteDecision,
} from "../server/lib/config";

const base = { hasToken: true };

test("DRY_RUN defaults to true and writes default to disallowed", () => {
  const config = getConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.dryRun, true);
  assert.equal(config.allowWrites, false);
  assert.equal(config.hasToken, false);
  assert.equal(liveWriteReady(config), false);
});

test("a live write needs request intent, DRY_RUN=false, ALLOW_HUBSPOT_WRITES=true and a token", () => {
  assert.equal(
    resolveWriteDecision({ ...base, dryRun: false, allowWrites: true }, true).write,
    true,
  );
  assert.equal(
    resolveWriteDecision({ ...base, dryRun: false, allowWrites: true }, false).write,
    false,
  );
  assert.equal(
    resolveWriteDecision({ ...base, dryRun: true, allowWrites: true }, true).write,
    false,
  );
  assert.equal(
    resolveWriteDecision({ ...base, dryRun: false, allowWrites: false }, true).write,
    false,
  );
  assert.equal(
    resolveWriteDecision({ hasToken: false, dryRun: false, allowWrites: true }, true).write,
    false,
  );
});

test("blocked decisions explain themselves without leaking values", () => {
  const d = resolveWriteDecision({ ...base, dryRun: true, allowWrites: true }, true);
  assert.equal(d.write, false);
  assert.match(d.reason, /DRY_RUN/);
});

test("credentials resolve from CUSTOM_CRED variables first", () => {
  const config = getConfig({
    CUSTOM_CRED_API_HUBAPI_COM_URL: "https://api.hubapi.com/",
    CUSTOM_CRED_API_HUBAPI_COM_TOKEN: "token-a",
    HUBSPOT_API_BASE: "https://other.example.com",
    HUBSPOT_ACCESS_TOKEN: "token-b",
  } as NodeJS.ProcessEnv);
  assert.equal(config.apiBase, "https://api.hubapi.com");
  assert.equal(config.tokenSource, "custom_cred");
  assert.equal(config.hasToken, true);
});

test("fallback credentials are used when CUSTOM_CRED variables are absent", () => {
  const config = getConfig({
    HUBSPOT_API_BASE: "https://api.hubapi.com",
    HUBSPOT_ACCESS_TOKEN: "token-b",
  } as NodeJS.ProcessEnv);
  assert.equal(config.tokenSource, "hubspot_access_token");
  assert.equal(config.apiBase, "https://api.hubapi.com");
});

test("api base falls back to the public HubSpot host", () => {
  const config = getConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.apiBase, "https://api.hubapi.com");
  assert.equal(config.baseFromEnv, false);
});

test("config never exposes the token itself", () => {
  const config = getConfig({
    CUSTOM_CRED_API_HUBAPI_COM_TOKEN: "super-secret",
  } as NodeJS.ProcessEnv);
  assert.equal(JSON.stringify(config).includes("super-secret"), false);
});

test("webhook secret presence is reported as a boolean", () => {
  assert.equal(getConfig({} as NodeJS.ProcessEnv).webhookSecretConfigured, false);
  assert.equal(
    getConfig({ HUBSPOT_WEBHOOK_SECRET: "s" } as NodeJS.ProcessEnv).webhookSecretConfigured,
    true,
  );
});

test("the dedicated injected client-secret credential takes priority", () => {
  assert.equal(
    getWebhookSecret({
      CUSTOM_CRED_HUBSPOT_WEBHOOK_CLIENT_SECRET_LOCAL_TOKEN: "correct-client-secret",
      CUSTOM_CRED_HUBSPOT_WEBHOOK_SECRET_LOCAL_TOKEN: "previous-secret",
      HUBSPOT_WEBHOOK_SECRET: "fallback-secret",
    } as NodeJS.ProcessEnv),
    "correct-client-secret",
  );
});

test("the Print Orders app secret takes priority over earlier webhook credentials", () => {
  assert.equal(
    getWebhookSecret({
      CUSTOM_CRED_HUBSPOT_PRINT_ORDERS_APP_SECRET_LOCAL_TOKEN: "current-app-secret",
      CUSTOM_CRED_HUBSPOT_WEBHOOK_CLIENT_SECRET_LOCAL_TOKEN: "older-client-secret",
      CUSTOM_CRED_HUBSPOT_WEBHOOK_SECRET_LOCAL_TOKEN: "older-webhook-secret",
    } as NodeJS.ProcessEnv),
    "current-app-secret",
  );
});
