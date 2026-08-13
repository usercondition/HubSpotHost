# HubSpot Print Orders Profit Calculator

This service calculates Gross Profit and Margin Percentage for the Print Orders pipeline whenever HubSpot reports a relevant deal-property change. It reads the existing source fields, applies the calculation, and writes only the existing output fields.

## What it calculates

| Role | HubSpot internal name |
|---|---|
| Quote amount | `amount` |
| Material cost | `print_material_cost` |
| Labor cost | `print_labor_cost` |
| Packaging cost | `print_packaging_cost` |
| Actual shipping cost | `print_actual_shipping_cost` |
| Gross Profit output | `print_gross_profit` |
| Margin Percentage output | `print_margin_percentage` |

```text
gross profit = amount - material - labor - packaging - shipping
margin percentage = amount > 0 ? (gross profit / amount) * 100 : 0
```

Blank, missing, or non-numeric values are treated as zero. Both outputs are rounded to two decimals. Output-property events are intentionally ignored, so writing the calculated fields cannot trigger a calculation loop.

## Safety model

The service starts in safe mode:

- `DRY_RUN=true` by default.
- A verified HubSpot webhook write only occurs when all three server gates are true:
  1. `DRY_RUN=false`.
  2. `ALLOW_HUBSPOT_WRITES=true`.
  3. A HubSpot token is available.
- A production webhook endpoint refuses requests until `HUBSPOT_WEBHOOK_SECRET` is configured.
- Manual recalculation and audit-log API endpoints are intentionally disabled in a public production deployment, so a visitor cannot invoke writes or read financial data.
- The console never returns or logs a token.
- The audit log contains only calculation inputs, outputs, deal ID, timestamp, trigger source, result, and short error message. It keeps the newest 100 entries in `data/audit-log.json`.

Do not enable both live-write environment settings until a test deal produces the expected dry-run values.

## Client order links (primary intake)

**Order links** is the main way a paid Marketplace order enters the system. Nothing reaches HubSpot until you approve it.

1. Agree the order in Marketplace and take payment.
2. Open **Order links**, unlock owner tools with the access code, and create a link: agreed item, amount paid, optional payment method/reference, optional buyer name or username, expiry (14 days by default), optional private notes. The app automatically creates an internal reference such as `PO-20260803-000123`.
3. Press **Copy link** and paste the link into the Marketplace conversation. The link is shown once, right after creation.
4. The buyer opens `/#/order-form/<token>` and fills in a short form: name, Marketplace username, email, phone, ship-or-pickup, shipping address, item confirmation (pre-filled and editable), quantity, notes, and a checkbox confirming they already paid. Returning buyers do not have to retype their address: entering the same email or Marketplace username fills last time’s contact and shipping so they can confirm or correct it. If you already entered their username on the link, those fields open filled. The page states clearly that it collects details only, takes no payment, and does not place a final order. No internal cost or margin fields are shown. Legacy `/#/client-order/<token>` links still work.
5. The submission lands in the private **Review queue** as *Pending review*. Nothing is written to HubSpot at this point.
6. Open **Review**, correct anything the buyer typed loosely, press **Save corrections**, then tick **I verified this payment cleared and the price is correct**. That unlocks **Create Contact and Print Order in HubSpot**, and a browser confirmation appears immediately before the write. If the submitted email or Marketplace username matches a previous intake, Review and the queue mark them as a returning buyer so you can see last order and shipping without looking it up.
7. Approval reuses the same paid-order creation path: a Contact is created or reused by email, and one associated Deal is created in the **Print Orders** pipeline at **Deposit Received**. The stored HubSpot contact and deal IDs are shown, and the intake is locked as *Approved / created* so it cannot be created twice.

Queue tabs: **Awaiting client details**, **Pending review**, **Approved / created**, **Expired**. You can expire any link manually. Only structured fields and short notes are stored — never a raw conversation.

### Link security model

