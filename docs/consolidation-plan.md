# Print Ops consolidation audit — Phase 1

Date: 2026-10-20  
Scope: information architecture only. This proposal does not change routes, APIs, `drive_files_sync.py`, HubSpot, or Drive.

## Evidence

The deployed app was inspected at `https://hubspothost-production.up.railway.app` and the route components, navigation, and their API queries were reviewed in this branch. The deployed captures are necessarily owner-locked; they accurately show the current navigation and page entry states, but not protected customer/order content.

| Current page | Desktop capture |
| --- | --- |
| Work hub | [hub-desktop.png](screenshots/consolidation/hub-desktop.png) |
| Priority / Stack | [priority-desktop.png](screenshots/consolidation/priority-desktop.png) |
| Print queue | [queue-desktop.png](screenshots/consolidation/queue-desktop.png) |
| HubSpot board | [orders-board-desktop.png](screenshots/consolidation/orders-board-desktop.png) |
| Inbox | [inbox-desktop.png](screenshots/consolidation/inbox-desktop.png) |
| Files | [files-desktop.png](screenshots/consolidation/files-desktop.png) |

Phone evidence: [Hub](screenshots/consolidation/hub-phone.png) and [Queue](screenshots/consolidation/queue-phone.png). The current phone tabs already expose Work hub, Inbox, Printers, and Print queue; the target preserves a single-row tab bar.

## Current surface-area audit

“Data” names the main source, not every supporting request. “Disposition” is a recommendation for the implementation phase.

| Route / navigation label | What it shows / primary data | Overlap | Phase-2 disposition |
| --- | --- | --- | --- |
| `/` — Work hub | Needs-you actions assembled from performance, Stack, queue, printers, resin, and intake; an all-open-order list | Priority, Queue, Prints, Intake, Printers | **Become Hub** |
| `/stack` — Priority | Full ranked open and out-the-door Stack, manual ordering, bundles, off-book, fulfillment drawer | Work hub outstanding list; Queue’s order cards; Labels completion | Fold its **read view** into Hub; retain a details drawer and advanced priority controls behind “All orders” |
| `/queue` — Print queue | Next print, in production, blocked, and ship-ready queue buckets; drawer for deal operations | Work hub, Priority, Deals, Printers, Labels | Fold queue lanes into Hub; keep deep-link/detail drawer only |
| `/prints` — Prints | Analyze/attach sliced files, plate metrics, QC/part boards, plate history | Queue plate status, Library, Printers | **Keep** as specialist print-file workspace |
| `/library` — Library | Searchable/reusable Drive-indexed slice files grouped by kit | Prints’ attached plate records and Files search | **Keep**, but off the day-to-day Hub rail |
| `/labels` — Labels | Buy/import labels, parse tracking, match deals, attach completion and draft notices | Queue ship-ready, Stack Out the door, Shipments | **Keep** as a shipping action; link from Hub ship-ready/out-the-door |
| `/shipments` — Shipments | Read-only ShipStation tracking history and exceptions | Labels’ tracking and Stack Out the door | Hide from primary navigation; retain as history reached from Hub’s shipped card |
| `/deals` — HubSpot board | Full CRM stage board/table, deal moves, profit/cost/part flags | Queue flow states, Stack open orders, Hub needs-you | Hide from primary navigation; retain as “CRM board” for exceptional stage management |
| `/inbox` — Inbox | Marketplace chats, suggested drafts, outbound state, follow-ups | Work hub “needs reply”; Marketplace brief | **Keep** as a dedicated communications workspace |
| `/files` — Files | Google Drive and shop-drive business-file search | Library and Prints cover slice-specific files | **Keep** as a dedicated search utility |
| `/orders` — Intake | Paid order-form links and review/approval queue | Manual entry; Work hub pending-review actions | **Keep**; surface pending counts/actions in Hub |
| `/paid-orders` — Manual | Direct paid-order entry and optional conversation assist | Intake’s eventual order creation | **Keep** as a secondary intake path, grouped with Intake |
| `/quote` — Quote | STL upload, printing estimate, add-ons, quote calculation/settings | No operational flow duplication | **Keep** |
| `/printers` — Printers | Fleet status, active jobs, start/finish/assignment actions | Queue in-production lane and Prints assignment | **Keep**; Hub shows compact live status only |
| `/spending` — Spending | Bottom line, supply receipts, overhead | Performance and Profit report money differently | **Keep** as finance; remove it from the operational decision loop |
| `/operations` — Profit | Automation health, cost formula/fields, manual recalculation/audit | Spending, Stats, Setup health | Hide from primary navigation; move setup/audit links into Setup |
| `/performance` — Stats | Period metrics for money, production, pipeline, customers | Spending and Deals reporting; Work hub counts | Hide from primary navigation; retain as reporting |
| `/setup` — Setup | Drive connection, system health, notifications, routes, environment/webhook reference | Profit automation configuration | **Keep** |
| `/clients` — hidden Clients | HubSpot contact search and contact actions | Intake/Manual buyer lookup; Labels address matching | Keep as a contextual lookup/deep link, not primary nav |
| `/marketplace-brief` — hidden Marketplace brief | Secretary summary of Inbox scans and suggested next actions | Inbox’s chats/follow-ups and Hub needs-you | Remove/hide as a standalone page; render its “do first” items in Inbox or Hub |
| `/focus/:kind` | Legacy shortcut that redirects to existing workspaces | Duplicates Hub/Queue/Prints destinations | Keep redirects only; do not expose |
| `/supplies`, `/expenses`, `/spending/overhead` | Compatibility aliases/tabs for Spending | Same Spending data | Keep aliases; no separate navigation |
| `/resin` | Resin inventory and reorder economics | Hub resin “buy now” cue, Spending supplies | Keep contextual/deep-link only |
| `/order-form/:token`, `/client-order/:token` | Public buyer details form | Intake; intentionally buyer-facing rather than owner work | **Keep unchanged** |
| `/more` | Phone-only grouping of nav links | Desktop rail and phone tabs | Rebuild from the reduced navigation; keep the route |
| `/nerve/*` (feature flagged) | Separate Mac-mini/Paperclip operations dashboard | No Print Ops order-flow ownership | Out of scope; leave feature-flagged and separate |
| `kit-dry-run`, `supplies`, `expenses` components | Parked or embedded implementation surfaces, not active standalone app routes | Prints/Spending | Leave untouched in Phase 1; do not revive as navigation |

