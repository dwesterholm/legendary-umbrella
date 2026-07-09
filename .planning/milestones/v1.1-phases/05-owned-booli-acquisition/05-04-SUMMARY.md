---
phase: 05-owned-booli-acquisition
plan: 04
subsystem: api
tags: [apify, playwright, apollo-cache, booli, ssrf, zod]

# Dependency graph
requires:
  - phase: 05-owned-booli-acquisition (Plan 01-03)
    provides: shared ApifyClient mock (__mocks__/apify-client.ts), redacted Listing fixture (__fixtures__/listing-detail.json), runPlaywrightRender + APOLLO_PAGE_FUNCTION transport, walkFallbackTree observability layer
provides:
  - "fetchListing(url) — ACQ-01: owned single-listing fetch, SSRF-guarded, fallback-tree-routed, scrapeBooli-compatible raw shape"
  - "fetchAreaListings(areaId, objectType?) — ACQ-02: owned area-search fetch, URLSearchParams-built URL, multi-entity extraction"
  - "Listing: Apollo entity extraction + reshape, reusing sold-schema.ts's dataPointsOf deterministic variant-selection pattern"
affects: [05-05 (analyze.ts call-site swap), 06-deeper-listing-extraction, 09-discovery-foundation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reshape-before-normalize: raw Apollo entity -> flat Record<string, unknown> (client.ts) -> normalizeScraperOutput (listing.ts, unchanged) — keeps the no-op-migration contract"
    - "Rung composition without a rung 3 when the paid actor's shape doesn't fit (fetchAreaListings has only 2 rungs — documented, not silently degraded)"

key-files:
  created:
    - src/lib/booli/client.ts
    - src/lib/booli/client.test.ts
  modified:
    - src/lib/booli/__mocks__/apify-client.ts

key-decisions:
  - "Fixed the shared ApifyClient mock's constructor bug (arrow fn in mockImplementation cannot be invoked with `new`) on first real use — Rule 1 auto-fix, not in scope of Plan 01 originally but blocking for this plan"
  - "fetchAreaListings has NO rung 3: scrapeBooli is single-listing shaped and cannot serve an area query; wrapping its output as [single] would misrepresent an area result, so area search degrades to the two own-render rungs only and throws (HIGH-1) if both fail"
  - "Reshape function returns undefined (not null) for absent fields, matching scraperOutputSchema's .optional() fields rather than listingDataSchema's .nullable() fields — undefined keys are dropped by zod's safeParse the same way missing keys are"

requirements-completed: [ACQ-01, ACQ-02]

# Metrics
duration: 35min
completed: 2026-07-06
---

# Phase 05 Plan 04: Unified Owned Client (fetchListing + fetchAreaListings) Summary

**fetchListing(url) and fetchAreaListings(areaId, objectType?) in src/lib/booli/client.ts, both routed through walkFallbackTree with the pinned `Listing:` Apollo prefix extraction reshaping into the scrapeBooli-compatible flat shape**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-06T15:05:00Z (approx, context load)
- **Completed:** 2026-07-06T15:40:21Z
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 fixed)

## Accomplishments

- `fetchListing(url)` (ACQ-01): SSRF-allowlisted (`booli.se/` check before any actor call), routes rung1 own-playwright → rung2 own-playwright-retry → rung3 `scrapeBooli` through `walkFallbackTree`, extracts the empirically-pinned `Listing:` Apollo entity (05-PROBE-FINDINGS.md), and reshapes it into the exact `Record<string, unknown>` shape `scrapeBooli()` returns today.
- `fetchAreaListings(areaId, objectType?)` (ACQ-02): builds `https://www.booli.se/sok/till-salu?areaIds=<N>[&objectType=<encoded>]` via `URLSearchParams` (never manual concat), extracts EVERY `Listing:` entity from one Apollo blob into an array, routes through the same fallback tree — with an explicit, documented decision that area search has only 2 rungs (no paid-actor fallback, since `scrapeBooli` is single-listing shaped).
- Reused `sold-schema.ts`'s `dataPointsOf` deterministic sort + preferred-variant + merge pattern (the WR-05 fix) for the `Listing:` entity's multi-variant `displayAttributes({...})` arg-keyed fields — verified via a regression test that inserts variants in an order that would trip a naive first-match walk.
- Fixed a real bug in the shared `apify-client` mock (Plan 01 artifact, first exercised by this plan): `vi.fn().mockImplementation(() => ({...}))` produces a function that cannot be invoked with `new`, and every production call site does `new ApifyClient(...)`. Switched to a `function` expression.

## Task Commits

Each task was committed atomically:

1. **Task 1: fetchListing + Listing: Apollo extraction (ACQ-01)** - `26ca86e` (feat)
2. **Task 2: fetchAreaListings (ACQ-02)** - `5321abd` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `src/lib/booli/client.ts` - `fetchListing`, `fetchAreaListings`, `extractListingEntity`, `extractListingEntities`, `collectListingEntities`, `reshapeListingEntity`, `buildTillSaluUrl`, `dataPointsOf`, coercion helpers (`num`/`str`/`rawOf`/`idStr`/`crumbs`)
- `src/lib/booli/client.test.ts` - 10 tests: fetchListing Apollo extraction against the real fixture, SSRF rejection, multi-variant `displayAttributes` determinism, rung-order (scrapeBooli only after both own renders throw), rung-3-output-identity; fetchAreaListings URL building (with/without objectType), multi-entity extraction, rung fallthrough, HIGH-1 exhaustion throw
- `src/lib/booli/__mocks__/apify-client.ts` - fixed `ApifyClient` mock constructor bug (arrow fn -> function expression)