- The token is 32 bytes of `crypto.randomBytes` (256 bits) rendered base64url. Only its SHA-256 hash is stored; the plain token is returned exactly once in the creation response and never persisted, re-displayed, logged, or written to the audit file.
- The buyer's token travels in the JSON request body, not in a URL path or query string, so the request logger never records it.
- A link accepts exactly one submission. The single-submission and expiry checks are enforced in the SQL `WHERE` clause, so concurrent or repeated posts cannot double-submit.
- An unknown, expired, or already-used token returns a generic "not valid" or "closed" message. The buyer page renders no order information until the token validates.
- Public buyer requests are rate-limited per IP. A buyer submission writes only to this app's local database. HubSpot is called from exactly one route: the owner's approval endpoint, which additionally requires `paymentVerified: true`.
- Owner routes (create link, list queue, view, edit, expire, approve) reuse the existing intake access-code gate. The code is sent as a request header, is held in page memory only, and is never placed in the frontend source, browser storage, or cookies.

> **Production hardening.** The owner gate is a single shared app-owned access code, not real authentication. Before treating this as a multi-user production system, replace it with per-user accounts, sessions, and audit attribution. The code comments in `server/routes.ts` and `client/src/pages/order-links.tsx` say the same.

### Persistence caveat

Order links live in a SQLite file (`data.db` in the project root, overridable with `ORDER_LINKS_DB_FILE`). It is created on first use, is git-ignored, and is local to whichever host runs the process. It is not replicated or backed up: a fresh deployment starts with an empty queue, and a host that loses its filesystem loses pending intakes. Copy or back up `data.db` before redeploying if a queue is in flight, and move to managed storage if this becomes business-critical.

### Railway deployment: durable pilot

The repository includes `railway.toml` so Railway can build the app with `npm ci && npm run build`, start it with `npm run start`, and use `/api/health` as the deployment health check.

For the initial single-service setup:

1. Connect the GitHub repository to a Railway service and deploy the `main` branch.
2. Add one Railway Volume mounted at `/data`.
3. Set these Railway service variables:

   ```text
   NODE_ENV=production
   DRY_RUN=false
   ALLOW_HUBSPOT_WRITES=true
   ORDER_LINKS_DB_FILE=/data/data.db
   AUDIT_LOG_FILE=/data/audit-log.json
   PAID_ORDER_INTAKE_ACCESS_CODE_HASH=<SHA-256 hash of your owner code>
   HUBSPOT_API_BASE=https://api.hubapi.com
   HUBSPOT_ACCESS_TOKEN=<HubSpot private-app token>
   HUBSPOT_WEBHOOK_SECRET=<HubSpot private-app client secret>
   PUBLIC_BASE_URL=https://<your-railway-domain>
   ```

   Optional Telegram morning digest (set these as Railway **Variables**, never in git):

   ```text
   TELEGRAM_BOT_TOKEN=<BotFather token>
   TELEGRAM_CHAT_ID=<your numeric Telegram chat id>
   OWNER_DIGEST_SCHEDULE_ENABLED=true
   OWNER_DIGEST_TZ=America/New_York
   OWNER_DIGEST_HOUR=7
   OWNER_DIGEST_CRON_SECRET=<long random secret for POST /api/cron/owner-digest>
   ```

   After deploy, unlock the Command center and use **Send to Telegram** on the tracker panel to verify. With `OWNER_DIGEST_SCHEDULE_ENABLED=true`, the service also sends once per day at the configured local hour.

4. Keep `ENABLE_INTERNAL_ADMIN` unset. It deliberately leaves manual recalculation and local audit endpoints unavailable to public visitors.
5. Add the Railway HTTPS URL plus `/api/webhooks/hubspot` as the HubSpot webhook target, then send a dry-run test before relying on automatic updates.

This works well for a single service and keeps the current SQLite queue across routine deployments when the `/data` volume is mounted. Railway Volumes are persistent but a service with a volume cannot scale through replicas and has a brief deployment interruption, so the longer-term production design is to migrate the intake queue and customer records to Railway PostgreSQL.

### Durable production direction

Use GitHub for the application source, deployment history, and change review. Use Railway PostgreSQL for customer profiles, delivery addresses, recurring customer preferences, paid-order submissions, approvals, and HubSpot IDs. Returning-buyer prefill already works from the local intake history: put their Marketplace username on the next private link and the form asks them to confirm last time’s shipping details. A dedicated customer table is still the longer-term home for that data. Never store HubSpot tokens, owner codes, or raw payment credentials in GitHub.

## Manual Order Entry

The **Manual** screen (nav: *Manual*) is for paid orders you already have details for — no buyer form link required:

1. Unlock with the same owner access code as Intake / Daily Work.
2. Enter buyer, shipping, and one or more order items directly (or optionally paste a Marketplace thread to suggest fields).
3. Check **Payment has been confirmed**.
4. Create in HubSpot — one Contact (reused by email when possible) and one Print Order deal per item at **Deposit Received**.

