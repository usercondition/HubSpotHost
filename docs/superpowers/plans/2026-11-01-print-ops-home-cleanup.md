# Print Ops Home Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Print Ops Home (`/`) so it prioritizes Needs you → Production → Connections, keeps current dark Print Ops chrome, and removes the full outstanding-orders table from Home.

**Architecture:** Branch from current `origin/main` (PR #289 already landed Work Hub + systems/listings APIs). Restructure `WorkHub` into three stacked sections; add a pure helper that maps `/api/systems` heartbeats + known storefront/link metadata into Connection tiles; keep `dashboard.tsx` as the data owner that passes props. CSS stays in `client/src/index.css` under existing `.work-hub*` / new `.hub-connections*` classes. No new backend product — reuse `/api/systems`, stack/queue already loaded on the dashboard, and static app links for Paperclip/HubSpot/Railway when heartbeats are absent.

**Tech Stack:** React + wouter, TanStack Query, Express owner-gated APIs, node:test, existing Print Ops CSS tokens (`#171717` / `#262626`).

## Global Constraints

- Keep Print Ops dark chrome: canvas `#171717`, cards `#262626`, hairlines white/10, Inter; color only for status.
- Desktop-first; do not redesign left rail IA in this plan.
- Owner unlock / session unchanged.
- No new visual brand; no cute copy skins.
- Outstanding orders table must not render on `/` (count link OK).
- Shop execution stays with Paperclip agents; Hub is operator surface only.
- Spec: `docs/superpowers/specs/2026-11-01-print-ops-home-cleanup-design.md`.

## File map

| File | Responsibility |
|------|----------------|
| `client/src/lib/home-connections.ts` | Pure builders: connection tiles from systems heartbeats + static fallbacks |
| `tests/home-connections.test.ts` | Unit tests for tile mapping / degraded / paused OfferUp |
| `client/src/components/work-hub.tsx` | Home UI: Needs you, Production, Connections |
| `client/src/pages/dashboard.tsx` | Fetch systems (+ existing stack/queue/needs); pass into WorkHub |
| `client/src/index.css` | Spacing + Connections grid styles (reuse tokens) |
| `tests/floor-needs.test.ts` | Unchanged unless Needs filter helpers added |

---

### Task 1: Connection tile helper

**Files:**
- Create: `client/src/lib/home-connections.ts`
- Create: `tests/home-connections.test.ts`

**Interfaces:**
- Consumes: heartbeat shape `{ service: string; status: "green" | "yellow" | "red"; metrics: Record<string, unknown>; timestamp: string }` matching `server/lib/systems-routes.ts`
- Produces:
  - `export type ConnectionTone = "good" | "warn" | "bad" | "paused" | "unknown"`
  - `export type HomeConnection = { id: string; label: string; tone: ConnectionTone; detail: string; href: string }`
  - `export function buildHomeConnections(input: { heartbeats: Array<{ service: string; status: "green" | "yellow" | "red"; metrics: Record<string, unknown>; timestamp: string }>; pending: boolean; offerUpPaused: boolean; paperclipHref: string; hubspotHref: string; railwayHref: string }): HomeConnection[]`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHomeConnections } from "../client/src/lib/home-connections";

