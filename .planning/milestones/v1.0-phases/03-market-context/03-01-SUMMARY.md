---
phase: 03-market-context
plan: 01
subsystem: testing
tags: [booli, slutpriser, apify, playwright, cloudflare, scb, json-stat2, zod, vitest, tdd]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: APIFY_API_TOKEN + booli-scraper.ts browser transport (RESIDENTIAL/SE proxy)
  - phase: 02-brf-analysis
    provides: src/lib/brf/{score,cost}.test.ts RED-first precedent; src/lib/schemas/listing.ts normalize layer
provides:
  - "Validated, in-budget sold-price source (Booli SSR __NEXT_DATA__ via Apify Playwright headless browser) — overturns the earlier Cloudflare blocker; PRICE-01 ships in FULL"
  - "Working request recipe (URL/areaIds/pagination/objectType + transport) + per-sale Apollo paths + the {label,url}[] breadcrumbs ladder pinned in 03-SPIKE.md"
  - "SCB DeSO-availability resolved: population/income/tenure all DeSO-level (income lags one year) — A3 resolved"
  - "RED deterministic-core test contracts for compare/geo/scb/cost (incl. HIGH-3 + areaAvg-NaN guards)"
  - "listing schema retains latitude/longitude/booliId/breadcrumbs — the join key for both Phase 3 panels"
  - "Two offline fixtures: real redacted sold-comps.json + json-stat2 scb-population.json"