Prefer **Intake** when the buyer still needs a private details link. Prefer **Manual** when payment and details are already in hand.

The optional conversation paste only assists fill; it is not required to create an order, and the raw conversation is never stored in HubSpot.

### Intake protection

Manual create uses the same **Paid Order Intake access code** as the rest of Daily Work:

- The server stores only a SHA-256 hash of the code, never its plain value.
- Set `PAID_ORDER_INTAKE_ACCESS_CODE_HASH` as a protected deployment variable. The server has no default owner code and fails closed when the hash is missing.
- The browser holds the code in session memory only (shared unlock across Daily Work pages).
- The server requires an explicit `paymentConfirmed: true` value, a customer name or Marketplace username, item description(s), and paid amount(s) greater than zero before it can call HubSpot.
- A final browser confirmation is required immediately before the write request.

The intake creates a Contact only after payment is confirmed. If the buyer supplied an email that matches an existing HubSpot Contact, that Contact is reused; otherwise, a new Contact is created and associated with the new Deal.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

The service runs on `http://localhost:5000`. Use the dashboard or:

```bash
curl -X POST http://localhost:5000/api/recalculate/DEAL_ID
```

That request is a dry run unless all write gates are deliberately opened. Validate the service before turning on real HubSpot updates:

```bash
npm test
npm run check
npm run build
```

## Environment variables

Copy `.env.example` and keep `.env` out of source control.

| Variable | Required | Purpose |
|---|---:|---|
| `CUSTOM_CRED_API_HUBAPI_COM_URL` | Preferred | Injected HubSpot API base URL. |
| `CUSTOM_CRED_API_HUBAPI_COM_TOKEN` | Preferred | Injected HubSpot private-app token. |
| `HUBSPOT_API_BASE` | Fallback | API base URL if the custom credential variables are not injected. |
| `HUBSPOT_ACCESS_TOKEN` | Fallback | Private-app token if the custom credential variable is not injected. |
| `HUBSPOT_WEBHOOK_SECRET` | Recommended | Private-app client secret used to validate webhook signatures. |
| `CUSTOM_CRED_HUBSPOT_WEBHOOK_CLIENT_SECRET_LOCAL_TOKEN` | Preferred in this deployment | Securely injected private-app client secret used to validate webhook signatures. |
| `PUBLIC_BASE_URL` | Required behind a proxy | Exact public HTTPS origin when a reverse proxy changes the public host used for v3 signature validation. For this deployment, use `https://print-orders-margin.pplx.app/port/5000`. |
| `DRY_RUN` | Required for activation | Keep `true` during tests; set `false` only when ready to write. |
| `ALLOW_HUBSPOT_WRITES` | Required for activation | Keep `false` during tests; set `true` only with `DRY_RUN=false`. |
| `PAID_ORDER_INTAKE_ACCESS_CODE_HASH` | Required in any live deployment | SHA-256 hash of the owner access code used by both intake routes and all Order links owner APIs. The server never stores the plain code and the app fails closed when this is absent. |
| `HUBSPOT_CALLBACK_TOKEN_SHA256` | Optional | SHA-256 hash of a high-entropy URL callback token when using that optional webhook fallback. If omitted, unsigned webhook deliveries are rejected; HubSpot signature validation remains available through the webhook secret. |
| `ENABLE_INTERNAL_ADMIN` | Local development only | Set to `true` only alongside `NODE_ENV=development` or `NODE_ENV=test` to enable manual recalculation and local audit endpoints. These endpoints stay disabled otherwise. |
| `ORDER_LINKS_DB_FILE` | Optional | Path to the SQLite file holding order links. Defaults to `data.db` in the working directory. |
| `AUDIT_LOG_FILE` | Optional | Override the local audit path. |

## HubSpot private-app webhook setup

The service needs a publicly reachable HTTPS URL before HubSpot can call it. A preview/control panel is useful for testing, but it is not a production webhook endpoint.

1. Deploy the service to a public HTTPS host and note:
   ```text
   https://YOUR-HOST/api/webhooks/hubspot
   ```
