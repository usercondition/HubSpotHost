# Print Ops Hub redesign

## Goal

Make the existing `/` Hub the owner’s single home for running the print shop, comparing eBay, Etsy, and OfferUp, and safely reviewing marketplace, listings, and systems work.

## Chosen approach

The Hub will remain a client-side, owner-unlocked page built from focused API projections. Existing Print Ops routes remain unchanged and are reachable through Hub links. New read models return only sourced measurements; missing feeds render an em dash and `Feed pending`, never a synthetic zero or estimate.

This approach was selected over a separate storefront app or a purely static landing page. A separate app would split the shop workflow and duplicate owner gating; a static page would not satisfy the operational dashboard requirement.

## Phase 0: shipment email safety

`EMAIL_SEND_MODE` has four effective states: unset, `off`, and `draft` skip Resend; only `live` can call Resend. Shipment jobs retain idempotency and report a clear skip reason. The variable is documented in `.env.example` and README.

Marketplace deal creation paths accept an optional external order identity and source. When such an identity is present, the app searches HubSpot `external_order_id` before creating a deal, then writes both `external_order_id` and `print_order_source` on a new deal. Existing manual/Facebook intake continues without fabricated external IDs.

## Phase 1: Hub home and storefront comparison

`/` becomes a one-page Hub with a sticky, horizontally scrollable phone jump bar: Today, Storefronts, Flow, Listings + Pricing, Systems, and Money. The layout uses existing Tailwind panels and keeps actions on one line at 390px.

An owner-protected Hub read endpoint combines existing Performance and production-queue data with HubSpot source aggregates. Each eBay, Etsy, and OfferUp card displays sourced open-order and performance values when available. Manage opens `/inbox?storefront=<source>` for eBay/Etsy, whose feeds already exist; OfferUp and all unavailable listing tools clearly state `Feed pending`.

The comparison table exposes sales, orders, AOV, listing count, and attention count by source. HubSpot aggregation supplies sales, orders, and AOV; missing source property values and unavailable listing feeds use `—` plus the feed-pending copy.

## Phase 2: owner-confirmed tracking pushes

Hub tracking actions require the owner code, a confirmed browser dialog, existing tracking, and a selected target (`ebay` or `etsy`). The server records a HubSpot note containing target, tracking, result mode, and timestamp. Marketplace delivery is disabled by default; when its per-marketplace feature flag is not live, the action succeeds as a clearly disclosed dry-run note rather than contacting a marketplace.

## Phase 3: listing-health and pricing approvals

The server reads a configurable JSON file containing listing health and pricing suggestions. The Hub shows source, title, reason, proposed price, and feed status. Approve and dismiss persist an app-local audit decision only; neither action changes a listing or price. An absent feed returns an empty, explicitly pending view.

## Phase 4: systems heartbeats

The server reads valid heartbeat JSON files from a configurable directory. Each heartbeat requires `service`, `status`, `metrics`, and `timestamp`; malformed or absent feeds yield an explicit pending/unavailable tile. The Hub maps status to green/yellow/red.

Wake and restart controls always display a confirmation dialog. The server records a safe local action request and returns that no system command was run unless a future handler is configured.

## Cross-cutting constraints

- No buyer email is sent unless `EMAIL_SEND_MODE=live`.
- No marketplace tracking push, listing edit, or price edit occurs without Miguel’s explicit confirmation.
- HubSpot remains the order and financial source of truth.
- All sensitive owner APIs reuse the existing owner access-code guard.
- All phases receive targeted tests, full typecheck, build, and desktop + 390px smoke testing before the next phase starts.
- Documentation identifies live, dry-run, and feed-pending functionality.