## Decisions Made

- **No rung 3 for `fetchAreaListings`.** `scrapeBooli` fetches exactly one listing by URL; there is no way to make it answer "every listing in area X" without either faking a result shape (misleading) or picking an arbitrary single URL (wrong semantics). Per 05-RESEARCH.md's framing of this as a decision-and-comment point, area search degrades to the two own-render rungs only. A dead area search throws (HIGH-1 discipline — mirrors `sold-source.ts`'s "never return `[]` to mean dead source").
- **`reshapeListingEntity` sets absent fields to `undefined`, not `null`.** `scraperOutputSchema` (listing.ts) declares every field `.optional()`, not `.nullable()` — `undefined` values are indistinguishable from omitted keys under `zod`'s `safeParse`, matching what `scrapeBooli()`'s real output looks like (the actor never emits an explicit `null` for a missing field either).
- **Bonus fields surfaced but not required.** `floor`, `amenities`, `listingUrl`/`agencyListingUrl`, `agencyName`, and `displayDataPoints` are passed through in the reshaped object even though `scraperOutputSchema`'s `.passthrough()` doesn't require them — 05-PROBE-FINDINGS.md flagged these as materially de-risking Phase 6, so exposing them now costs nothing and avoids a second reshape pass later.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed `apify-client` mock's `ApifyClient` constructor**
- **Found during:** Task 1, first test run
- **Issue:** `src/lib/booli/__mocks__/apify-client.ts`'s `apifyClientMockFactory` used `vi.fn().mockImplementation(() => ({ actor: ..., dataset: ... }))`. Every production call site (`transport.ts`, `sold-source.ts`, `booli-scraper.ts`) does `new ApifyClient({...})`. An arrow function assigned as a mock implementation cannot be invoked with `new` — Vitest throws `TypeError: ... is not a constructor`. This mock had never been exercised before (05-PATTERNS.md explicitly flagged it as "no analog... net-new, Wave 0 gap" and no prior test used it), so the bug was latent until this plan's `client.test.ts` became the first real caller.
- **Fix:** Changed the mock implementation to a `function` expression (`function () { return {...}; }`), which CAN be invoked with `new` in JavaScript. Also fixed the two doc-comment usage examples in the same file (`vi.mock("apify-client", apifyClientMockFactory)` → `vi.mock("apify-client", () => apifyClientMockFactory())`), since passing the factory reference directly to `vi.mock`'s second argument also hits a hoisting TDZ error (`vi.mock` calls are hoisted above all imports, so the imported `apifyClientMockFactory` identifier isn't initialized yet at hoist-time; wrapping in an arrow function defers the reference until the mock factory actually runs).
- **Files modified:** `src/lib/booli/__mocks__/apify-client.ts`
- **Commit:** `26ca86e`

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Necessary correctness fix to unblock this plan's tests (and every future `booli/` test that imports the shared mock). No scope creep — the fix is confined to the mock file's `ApifyClient` factory + its own doc comments.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required. No new packages added (`apify-client` was already a dependency, per the plan's threat model T-05-SC).

## Return-Shape Contract (for Plan 05)

`fetchListing(url)`'s return type is `Promise<Record<string, unknown>>` — IDENTICAL to `scrapeBooli(url)`'s return type today. Field names populated by the reshape (`streetAddress`, `price`, `listPrice`, `livingArea`, `rooms`, `rent`, `listRent`, `constructionYear`, `listSqmPrice`, `latitude`, `longitude`, `booliId`, `breadcrumbs`, `objectType`, `tenureForm`, `url`, `descriptiveAreaName`, plus bonus `listingUrl`/`agencyListingUrl`/`agencyName`/`floor`/`amenities`/`displayDataPoints`) match exactly what `normalizeScraperOutput` (`src/lib/schemas/listing.ts`, unmodified) reads. Plan 05's call-site swap in `src/actions/analyze.ts` is therefore a straight import + call-site rename:

```ts
// Before:
import { scrapeBooli } from "@/lib/apify/booli-scraper";
rawData = await scrapeBooli(url);

// After:
import { fetchListing } from "@/lib/booli/client";
rawData = await fetchListing(url);
```

No changes to `normalizeScraperOutput`, `scraperOutputSchema`, or any downstream field-mapping code are required.

## Next Phase Readiness

Plan 05 can proceed immediately: `fetchListing` and `fetchAreaListings` are both implemented, tested (15/15 green in `src/lib/booli/`), typecheck-clean (`npx tsc --noEmit` zero errors), and the full suite is green (198 passed, 1 skipped, 6 todo — no regressions). No blockers.

---
*Phase: 05-owned-booli-acquisition*
*Completed: 2026-07-06*

## Self-Check: PASSED