## Material overlaps

1. **Open orders and priority:** Work hub, Stack, Queue, and HubSpot board all list the same active deals, each with a different sort and subset. Hub should become the default list; Stack becomes its advanced ordering/details mode, and the CRM board becomes exceptional management.
2. **Production flow:** Queue buckets, HubSpot pipeline columns, printer cards, and Prints plate boards all describe “where is this job?” Hub needs only the operational flow—next print and in production—while the specialist screens retain mutations and deep detail.
3. **Shipping/completion:** Queue ship-ready, Labels, Stack Out the door, and Shipments duplicate visibility of ready/shipped work. Hub should show a small **Out the door** summary and direct action to Labels; Shipments remains historical tracking.
4. **Attention/action lists:** Work hub needs, Queue blockers/replies, Inbox follow-ups, Intake pending review, and Marketplace brief “do first” all compete as “what should I do now?” Hub owns production/order attention; Inbox owns conversations; intake approval is a Hub action that opens Intake.
5. **Financial reporting:** Spending, Stats, Profit, and Deals each present money/profit in a different context. These are not candidates for the operational Hub; they should be grouped under finance/reporting or configuration, not mixed with job priority.

## Proposed information architecture

### Hub — the one daily operational view

The Hub replaces the current Work hub, Stack, and Queue as the starting place. It has one canonical open-order data model (Stack ordering plus queue production facts) and uses the existing owner-gated APIs. It does not introduce a second source of truth.

Order, top to bottom:

1. **Needs attention** — overdue first, then due today, then blockers: missing plate, stalled/reply-needed, failed/reprint, missing label/packing, pending intake review, critical printer or resin issue. Each row links directly to the existing action/drawer.
2. **Today’s print queue by priority** — two compact lanes only: **Next print** and **In production**. Show order, plates/time, assigned printer/progress, target date, amount, and only actionable warnings. Do not reproduce a full Kanban board.
3. **Coming up** — the remaining open Stack in auto priority order: overdue → target date → closeness to done → amount. This is the single all-open-order list with Stack’s shared columns, filters, and an “advanced priority controls” escape hatch.
4. **Out the door** — a compact completed-this-week total plus recent shipped/picked-up orders. It preserves existing accounting rules: each amount is counted once, done orders leave open cash, and the weekly goal includes open committed plus Out the door.

Persistent Hub affordances: owner unlock, HubSpot sync health, refresh, compact “Ask Ops,” and links to Inbox/Intake/Labels when the corresponding action occurs. On phone, keep the header/action line unwrapped and retain horizontally scrollable tabs.

![Proposed Hub rough mockup](consolidation/hub-mockup.svg)

The mockup intentionally uses sample names and amounts; it does not represent live shop data.

### Navigation after consolidation

**Primary**

- Hub
- Inbox
- Print files
- Printers
- Labels
- Intake (contains order-form review; Manual is a secondary choice)
- Quote
- Files
- Spending
- Setup

**Contextual / hidden from primary nav**

- Advanced priority controls / all orders (current Stack)
- CRM board (current HubSpot board)
- Shipment history
- Stats and Profit automation
- Clients, resin inventory, Library
- Legacy focus and Spending aliases

This preserves specialist tasks without presenting multiple competing “run the shop” pages. HubSpot and Drive remain integrations behind the same existing APIs; no paid services are proposed.

## Implementation sequence for a later phase

1. Define a read-only Hub view model that composes the existing `/api/priority-stack`, `/api/production-queue`, performance, printer, resin, and intake data. Keep all owner-gating and HubSpot-write paths unchanged.
2. Rebuild `/` around the four sections above, reusing Stack rows and Queue cards so column alignment, Pacific dates, bundling, off-book, completion, and sync rules remain intact.
3. Move the current Stack read/list and Queue board from primary navigation to contextual “advanced” destinations; preserve old deep links through redirects or existing drawers.
4. Reduce desktop rail and phone More entries only after the Hub proves it covers the day-to-day loop. Keep Inbox, Files, Intake, Quote, Printers, Labels, Spending, and Setup accessible.
5. Verify at 1024px and 390px with sample data; verify owner auth, HubSpot sync health, label completion refresh, Drive attach/search, and old links.

## Decisions requested from Miguel

1. Confirm Hub’s four-section order and whether **Out the door** should remain on Hub or be history-only.
2. Confirm that the CRM board, shipment history, Stats, and Profit are acceptable as hidden/contextual tools instead of primary navigation.
3. Confirm whether Manual order entry should remain its own phone More item or live under Intake only.