2. In HubSpot, open **Development** > **Legacy apps** > your standalone private app.
3. Open **Webhooks**, choose **Edit webhooks**, and set the Target URL to the endpoint above.
4. Create five **Deals** > **Property changed** subscriptions, one for each source field:
   - `amount`
   - `print_material_cost`
   - `print_labor_cost`
   - `print_packaging_cost`
   - `print_actual_shipping_cost`
5. Save with **Commit changes**. HubSpot lets you use **View details** > **Test** on the subscription to deliver a sample event.
6. In the private app’s **Auth** tab, store the client secret in the host’s protected `HUBSPOT_WEBHOOK_SECRET` environment variable, or inject it through the secure credential mapped to `CUSTOM_CRED_HUBSPOT_WEBHOOK_CLIENT_SECRET_LOCAL_TOKEN`. Never put it in browser code or source control.
7. Use a non-customer test deal to send a manual dry run. Confirm the audit row and figures.
8. Enable updates only after that test:
   ```text
   DRY_RUN=false
   ALLOW_HUBSPOT_WRITES=true
   ```

HubSpot manages subscriptions for standalone legacy private apps in the private-app settings rather than through its API. The service accepts CRM v1 webhook signatures and v3 signatures when present. When `HUBSPOT_WEBHOOK_SECRET` is set, unsigned, invalid, or stale signed requests are rejected.

## Endpoints

| Endpoint | Use |
|---|---|
| `GET /api/health` | Status, safety-gate readiness, credential presence, signing configuration. |
| `POST /api/recalculate/:dealId` | Manual read/calculate attempt in local/private mode. Disabled on a public production deployment. |
| `POST /api/webhooks/hubspot` | Receives HubSpot property-change event batches. |
| `GET /api/calculations` | Newest calculation audit entries in local/private mode. Disabled on a public production deployment. |
| `POST /api/paid-orders/analyze` | Protected, write-free Marketplace conversation analysis that returns editable suggestions (optional Manual assist). |
| `POST /api/paid-orders` | Protected creation of a payment-confirmed Contact and associated Print Order deal(s); accepts optional `lineItems`. |
| `POST /api/order-links` | Protected. Mints a one-time client link and returns the plain token exactly once. |
| `GET /api/order-links` | Protected. Queue listing with per-status counts. Never returns the token hash. |
| `GET /api/order-links/:id` | Protected. Full detail for one intake. |
| `PATCH /api/order-links/:id` | Protected. Owner corrections while the intake is pending review. |
| `POST /api/order-links/:id/expire` | Protected. Manually expires a link. |
| `POST /api/order-links/:id/create-order` | Protected. The only HubSpot-writing route in this flow. Requires `paymentVerified: true`. |
| `POST /api/tracker-assistant` | Protected. Read-only ops briefing / Q&A over live Performance + intake. |
| `POST /api/owner-digest/send` | Protected. Sends the live tracker briefing to Telegram immediately. |
| `POST /api/cron/owner-digest` | Secured by `OWNER_DIGEST_CRON_SECRET`. Daily digest entrypoint (skips if already sent today unless `force: true`). |
| `GET /api/order-links/prior-client` | Protected. Looks up the last submitted intake for a Marketplace username and/or email. |
| `POST /api/client-order/lookup` | Public. Token in the body. Returns only client-safe agreed-order details, plus saved contact/shipping when this is a returning buyer. |
| `POST /api/client-order/saved-details` | Public. Token plus the email or username the buyer typed. Returns last contact/shipping or null. Never a directory search. |
| `POST /api/client-order/submit` | Public. Writes the buyer's details to the local queue. Never calls HubSpot. |

## Production notes

- Use a host that keeps the HTTPS endpoint available for incoming HubSpot requests.
- Inject the token and client secret through the host’s secret manager, never through the frontend or a committed `.env` file.
- The local audit file is a small operational trail, not a long-term accounting system. Route logs to managed storage if durable historical audit retention is required.
- The HubSpot credential must retain permission to read and update deal properties.
- The Paid Order Intake creation endpoint needs permission to create contacts, create deals, search contacts by email, and associate contacts with deals.
- Back up or migrate `data.db` when redeploying: pending order links and unreviewed buyer submissions live only in that file.
- Replace the shared owner access code with real authentication before more than one person needs owner access.

## References

- HubSpot: [Create and edit webhook subscriptions in legacy private apps](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/create-and-edit-webhook-subscriptions-in-private-apps)
- HubSpot: [Validate webhook requests](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests)