describe("buildHomeConnections", () => {
  it("maps Syncthing heartbeat and marks OfferUp paused", () => {
    const tiles = buildHomeConnections({
      heartbeats: [
        { service: "Syncthing", status: "green", metrics: { peers: 2 }, timestamp: "2026-11-02T00:00:00Z" },
      ],
      pending: false,
      offerUpPaused: true,
      paperclipHref: "https://miguels-mac-mini.tailc0d52c.ts.net/",
      hubspotHref: "https://app-na2.hubspot.com/contacts/246947621/objects/0-3/views/all/board",
      railwayHref: "https://hubspothost-production.up.railway.app/",
    });
    const syncthing = tiles.find((t) => t.id === "syncthing");
    const offerup = tiles.find((t) => t.id === "offerup");
    assert.equal(syncthing?.tone, "good");
    assert.equal(offerup?.tone, "paused");
    assert.ok(tiles.some((t) => t.id === "ebay"));
    assert.ok(tiles.some((t) => t.id === "paperclip"));
  });

  it("uses unknown when systems feed is pending", () => {
    const tiles = buildHomeConnections({
      heartbeats: [],
      pending: true,
      offerUpPaused: false,
      paperclipHref: "https://example.com/paperclip",
      hubspotHref: "https://example.com/hubspot",
      railwayHref: "https://example.com/railway",
    });
    const make = tiles.find((t) => t.id === "make");
    assert.equal(make?.tone, "unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/home-connections.test.ts`  
(If the repo’s `npm test` already discovers `tests/*.test.ts`, use `npm test -- tests/home-connections.test.ts` instead.)  
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/lib/home-connections.ts
export type ConnectionTone = "good" | "warn" | "bad" | "paused" | "unknown";

export type HomeConnection = {
  id: string;
  label: string;
  tone: ConnectionTone;
  detail: string;
  href: string;
};

type Heartbeat = {
  service: string;
  status: "green" | "yellow" | "red";
  metrics: Record<string, unknown>;
  timestamp: string;
};

function toneFromStatus(status: Heartbeat["status"]): ConnectionTone {
  if (status === "green") return "good";
  if (status === "yellow") return "warn";
  return "bad";
}

function findHeartbeat(heartbeats: Heartbeat[], names: string[]): Heartbeat | undefined {
  const lower = names.map((n) => n.toLowerCase());
  return heartbeats.find((h) => lower.includes(h.service.toLowerCase()));
}

export function buildHomeConnections(input: {
  heartbeats: Heartbeat[];
  pending: boolean;
  offerUpPaused: boolean;
  paperclipHref: string;
  hubspotHref: string;
  railwayHref: string;
}): HomeConnection[] {
  const hb = input.heartbeats;
  const syncthing = findHeartbeat(hb, ["Syncthing"]);
  const make = findHeartbeat(hb, ["Make"]);
  const paperclip = findHeartbeat(hb, ["Paperclip"]);
  const railway = findHeartbeat(hb, ["Railway", "Hub"]);
  const hubspot = findHeartbeat(hb, ["HubSpot"]);

  const fallbackTone = (hit: Heartbeat | undefined): ConnectionTone =>
    hit ? toneFromStatus(hit.status) : input.pending ? "unknown" : "unknown";

  return [
    { id: "ebay", label: "eBay", tone: "unknown", detail: "listings", href: "/marketplace-brief" },
    { id: "etsy", label: "Etsy", tone: "unknown", detail: "listings", href: "/marketplace-brief" },
    {
      id: "offerup",
      label: "OfferUp",
      tone: input.offerUpPaused ? "paused" : "unknown",
      detail: input.offerUpPaused ? "paused" : "listings",
      href: "/marketplace-brief",
    },
    {
      id: "hubspot",
      label: "HubSpot",
      tone: fallbackTone(hubspot),
      detail: hubspot ? hubspot.status : input.pending ? "pending" : "open",
      href: input.hubspotHref,
    },
    {
      id: "paperclip",
      label: "Paperclip",
      tone: fallbackTone(paperclip),
      detail: paperclip ? paperclip.status : "agents",
      href: input.paperclipHref,
    },
    {
      id: "syncthing",
      label: "Syncthing",
      tone: fallbackTone(syncthing),
      detail: syncthing ? String(syncthing.metrics.peers ?? syncthing.status) : input.pending ? "pending" : "—",
      href: "/setup",
    },
    {
      id: "make",
      label: "Make",
      tone: fallbackTone(make),
      detail: make ? make.status : input.pending ? "pending" : "—",
      href: "/setup",
    },
    {
      id: "railway",
      label: "Railway",
      tone: fallbackTone(railway),
      detail: railway ? railway.status : "Hub",
      href: input.railwayHref,
    },
  ];
}
```

Note: eBay/Etsy tones stay `unknown` until listings-health or shop-count signals are wired in Task 3 (optional enrichment). Do not invent fake live counts.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/home-connections.test.ts` (or `npm test -- tests/home-connections.test.ts`)  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/home-connections.ts tests/home-connections.test.ts
git commit -m "feat: home connection tile helper for Print Ops Home"
```

---

### Task 2: Restructure WorkHub UI (Needs → Production → Connections)

**Files:**
- Modify: `client/src/components/work-hub.tsx` (on branch based on `origin/main`)
- Modify: `client/src/index.css` (add Connections + looser section gaps; keep tokens)

**Interfaces:**
- Consumes: existing `FloorNeed[]`, `StackView`, production queue props already used on main’s `WorkHub`; plus `connections: HomeConnection[]` and `openOrderCount: number`
- Produces: updated `WorkHub` props — no outstanding table

- [ ] **Step 1: Write a focused render/contract test** (if the repo has no React component test harness, skip DOM and instead add a pure prop-shape assertion in `tests/home-connections.test.ts` documenting required WorkHub sections — preferred: extend with a small `export function homeSectionOrder(): string[]` returning `["needs", "production", "connections"]` and assert that).

Add to `client/src/lib/home-connections.ts`:

```ts
export function homeSectionOrder(): Array<"needs" | "production" | "connections"> {
  return ["needs", "production", "connections"];
}
```

Add test:

```ts
it("locks Home section order", () => {
  assert.deepEqual(homeSectionOrder(), ["needs", "production", "connections"]);
});
```

- [ ] **Step 2: Run test — fail then pass after export**

- [ ] **Step 3: Rewrite `WorkHub` sections**

Replace the outstanding/Coming-up table block with:

1. **Needs you** — reuse current needs list UI; rename heading to `Needs you`; empty copy: `Nothing needs you right now.`
2. **Production** — keep main’s print-queue lanes **or** replace with a compact count strip derived from queue buckets + link to `/queue` and `/stack`. Prefer keeping queue lanes if already present on main, but drop the full outstanding table.
3. **Connections** — map `connections` into a grid; each tile is `<a>` or `<Link>` using `href` (external `target="_blank"` when `href.startsWith("http")`).
4. Optional footer link: `{openOrderCount} open orders` → `/stack` only.

Props shape (exact):

```ts
export function WorkHub({
  needs,
  stack,
  today,
  queue,
  connections,
  openOrderCount,
}: {
  needs: FloorNeed[];
  stack: StackView | undefined;
  today: string;
  queue: ProductionQueueResponse | undefined;
  connections: HomeConnection[];
  openOrderCount: number;
}) { /* ... */ }
```

Remove imports/helpers only used by the outstanding table filters/sort if unused after deletion.

- [ ] **Step 4: CSS**

Add (token-aligned) rules near existing `.work-hub` block in `client/src/index.css`:

```css
.work-hub {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.hub-connections-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
}
.hub-connection-tile {
  border: 1px solid hsl(var(--border) / 0.1);
  background: hsl(var(--card));
  border-radius: 0.75rem;
  padding: 0.875rem 1rem;
}
.hub-connection-tile[data-tone="paused"] { opacity: 0.7; }
.hub-connection-tile[data-tone="warn"] { border-color: hsl(var(--warn) / 0.45); }
.hub-connection-tile[data-tone="bad"] { border-color: hsl(var(--bad) / 0.45); }
```

(Adjust selectors to match existing dark token usage in file — do not introduce new hex brand colors.)

- [ ] **Step 5: Typecheck**

Run: `npm run check`  
Expected: PASS (or only pre-existing errors unrelated to WorkHub)

- [ ] **Step 6: Commit**

```bash
git add client/src/components/work-hub.tsx client/src/index.css client/src/lib/home-connections.ts tests/home-connections.test.ts
git commit -m "feat: Home Needs → Production → Connections; drop outstanding table"
```

---

### Task 3: Wire dashboard data (`/api/systems` + props)

**Files:**
- Modify: `client/src/pages/dashboard.tsx`

**Interfaces:**
- Consumes: `buildHomeConnections`, owner session headers, `/api/systems`
- Produces: passes `connections` and `openOrderCount` into `WorkHub`

- [ ] **Step 1: Add systems query beside existing unlocked queries**

```ts
const systems = useQuery<{ ok: true; pending: boolean; heartbeats: Array<{ service: string; status: "green" | "yellow" | "red"; metrics: Record<string, unknown>; timestamp: string }> }>({
  queryKey: ["/api/systems", ownerCode],
  enabled: isUnlocked,
  queryFn: async () => {
    const response = await apiRequest("GET", "/api/systems", undefined, { headers });
    return (await response.json()) as {
      ok: true;
      pending: boolean;
      heartbeats: Array<{ service: string; status: "green" | "yellow" | "red"; metrics: Record<string, unknown>; timestamp: string }>;
    };
  },
  staleTime: 30_000,
});
```

- [ ] **Step 2: Build connections**

```ts
const connections = buildHomeConnections({
  heartbeats: systems.data?.heartbeats ?? [],
  pending: systems.data?.pending ?? true,
  offerUpPaused: true, // standing Miguel OfferUp free-post pause until he resumes
  paperclipHref: "https://miguels-mac-mini.tailc0d52c.ts.net/",
  hubspotHref: "https://app-na2.hubspot.com/contacts/246947621/objects/0-3/views/all/board",
  railwayHref: "https://hubspothost-production.up.railway.app/",
});
```

Use the same Paperclip/HubSpot hrefs as `APP_LINKS` in `shell.tsx` (import constants if extracted; otherwise duplicate once and leave a one-line comment pointing at shell).

- [ ] **Step 3: Update `<WorkHub … />` call site**

Pass `connections`, `openOrderCount: stack.data?.rows?.length ?? 0` (or whatever stack variable name main uses), and keep needs/queue/today.

- [ ] **Step 4: Manual verification checklist (document in PR)**

- Unlocked `/` shows Needs you, then Production, then Connections.
- No outstanding table / Coming up wall on `/`.
- Connections tiles render when `/api/systems` pending (unknown tones OK).
- Needs empty state string exact.
- Deep links: needs rows, queue links, `/stack` count link.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/dashboard.tsx
git commit -m "feat: wire /api/systems into Print Ops Home connections"
```

---

### Task 4: Verify + PR

**Files:** none new

- [ ] **Step 1: Run tests**

```bash
npm test
npm run check
```

Expected: all green (or document pre-existing failures unrelated to this work).

- [ ] **Step 2: Open PR against `main`**

Title: `Print Ops Home cleanup: Needs → Production → Connections`  
Body: link spec `docs/superpowers/specs/2026-11-01-print-ops-home-cleanup-design.md`; note OfferUp tile forced paused per standing pause; left-nav thinning deferred.

- [ ] **Step 3: Deploy only after Miguel OK** (Railway production) — do not auto-promote.

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| Needs you first | Task 2 |
| Production print→ship | Task 2 (queue lanes / counts) |
| Connections glance | Tasks 1–3 |
| Keep colors/shell | Global + CSS |
| Remove outstanding table from Home | Task 2 |
| Existing APIs only | Tasks 1, 3 (`/api/systems`) |
| Error: per-tile unknown | Task 1 |
| Unlock unchanged | Task 3 (`enabled: isUnlocked`) |
| Desktop-first | Global |
| Nav thinning later | Out of scope |

## Placeholder scan

None intentional. eBay/Etsy tones remain `unknown` until a later listings-count enrichment — called out explicitly in Task 1.

