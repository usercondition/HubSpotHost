# Print Ops Home cleanup — design

**Date:** 2026-11-01  
**Status:** Approved structure (Miguel); awaiting Miguel review of this written spec  
**Repo:** HubSpotHost  
**Scope:** Home (`/` / Work Hub) information architecture + density cleanup — not a new visual brand

## Problem

The current Home does not make sense as a front door. Outstanding-order chrome, action lists, and nav noise compete. Redesign experiments (light CRM, desk vibes) were rejected. Miguel wants the **current Print Ops shell and colors** kept, with Home rebuilt so it is scannable and purposeful.

## Goals (prioritized)

Home must do **all three**, in this order:

1. **What needs me today** — human decisions only (ship-today, replies, blockers). Loudest block.
2. **Run production (print → ship)** — compact pipeline counts + next production jobs, not the full outstanding table.
3. **Every storefront + system at a glance** — eBay, Etsy, OfferUp + Paperclip, Syncthing, Make, HubSpot, Railway (and similar). Status dots; tap opens peek / existing Systems or storefront surfaces.

## Non-goals

- New color system or “cute” personality skins.
- Replacing Paperclip, HubSpot, or Make UIs inside Home.
- Full left-nav IA rewrite in v1 (thin later; keep shell).
- Keeping the full Outstanding Orders table on Home.

## Constraints

- Keep Print Ops dark chrome: canvas `#171717`, cards `#262626`, hairlines white/10, Inter, color reserved for status (existing `index.css` / Paperclip-style tokens).
- Desktop-first.
- Existing owner unlock / session unchanged.
- Data sources stay server APIs already used by Work Hub, Systems, listings/health — no new backend product in this spec beyond wiring existing feeds into Home sections.
- Shop/ops execution still runs through Paperclip agents; Hub is the operator surface.

## Current baseline

- Shell: `client/src/components/shell.tsx` (grouped left rail Run / Take / Keep / Office).
- Home body: `client/src/components/work-hub.tsx` — “What needs your attention”, Do next (`FloorNeed`s), Outstanding orders table with filters/sort.
- Phases 0–4 already shipped storefront compare / listings / Systems heartbeats elsewhere in the app; Home does not yet prioritize them as a glance strip.

## Target Home layout

Vertical stack inside existing main pane (left rail unchanged for v1):

### A. Needs you (priority 1)

- Title: **Needs you** (or equivalent plain language).
- List of 0–N actionable items from floor needs / attention APIs — only items that require Miguel (or an explicit human gate).
- Each row: short title, one-line reason, primary open affordance.
- Empty state: one calm line (“Nothing needs you right now”).
- No filter chrome on Home for this block.

### B. Production (priority 2)

- Compact **print → ship** strip: Deposit / Printing / Ship ready / Shipped (7d) counts (or the shop’s real stage names already in HubSpot/Print Ops).
- Optional short “next up” list (≤3) linking into queue / priority — not a full table.
- Link: “Open priority” / “Open print queue” to existing routes (`/stack`, `/queue`).

### C. Connections (priority 3)

- Grid of storefronts + ops services with live/degraded/paused status.
- Minimum set: eBay, Etsy, OfferUp, HubSpot, Paperclip, Syncthing, Make, Railway.
- Tap → existing peek rail / Systems / external app link (reuse Phase 1–4 surfaces; do not invent a second health system).
- OfferUp may show paused when Miguel’s free-post hold is active.

### Moved off Home

- Full **Outstanding orders** table (filters, sort, amount columns) → Priority (`/stack`) and/or Orders routes only. Home may show a count link (“N open orders”) but not the wall of rows.

## Components / files (implementation intent)

- Restructure `work-hub.tsx` into three sections (Needs you / Production / Connections) or thin wrappers that compose existing hooks.
- CSS: extend existing `.work-hub*` rules for looser spacing; avoid new theme files.
- Connections: consume existing health / shop-counts / Systems heartbeat APIs already used by Phase 4.
- Production counts: derive from priority stack / HubSpot stage aggregates already available to the client.
- No change to owner session or Railway deploy process beyond shipping this UI.

## Error handling

- If a connection feed fails, show that tile as unknown/degraded — do not blank the whole Home.
- If needs API empty and healthy, show empty state; if error, show retry on Needs you only.
- Unlock gate unchanged: locked users still see unlock, not Home data.

## Testing

- Manual: unlocked Home shows sections in order Needs → Production → Connections.
- Outstanding table not rendered on `/`.
- Each Connections tile reflects a real status source or explicitly “unknown”.
- Deep links from Needs you and Production land on existing routes.
- Light/dark theme toggle still works with existing tokens.

## Success criteria

- Miguel can open Home and immediately see what needs him, production posture, and whether stores/systems are OK — without hunting.
- Density lower than current Work Hub (no outstanding table on Home).
- Feels like the same Print Ops app (colors/shell), not a different product.

## Out of scope follow-ups (later)

- Left nav label thinning / Paperclip-closer naming.
- Peek-rail polish for Connections.
- Mobile parity (desktop-first only for this cleanup).

