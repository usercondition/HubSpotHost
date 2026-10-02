# Print Ops full code review — 2026-10-02

## Scope and method

Reviewed `origin/main` at `469fef2` (`Add ShipStation shipment tracking (#239)`) top-to-bottom across `server/`, `client/`, `shared/`, `tests/`, `tools/`, `script/`, root configuration, and documentation. This is an audit only; no product code was changed.

Findings below are evidence-backed. “Estimated” savings are planning ranges, not measurements from a changed build.

## Verification

The prebuilt `node_modules` directory was incomplete (`tsx` and `tsc` were absent), so the first commands could not launch. After a local `npm ci` from the committed lockfile:

| Check | Result |
| --- | --- |
| `npm test` | Pass: 503 passed, 0 failed, 1 skipped; 2m 10s |
| `npm run check` | Pass |
| `npm run build` | Pass |
| `npm ls --all` | Pass |
| Dependency installation | `npm ci` reported 6 advisories (3 moderate, 3 high); no remediation was applied in this audit |

The build emits four warnings because CJS output replaces `import.meta` in `server/lib/plate-mesh.ts` and `server/lib/health-digest-card.ts`. Both call sites have a fallback path, so this is a build-cleanliness issue rather than a confirmed runtime fault.

## Findings

### High

1. **Slice attachment overwrites populated HubSpot production fields**
   - **Evidence:** `server/lib/hubspot.ts:500-509` unconditionally PATCHes every property returned from `printFileProperties`; `server/lib/hubspot.ts:410-439` always supplies fields such as `print_slice_file_name`, estimates, layer/exposure values, and printer profile. No current-value read or blank-only guard occurs on this path.
   - **Why it matters:** A reattach, parser correction, or stale local plate summary can replace manually curated HubSpot planning data. This conflicts with the repository’s blank-only auto-fill rule.
   - **Lean fix:** Read the relevant deal properties first, send only blank fields by default, and add an explicit owner-confirmed `overwrite` action for replacements. Add regression tests for blank, non-blank, and explicit-overwrite cases.

2. **All scheduled owner notifications default to Eastern time, not the owner’s Pacific time**
   - **Evidence:** `server/lib/owner-digest.ts:221,577`, `server/lib/health-digest-card.ts:187`, and `server/lib/health-nudge.ts:113` default to `America/New_York`; `.env.example:113-126` and `README.md:316-321` instruct the same value.
   - **Why it matters:** With the documented configuration omitted, a “7 AM” briefing and health nudge occur three hours early for the owner. Date keys and “today” labels can also fall on the wrong shop day.
   - **Lean fix:** Default all shop-facing schedules/card formatting to `America/Los_Angeles`, retain an environment override, update the docs, and add DST-boundary tests for both date keys and scheduled hours.

### Medium

3. **Library download tickets are reusable bearer credentials and stored in plaintext**
   - **Evidence:** `server/lib/plate-files.ts:555-570` saves a raw 24-byte ticket and only checks expiry; it neither consumes nor hashes it. `server/lib/plate-routes.ts:541-560` returns it as a URL query parameter, and the unauthenticated content endpoint accepts it at `server/lib/plate-routes.ts:559-590`.
   - **Why it matters:** Anyone who obtains the URL can repeatedly download the private uploaded slice for 15 minutes. Query credentials are especially easy to retain in browser history, proxy logs, and copied URLs; plaintext database tickets also become usable if the SQLite file is exposed.
   - **Lean fix:** Store a SHA-256 token hash, atomically delete/consume it on the first successful lookup, reduce TTL, and make the download request a same-origin POST or an authorization-header request instead of a query credential.

4. **The only destructive SQLite table migration has no explicit transaction or recovery point**
   - **Evidence:** `server/lib/order-links.ts:213-251` creates `order_parts_v2`, copies rows, drops `order_parts`, and renames the replacement through `sqlite.exec`, without an explicit transaction, backup, row-count assertion, or startup migration ledger.
   - **Why it matters:** Process termination, disk-full conditions, or a failed statement between copy/drop/rename can leave the operational table missing or partially migrated. It is the one migration path that can destroy source data rather than append columns.
   - **Lean fix:** Wrap the migration in `sqlite.transaction`, validate copied row counts before the drop, keep a one-time backup table until validation succeeds, and test an injected failure between each migration step.