affects: [03-02 compare/sold-source build (Plan 04), 03-area-stats (geo/scb), 03-methodology (Plan 05), 03-wiring (Plan 06 live gate)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SSR __NEXT_DATA__ → __APOLLO_STATE__ read via a CF-clearing headless browser (NOT the GraphQL API)"
    - "RED-first deterministic-core tests written before production modules (mirrors Phase 2 Wave 0)"
    - "Null-tolerant normalize: every retained field falls back to null, never throws"

key-files:
  created:
    - .planning/phases/03-market-context/03-SPIKE.md
    - src/lib/market/compare.test.ts
    - src/lib/market/geo.test.ts
    - src/lib/market/scb.test.ts
    - src/lib/market/cost.test.ts
    - src/lib/market/__fixtures__/scb-population.json
  modified:
    - src/lib/market/__fixtures__/sold-comps.json
    - src/lib/schemas/listing.ts
    - src/actions/analyze.ts

key-decisions:
  - "Sold source = Booli SSR HTML (__NEXT_DATA__) via apify/playwright-scraper + RESIDENTIAL/SE, NOT the GraphQL API (separate stricter CF zone). A raw fetch even via the proxy is 403; a real browser is mandatory."
  - "Trigger D-01 tier walk-up on recency+count, not totalCount — sparse-locality thinness manifests as stale comps, not empty results."
  - "breadcrumbs modelled as { label?: string; url?: string }[] | null (spike-confirmed two keys); ladder comes from the listing DETAIL page, not the SERP."
  - "SCB queries each metric's own latest year (income lags population/tenure by one year); no uniform-latest-year assumption."

patterns-established:
  - "SSR-HTML read pattern: read server-rendered Apollo state behind a CF-clearing browser instead of fighting the API's anti-bot wall"
  - "Headline-poisoning guards locked in RED before impl: listingPrisPerKvm<=0/null → reason 'listing_pris_okand' deltaPct null; all-null comps → 'thin', areaAvg never NaN/Infinity"

requirements-completed: [PRICE-01, AREA-01]

# Metrics
duration: ~35min
completed: 2026-06-20
---

# Phase 3 Plan 01: Market-Context Wave-0 Spike + RED Scaffold Summary

**Overturned the sold-source Cloudflare blocker — Booli server-renders full slutpriser into the page HTML, read via an Apify Playwright headless browser (~$18/mo worst case) — then locked the compare/geo/scb/cost deterministic contracts as RED tests and extended the listing schema to retain coords/booliId/breadcrumbs as the panel join key.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-06-20
- **Tasks:** 3 (Task 1 was the human-verify checkpoint, approved before this continuation)
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments

- **Sold-source UNBLOCKED + validated GO.** The earlier blocker (keyless `searchSold` GraphQL behind a Cloudflare managed challenge) is moot: Booli server-renders every comp into `__NEXT_DATA__ → __APOLLO_STATE__`. The working recipe (`/sok/slutpriser?areaIds=<N>`, 35 comps/page, optional `objectType`, `totalCount` in `ROOT_QUERY`) via `apify/playwright-scraper` chromium + RESIDENTIAL/SE proxy returns 200 with full data. Robustness validated across country→street tiers; cost ~$0.0055/render, worst case ~$18/mo at 800 analyses. **PRICE-01 ships in FULL.**
- **Real fixture promoted.** Replaced the mock with a real, redacted 35-comp payload from Nacka (`areaIds=76`) in the raw `SoldProperty` Apollo shape, including one null-price record for the null-tolerant guard tests. Scrubbed all PII (addresses, lat/lng, urls, images, screenReaderLabel street numbers).
- **SCB A3 resolved.** Population (2025), income (2024), tenure (2025) are all DeSO-available; income lags one year. Plans 03/05/06 treat DeSO four-metric data as the normal path.
- **Four RED test files + json-stat2 fixture.** compare/geo/scb/cost contracts pinned (incl. HIGH-3 `listingPrisPerKvm<=0`/null guard and the areaAvg-NaN all-null-pris/kvm guard). All fail on absent `@/lib/market/*` modules; no live network calls in tests.
- **Listing schema retains the join key.** `latitude`/`longitude`/`booliId`/`breadcrumbs` (the spike-pinned `{label?,url?}[]` shape) now survive `normalizeScraperOutput` into `analyses.listing_data` on new scrapes.

## Task Commits

1. **Task 1a: rewrite 03-SPIKE.md (working source)** - `a40b51e` (docs)
2. **Task 1b: promote real sold-comps fixture + remove __probe__/** - `e705597` (test)
3. **Task 2: RED tests for compare/geo/scb/cost + scb-population fixture** - `c852f56` (test)
4. **Task 3: retain coords/booliId/breadcrumbs in listing schema** - `0512ed1` (feat)

_The A1 scratch docs (`03-SPIKE-A1-ssr.md`, `03-SPIKE-A1-validation.md`) were untracked; their evidence was folded into 03-SPIKE.md and the files deleted — no separate commit needed._

## Files Created/Modified

- `.planning/phases/03-market-context/03-SPIKE.md` - Canonical sold-source decision (working SSR recipe, transport, per-sale Apollo paths, areaId+breadcrumbs ladder, cost table, SCB DeSO-availability, monitored risks, documented fallbacks)
- `src/lib/market/__fixtures__/sold-comps.json` - Real redacted 35-comp payload (raw SoldProperty Apollo shape + Area_V3:76)
- `src/lib/market/__fixtures__/scb-population.json` - Minimal valid json-stat2 fixture (income intentionally absent for the metric-absent case)
- `src/lib/market/compare.test.ts` - RED tests for computePriceComparison (±%, tier, confidence, trend, distribution, thin-data, HIGH-3, areaAvg-NaN)
- `src/lib/market/geo.test.ts` - RED tests for resolveGeo (kommun prefix + point-in-polygon + outside-all degrade)
- `src/lib/market/scb.test.ts` - RED tests for normalizeScbOutput (json-stat2 → four metrics, metric-absent → null, malformed-tolerant)
- `src/lib/market/cost.test.ts` - RED tests for soldSourceCostSek + USD_SEK_RATE + SOLD_SOURCE_COST_CAP_SEK
- `src/lib/schemas/listing.ts` - Added nullable latitude/longitude/booliId/breadcrumbs to NormalizedListing, listingDataSchema, ListingData; breadcrumbSchema; normalize mappings
- `src/actions/analyze.ts` - Threaded the four new fields into the ListingData insert

## Decisions Made

- **Sold source = SSR HTML, not GraphQL.** The `/graphql` endpoint is a separate, stricter CF managed-challenge zone; the page HTML already carries every comp. We read `__APOLLO_STATE__` behind a CF-clearing browser.
- **A real browser is mandatory transport.** Raw fetch, even via the Apify RESIDENTIAL/SE proxy, returns 403; only `apify/playwright-scraper` clears CF. `maxRequestRetries >= 1` (one transient proxy blip self-healed).
- **D-01 walk-up triggers on recency+count.** Sparse localities return a full page but reach back ~17 months; thinness is staleness, not emptiness.
- **breadcrumbs shape pinned to `{ label?, url? }[] | null`** and sourced from the detail page (SERP Listing objects lack it).
- **SCB per-metric latest year** (income lags by one year) — no uniform-latest-year assumption.

## Deviations from Plan

None — plan executed exactly as written (Tasks 2 and 3 per 03-01-PLAN.md; Task 1 was the approved checkpoint, completed here per the continuation directive that overturned the earlier blocker conclusion).

## TDD Gate Compliance

Task 2 is the plan's RED phase. The four `test(...)` commits/files (in `c852f56`) intentionally FAIL on absent `@/lib/market/*` modules — verified via `npx vitest run src/lib/market` ("Cannot find package", 4 failed). The GREEN phase (implementing compare/geo/scb/cost) belongs to Plan 04 and downstream plans, by design — this plan is a deliberate RED-only scaffold mirroring the Phase 2 Wave-0 precedent. No premature implementation was added.

## Issues Encountered

- The plan's RED verify grep pattern (`cannot find module|...|0 passed`) did not literally match vitest's phrasing ("Cannot find package" + "4 failed"). The RED state is unambiguous (all four import the not-yet-built modules and fail); confirmed with a broader grep matching the actual output. No code change needed.

## Known Stubs

None. The two fixtures are real/representative offline test data (one is a live-captured redacted payload; the json-stat2 fixture is a documented minimal hand-author with income deliberately absent to exercise the metric-absent path). The RED test files reference production modules that are intentionally absent (RED phase), not stubs.

## User Setup Required

None — no external service configuration required. The SSR-HTML path is keyless; only the already-configured `APIFY_API_TOKEN` is involved (Apify Playwright transport + RESIDENTIAL/SE proxy). No new env var, no `next.config.ts serverExternalPackages` change.

## Next Phase Readiness

- **Plan 04 (sold-source + compare) is unblocked:** the working recipe, attributes, areaId/breadcrumbs ladder, cost model, and a real offline fixture are all in 03-SPIKE.md + `sold-comps.json`. The compare RED tests pin the contract to implement (incl. headline-poisoning guards).
- **geo/scb plans:** SCB DeSO availability is resolved; the json-stat2 fixture + scb RED tests pin the normalize contract. `@turf/*` install remains gated behind a human-verify checkpoint in its consuming plan.
- **Join key in place:** new scrapes persist coords/booliId/breadcrumbs; existing rows lack them and must degrade gracefully (kommun-baseline / "begränsad platsdata") — no backfill.
- **Monitored risk:** CF/transport fragility — alert on `hasApollo === false` / non-200 and cache aggressively.

## Self-Check: PASSED

All created files exist on disk (03-SPIKE.md, 03-01-SUMMARY.md, four market test files, scb-population.json, sold-comps.json); scratch docs + __probe__/ removed; all four task commits present (a40b51e, e705597, c852f56, 0512ed1).

---
*Phase: 03-market-context*
*Completed: 2026-06-20*
