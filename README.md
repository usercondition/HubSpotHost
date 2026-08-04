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

## Paid Order Intake

The **Paid order intake** screen is a payment-confirmed, review-first route for Facebook Marketplace orders. It is deliberately not a lead-capture tool:

1. Paste the relevant part of a paid Marketplace conversation.
2. The screen creates editable suggestions for the customer, Marketplace username, model, paid amount, shipping details, and a brief order summary.
3. Correct any missing or inaccurate details.
4. Check **Payment has been confirmed**.
5. Confirm the final prompt to create a HubSpot Contact and one associated Deal.

The service creates the Deal in the **Print Orders** pipeline at **Deposit Received**. It uses the existing `amount` field for revenue, so the live gross-profit and margin automation takes over as production costs are recorded.

The pasted conversation is processed to produce the draft and is not written into the HubSpot record. The HubSpot Deal receives only the edited order summary and normal operational fields. The raw conversation is also not written to the service audit file.

### Intake protection

The public route is protected by a dedicated **Paid Order Intake access code**. It is required for both analysis and creation:

- Prefer secure credential injection through `CUSTOM_CRED_PAID_ORDER_INTAKE_LOCAL_TOKEN`.
- Use `PAID_ORDER_INTAKE_ACCESS_CODE` only for local development.
- The browser does not retain the access code.
- The server requires an explicit `paymentConfirmed: true` value, a customer name or Marketplace username, an item description, and a paid amount greater than zero before it can call HubSpot.
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
| `CUSTOM_CRED_PAID_ORDER_INTAKE_LOCAL_TOKEN` | Preferred for Paid Order Intake | Securely injected access code required to analyze or create a paid Marketplace order. |
| `PAID_ORDER_INTAKE_ACCESS_CODE` | Local fallback | Access code for local-only Paid Order Intake development. |
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
| `POST /api/paid-orders/analyze` | Protected, write-free Marketplace conversation analysis that returns editable suggestions. |
| `POST /api/paid-orders` | Protected creation of a payment-confirmed Contact and associated Print Orders Deal. |

## Production notes

- Use a host that keeps the HTTPS endpoint available for incoming HubSpot requests.
- Inject the token and client secret through the host’s secret manager, never through the frontend or a committed `.env` file.
- The local audit file is a small operational trail, not a long-term accounting system. Route logs to managed storage if durable historical audit retention is required.
- The HubSpot credential must retain permission to read and update deal properties.
- The Paid Order Intake creation endpoint needs permission to create contacts, create deals, search contacts by email, and associate contacts with deals.

## References

- HubSpot: [Create and edit webhook subscriptions in legacy private apps](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/create-and-edit-webhook-subscriptions-in-private-apps)
- HubSpot: [Validate webhook requests](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests)