5. **ShipStation refresh scales linearly and hides all refresh failures**
   - **Evidence:** `server/lib/shipstation.ts:176-189` loads every matching shipment, requests tracking one-at-a-time, and discards every error. The scheduler runs this full scan every two hours at `server/lib/shipstation.ts:232-235`; `listShipstationShipments` is unbounded at `server/lib/shipstation.ts:145`.
   - **Why it matters:** As label history grows, one timer run can make an unbounded number of third-party requests and run into the next interval. Silent failures leave shipment state stale with no health signal.
   - **Lean fix:** Query only a bounded, indexed set whose `updated_at` or next-refresh timestamp is due; use limited concurrency/backoff; persist and expose the last refresh error/count. Add tests for pagination and a per-run cap.

6. **Drive plate backfill is an unbounded, request-blocking remote scan**
   - **Evidence:** `server/lib/plate-routes.ts:438-447` awaits `backfillBlankLibraryPlates` in the owner request. `server/lib/plate-routes.ts:257-307` iterates all indexed files and may make one or two Google Drive range requests for each file.
   - **Why it matters:** A large library ties up an HTTP request for an arbitrary duration and can serially consume Drive quota. A browser retry repeats work.
   - **Lean fix:** Persist a cursor and run a bounded batch through the existing job mechanism; return a job ID/status, rate-limit Drive requests, and make each plate idempotent.

7. **Two directly imported packages are undeclared root dependencies**
   - **Evidence:** `server/lib/plate-mesh-surface.ts:5` imports `meshoptimizer/encoder` and `server/vite.ts:7` imports `nanoid`; neither appears in `package.json:16-109`. `npm ls meshoptimizer nanoid --depth=0` returns empty, proving they are only incidental transitives.
   - **Why it matters:** A legitimate update of `three`/Vite can remove or relocate the transitive package and break the build or runtime despite a green lockfile today.
   - **Lean fix:** Add the two packages as explicit direct dependencies at the versions actually used, or replace each use with a declared dependency/API. This adds no product behavior and makes the dependency contract reproducible.

8. **A parked Kits feature is dead product code but still ships and persists data**
   - **Evidence:** `client/src/App.tsx:62-65` explicitly says `kit-dry-run.tsx` and `/api/kits` are parked and must not be re-added. The 1,124-line `client/src/pages/kit-dry-run.tsx` remains, as do `client/src/lib/kit-api.ts:40-67`, `client/src/lib/kit-persistence.ts:6`, `server/routes.ts:1201-1249`, `server/lib/kits.ts`, schema/table code at `server/lib/order-links.ts:363-374`, and tests.
   - **Why it matters:** It creates two overlapping order/plate models, inflates maintenance and test surface, and retains an API that the visible product cannot reach.
   - **Lean fix:** After exporting or intentionally migrating any live `kits` data, delete the parked page/helpers/routes/table migration/tests. If the feature must return, move it to a separately owned, explicitly routed feature rather than carrying it dormant.

### Low

9. **`server/routes.ts` is an oversized composition root with duplicated owner-auth logic**
   - **Evidence:** `server/routes.ts` is 3,578 lines; it both defines 80+ endpoints and owns access-code functions at `server/routes.ts:490-589`. `server/lib/plate-routes.ts:146-162` implements a second near-identical access-code verifier. Route-module registration is already established at `server/routes.ts:1074,1088,1436,1438,1976,2595`.
   - **Why it matters:** Divergent auth behavior is likely over time (the main version accepts a body fallback and quoted values; the plate version does not), and route review is unnecessarily difficult.
   - **Lean fix:** Extract a single owner-auth middleware and move cohesive route groups out of `routes.ts`. Keep registration as a small composition root.

