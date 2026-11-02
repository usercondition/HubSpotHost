# Print Ops Hub Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Print Ops home with an owner-safe operational Hub that compares eBay, Etsy, and OfferUp and safely handles marketplace, listings, and system requests.

**Architecture:** Add focused server libraries for email gating, Hub data, marketplace tracking audit records, listing-feed decisions, and heartbeat reads. Keep `/` as the client entry point, compose its sections from owner-protected APIs, and link to the existing Print Ops workspaces rather than duplicating their functionality.

**Tech Stack:** TypeScript, Express 5, React 18, TanStack Query, Wouter, Tailwind, better-sqlite3, Node test runner.

## Global Constraints

- Only `EMAIL_SEND_MODE=live` may call Resend.
- Missing metrics must render `—` and `Feed pending`; never use invented values.
- All owner-sensitive endpoints require `x-paid-order-access-code`.
- Marketplace tracking, listing, pricing, restart, and wake actions require explicit browser confirmation.
- Approval endpoints only write local audit state or a HubSpot note; they never edit marketplace listings or pricing.
- Validate each phase with focused tests, `npm run check`, `npm run build`, and desktop plus 390px Hub smoke paths before beginning the next phase.

---

### Task 1: Phase 0 shipment-email mode gate

**Files:**
- Modify: `server/lib/resend-shipped-email.ts`
- Modify: `server/lib/shipment-notification-jobs.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `tests/resend-shipped-email.test.ts`

**Interfaces:**
- Produces: `emailSendMode(env?): "off" | "draft" | "live"` and a skip result when mode is not `live`.
- Consumes: existing Resend request implementation and shipment idempotency store.

- [ ] **Step 1: Write failing tests**

```ts
assert.equal(emailSendMode({}), "off");
assert.equal(emailSendMode({ EMAIL_SEND_MODE: "draft" }), "draft");
assert.equal(emailSendMode({ EMAIL_SEND_MODE: "live" }), "live");
const result = await sendShippedEmailViaResend({ to: "buyer@example.com", trackingNumber: "1ZTEST" });
assert.deepEqual(result, { ok: true, skipped: true, reason: "Buyer shipment emails are off (EMAIL_SEND_MODE=off)" });
```

- [ ] **Step 2: Run `npm test -- tests/resend-shipped-email.test.ts` and verify the mode test fails because `emailSendMode` is absent.**
- [ ] **Step 3: Implement the mode parser and early skip before Resend configuration or network use; surface the same skip via `runShipmentEmailJob`.**
- [ ] **Step 4: Re-run `npm test -- tests/resend-shipped-email.test.ts` and verify it passes.**
- [ ] **Step 5: Document `EMAIL_SEND_MODE=live` as the sole email-sending state and commit `feat: gate shipment emails by send mode`.**

### Task 2: Phase 0 marketplace order identity

**Files:**
- Modify: `server/lib/paid-orders.ts`
- Modify: `shared/schema.ts`
- Modify: `tests/paid-orders.test.ts`

**Interfaces:**
- Consumes: `externalOrderId?: string`, `orderSource?: "ebay" | "etsy" | "offerup" | "mmf" | "facebook_marketplace" | "referral" | "other"`.
- Produces: a reuse lookup by `external_order_id`, and deal properties `external_order_id` plus `print_order_source` for a supplied marketplace identity.

- [ ] **Step 1: Write a failing injected-HubSpot test that asserts a matching `external_order_id` is reused and a newly created deal contains both marketplace properties.**
- [ ] **Step 2: Run `npm test -- tests/paid-orders.test.ts` and verify it fails for missing external identity behavior.**
- [ ] **Step 3: Extend paid-order input normalization, perform the unique-ID search before create, and keep existing Facebook/manual calls unchanged when no identity is supplied.**
- [ ] **Step 4: Re-run the focused test and verify it passes.**
- [ ] **Step 5: Commit `feat: key marketplace deals by external order id`.**

### Task 3: Phase 1 Hub projection and home UI

**Files:**
- Create: `server/lib/hub-routes.ts`
- Modify: `server/routes.ts`
- Create: `client/src/components/print-ops-hub.tsx`
- Modify: `client/src/pages/dashboard.tsx`
- Modify: `client/src/pages/inbox.tsx`
- Modify: `shared/schema.ts`
- Create: `tests/hub-routes.test.ts`
- Modify: `tests/ops-hub.test.ts`

**Interfaces:**
- Produces: `GET /api/hub` owner-protected response containing today counts, `storefronts`, `comparison`, flow counts, and explicitly pending listing/system data.
- Produces: `/inbox?storefront=ebay|etsy` filters the existing Inbox cards by channel.

- [ ] **Step 1: Write failing route tests for owner rejection, sourced aggregate values, and `null` values for unavailable listing metrics.**
- [ ] **Step 2: Run `npm test -- tests/hub-routes.test.ts` and verify it fails because `/api/hub` is unregistered.**
- [ ] **Step 3: Implement source aggregation from HubSpot deal properties and existing Performance/production queue; return `null`, never zero, for unavailable feeds.**
- [ ] **Step 4: Write failing component tests for the jump nav, three storefront cards, comparison em dashes, and `Feed pending` labels.**
- [ ] **Step 5: Implement the responsive one-page Hub and Inbox storefront filtering; preserve all existing workspace routes.**
- [ ] **Step 6: Run focused Hub tests, `npm run check`, `npm run build`, and browser smoke at 1024px and 390px.**
- [ ] **Step 7: Commit `feat: make Hub the storefront operations home`.**

### Task 4: Phase 2 confirmed tracking push audit

**Files:**
- Create: `server/lib/marketplace-tracking-routes.ts`
- Modify: `server/routes.ts`
- Modify: `client/src/components/print-ops-hub.tsx`
- Create: `tests/marketplace-tracking-routes.test.ts`

**Interfaces:**
- Produces: `POST /api/marketplace-tracking/push` with `{ dealId, marketplace }`, owner guard, tracking lookup, HubSpot note, and `{ mode: "dry-run" | "live" }`.
- Consumes: `MARKETPLACE_EBAY_TRACKING_PUSH_MODE` and `MARKETPLACE_ETSY_TRACKING_PUSH_MODE`, defaulting to dry-run.

- [ ] **Step 1: Write failing tests for unauthorized rejection, missing tracking rejection, dry-run HubSpot-note creation, and no external request unless mode is live.**
- [ ] **Step 2: Run `npm test -- tests/marketplace-tracking-routes.test.ts` and verify it fails because the route does not exist.**
- [ ] **Step 3: Implement validated tracking lookup and note creation; keep adapter calls behind the explicit live mode.**
- [ ] **Step 4: Add a Hub confirmation dialog that displays target and tracking before it invokes the endpoint.**
- [ ] **Step 5: Run focused tests, `npm run check`, `npm run build`, and the confirmed dry-run browser path.**
- [ ] **Step 6: Commit `feat: add confirmed marketplace tracking push audit`.**

### Task 5: Phase 3 listing-health feed and decisions

**Files:**
- Create: `server/lib/listings-health-routes.ts`
- Modify: `server/routes.ts`
- Modify: `client/src/components/print-ops-hub.tsx`
- Modify: `.env.example`
- Create: `tests/listings-health-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/listings-health` and owner-protected `POST /api/listings-health/:id/decision`.
- Consumes: `LISTINGS_HEALTH_FILE`, JSON records with an ID, storefront, kind, title, reason, and optional proposed price.
- Produces: persisted local `approved`/`dismissed` decisions only.

- [ ] **Step 1: Write failing tests for absent feeds, valid JSON parsing, invalid JSON rejection, and decision persistence without a marketplace request.**
- [ ] **Step 2: Run `npm test -- tests/listings-health-routes.test.ts` and verify it fails because the route is absent.**
- [ ] **Step 3: Implement file loading, schema validation, SQLite decision storage, and safe no-feed responses.**
- [ ] **Step 4: Add clearly labeled approve/dismiss controls with a confirmation dialog and no auto-apply behavior.**
- [ ] **Step 5: Run focused tests, `npm run check`, `npm run build`, and both feed-pending and sample-feed browser paths.**
- [ ] **Step 6: Commit `feat: add approval-only listings health feed`.**

### Task 6: Phase 4 Systems heartbeats and safe action requests

**Files:**
- Create: `server/lib/systems-routes.ts`
- Modify: `server/routes.ts`
- Modify: `client/src/components/print-ops-hub.tsx`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `tests/systems-routes.test.ts`

**Interfaces:**
- Produces: `GET /api/systems` and owner-protected `POST /api/systems/:service/actions`.
- Consumes: `SYSTEM_HEARTBEATS_DIR` with JSON files that contain `service`, `status`, `metrics`, and `timestamp`.
- Produces: safe action records with `executed: false` until a configured handler exists.

- [ ] **Step 1: Write failing tests for missing directories, malformed heartbeat files, status normalization, owner rejection, and safe action records.**
- [ ] **Step 2: Run `npm test -- tests/systems-routes.test.ts` and verify it fails because the route is absent.**
- [ ] **Step 3: Implement heartbeat file parsing, tile status projection, local action-request storage, and non-executing action responses.**
- [ ] **Step 4: Add systems tiles plus a confirmation dialog for wake/restart requests.**
- [ ] **Step 5: Run focused tests, `npm run check`, `npm run build`, and desktop/phone Hub smoke paths.**
- [ ] **Step 6: Commit `feat: add systems heartbeat hub tiles`.**

### Task 7: final verification and release documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update documentation with live, dry-run, and feed-pending status for each marketplace, listings, and system integration.**
- [ ] **Step 2: Run `npm test`, `npm run check`, and `npm run build`; resolve every failure.**
- [ ] **Step 3: Capture desktop and 390px screenshots of the Hub and the confirmed safe action flows.**
- [ ] **Step 4: Commit `docs: describe Print Ops Hub integration modes`, push the branch, and update the pull request summary.**