10. **Inactive direct dependencies are retained**
   - **Evidence:** repository-wide import/config search finds no use outside `package.json`/the stale build allowlist for `@hookform/resolvers`, `@jridgewell/trace-mapping`, `date-fns`, `next-themes`, `react-icons`, `tw-animate-css`, and `zod-validation-error`. The static search intentionally did not flag `tailwindcss-animate`, which is used by `tailwind.config.ts:107`.
   - **Why it matters:** These packages add maintenance, advisory, install, and lockfile surface. Their installed directory sizes total about 127 MB, dominated by `react-icons` (about 85 MB) and `date-fns` (about 38 MB).
   - **Lean fix:** Remove the seven confirmed unused declarations, regenerate the lockfile, and run build/test. Also delete their no-op references from `script/build.ts:7-31`.

11. **No regression tests cover the highest-risk overwrite and credential semantics**
   - **Evidence:** No test references `patchDealPrintFileMetrics`, `clearDealPrintFileMetrics`, `saveDownloadTicket`, `readDownloadTicket`, or `plate_download_tickets`. Search also found no direct test of `refreshShipstationTracking`.
   - **Why it matters:** Passing tests strongly cover existing UI/workflow behavior but do not protect the data-integrity and credential-lifetime defects above.
   - **Lean fix:** Add narrow unit/integration tests before modifying each path: non-blank HubSpot preservation, explicit overwrite, single-use/expired ticket behavior, and capped/retried ShipStation refresh.

## Discrepancies and documentation

- **Timezone discrepancy (high):** the shop requirement is Pacific, whereas all owner notification defaults and deployment snippets are Eastern (finding 2).
- **Dependency-contract discrepancy (medium):** `meshoptimizer` and `nanoid` are imported as application code but absent from root dependencies (finding 7).
- **State-model discrepancy (medium):** the application says Kits are parked, but leaves a full page, API, persistence model, and tests active (finding 8).
- **Build configuration drift (low):** `script/build.ts:7-31` contains an inherited allowlist for 19 packages, including packages not declared or used. It is misleading configuration rather than a currently observable bundle failure because the externals list is derived from declared dependencies.

I did not find evidence of an owner-only API route missing its access-code guard, an unsigned HubSpot webhook, client calls to absent APIs, money rounding defects, or a currently unhandled promise rejection that reaches a user-facing route. The review does not treat speculative possibilities as findings.

## Shrink the codebase

### Current size baseline

Source-line counts include `ts`, `tsx`, `js`, `jsx`, `css`, and `html`, excluding `node_modules`:

| Top-level directory | Lines |
| --- | ---:|
| `server/` | 32,720 |
| `client/` | 34,536 |
| `shared/` | 5,835 |
| `tests/` | 22,627 |
| `tools/` | 1,285 |
| `script/` | 68 |
| **Total selected source** | **97,071** |

The repository has 382 tracked files and 123,497 tracked lines including non-source files.

Largest 15 source files:

| Lines | File |
| ---:| --- |
| 3,578 | `server/routes.ts` |
| 2,501 | `shared/schema.ts` |
| 2,021 | `client/src/index.css` |
| 1,959 | `client/src/components/shipengine-buy-panel.tsx` |
| 1,820 | `tests/layout-alignment.test.ts` |
| 1,783 | `client/src/pages/prints.tsx` |
| 1,528 | `client/src/pages/order-links.tsx` |
| 1,261 | `server/lib/order-links.ts` |
| 1,152 | `server/lib/supply-invoice.ts` |
| 1,148 | `server/lib/ultx.ts` |
| 1,135 | `client/src/pages/shipping-labels.tsx` |
| 1,124 | `client/src/pages/kit-dry-run.tsx` |
| 1,117 | `server/lib/address-capture.ts` |
| 1,050 | `client/src/pages/paid-orders.tsx` |
| 995 | `client/src/components/deal-ops-panel.tsx` |

Dependency baseline: 72 production and 18 development direct dependencies (90 total); installed `node_modules` is 543 MB.

Production build baseline:

| Artifact | Parsed size | Gzip |
| --- | ---:| ---:|
| Main client JS | 1.94 MB | 539.8 KB |
| Order-origin map chunk | 255.6 KB | 88.6 KB |
| Client CSS | 117.0 KB | 20.5 KB |
| Server bundle | 3.31 MB | — |
| All emitted runtime artifacts | 5.75 MB | — |
| `dist/` including the ZIP centroid data | 9.1 MB | — |

### Concrete reduction candidates

| Change | Estimated saving | Risk | Basis |
| --- | ---:| --- | --- |
| Delete the parked Kits implementation after a data-retention decision | 1,300–1,900 source lines; 40–90 KB initial/client code estimate | Medium | 1,124-line page plus helpers, routes, schema, tests, and API |
| Extract shared owner auth and split route groups | 250–450 net lines; no material bundle change | Low | Removes duplicate verifier and makes existing route modules the norm |
| Remove seven verified unused direct dependencies and stale build-list entries | 7 manifests entries; about 127 MB installed tree; likely 0 client bytes because unused | Low | Exact repository search and installed sizes above |
| Make owner-only route pages lazy (`prints`, `labels`, `orders`, `paid-orders`, `library`, `printers`, `resin`, `supplies`, `stack`, etc.) | 200–450 KB gzip moved out of the first-load path; not removed | Medium | Only `performance` is route-lazy in `client/src/App.tsx:10-34`; main chunk is 539.8 KB gzip |
| Move the map behind its Stats interaction rather than initial Performance render | up to 88.6 KB gzip deferred | Low | `order-origin-map` is already a 255.6 KB async chunk; defer its loading until the map is opened |
| Split `shipengine-buy-panel.tsx`, `prints.tsx`, `order-links.tsx`, and `shipping-labels.tsx` into feature hooks/panels | 500–1,000 net lines after shared helpers; enables finer lazy chunks | Medium | Four production files are 1,135–1,959 lines |
| Consolidate `routes.ts` around existing route registrars | 300–600 lines moved/removed from composition root; no direct byte reduction | Low | 3,578-line route file and six existing registrars |
| Replace the destructive Kits migration/API with the live Parts/Plate Bits model | Included in Kits estimate; removes one duplicate model | Medium | App comment explicitly selects Parts + Prints plate bits instead |
| Bound/queue Drive backfill and ShipStation scans | Little code-size reduction; lower request/third-party work materially | Medium | Prevents repeated unbounded remote work (findings 5–6) |

Do not remove a dependency merely because it is large without verifying its import graph: `three`, `meshoptimizer`, map data, and the CTB/mesh path are feature dependencies. The recommended route splitting defers those costs; it does not claim to eliminate them.

## PR #240 compatibility

Open [PR #240](https://github.com/usercondition/HubSpotHost/pull/240), **“Add recurring expenses and safe cost fills,”** changes `client/src/pages/expenses.tsx`, `client/src/pages/performance.tsx`, `server/lib/deal-ops.ts`, `server/lib/expense-routes.ts`, `server/lib/expenses.ts`, `server/lib/order-links.ts`, `server/routes.ts`, `shared/expenses.ts`, `shared/shop-dashboard.ts`, and related tests.

It will conflict textually with any route splitting (`server/routes.ts`), SQLite migration hardening (`server/lib/order-links.ts`), or expense refactor. It directly overlaps the audit’s blank-only HubSpot-write concern in `server/lib/deal-ops.ts` and its expense/state-model analysis. Rebase #240 first; preserve its stated blank-only cost-fill behavior when addressing finding 1.

## Prioritized top-10 fix plan

### Batch 1 — protect data and customer files
1. Make slice-metric HubSpot writes blank-only, with explicit overwrite confirmation and tests.
2. Make download tickets hashed and single-use; stop putting bearer credentials in query strings.
3. Transactionalize the `order_parts` table-rebuild migration and add failure-recovery tests.

### Batch 2 — correct shop time and operational scale
4. Change owner notification defaults/docs/tests to `America/Los_Angeles`.
5. Bound and persist cursor/error state for ShipStation tracking refresh.
6. Convert Drive library backfill to a bounded resumable background job.

### Batch 3 — shrink and simplify
7. Remove the parked Kits page/API/schema after a migration/retention decision.
8. Consolidate owner authentication and split `server/routes.ts` into route modules.
9. Remove confirmed-unused dependencies and stale build allowlist entries; declare `meshoptimizer` and `nanoid` directly if retaining their imports.

### Batch 4 — improve first-load efficiency and safety net
10. Lazy-load owner route pages, then add bundle-budget reporting and regression tests for HubSpot preservation, ticket one-time use, and ShipStation refresh bounds.
