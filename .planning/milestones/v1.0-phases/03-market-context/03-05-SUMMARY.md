---
phase: 03-market-context
plan: 05
subsystem: api
tags: [server-action, supabase, market-context, sold-price, scb, deterministic, partial-data]

# Dependency graph
requires:
  - phase: 03-02
    provides: market_* / *_data columns + status state-machine on analyses (migration 003)
  - phase: 03-03
    provides: resolveGeo (lat/lng → DeSO/kommun) + fetchScbDemographics + AreaData
  - phase: 03-04
    provides: fetchSoldComps + normalizeSoldOutput + computePriceComparison + soldSourceCostSek + PriceData
provides:
  - enrichMarketContext(analysisId) server action — the Phase 3 orchestration spine
  - Independent per-panel persistence of price_data / area_data (D-08)
  - Honest price reasons: source_unavailable (dead source) vs thin (real sparse) vs listing_pris_okand (0 pris/kvm)
  - Bounded (<=3 call) tiered sold-source fetch-walk with recency+count short-circuit
affects: [03-06, market-panel-ui, price-panel, area-panel]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-branch independent try/catch persistence (D-08): one external source failing never blanks the other panel"
    - "Honest-state discriminator owned at the action layer: a dead source (source_unavailable) is never conflated with a real sparse area (thin)"
    - "Bounded fetch-walk: <=3 source calls/analysis, short-circuit at first tier with enough RECENT usable comps (recency+count, not totalCount)"

key-files:
  created:
    - src/actions/enrich-market-context.ts
  modified: []

key-decisions:
  - "Walk-up trigger is recency+count (recentUsableCount over a 365-day window > thinMaxComps), not raw count — the SPIKE showed thinness manifests as stale comps, not empty results"
  - "No-coords old rows: PRICE side persists source_unavailable (no areaId ladder to query) while AREA side degrades to a kommun-baseline geo (resolveGeo skipped, metrics null) — no backfill, no crash"
  - "market_status 'done' on ANY partial success (priceUsable = reason != source_unavailable, OR areaUsable = >=1 metric present); 'failed' only when nothing usable persists; never left null after running"
  - "Cost gate sits before persist (renders=0 on pre-guard/no-coords/no-fetch paths → 0 SEK); the SPEND itself is bounded by MAX_SOURCE_CALLS=3 independently of the persist gate"

patterns-established:
  - "EnrichMarketResult discriminated union mirrors AnalyzeBrfResult; auth+ownership gate copied verbatim from analyze-brf.ts:175-193"
  - "writeFailedStatus observable-terminal-status helper mirrors analyze-brf.ts; market_status null reserved for never-enriched"

requirements-completed: [PRICE-01, AREA-01]

# Metrics
duration: 2min
completed: 2026-06-20
---

# Phase 3 Plan 05: enrichMarketContext Spine Summary

**The Phase 3 controller `enrichMarketContext(analysisId)` — auth + owner-only gate → resolveGeo → bounded tiered sold-source walk + SCB demographics → deterministic compute → independent persistence of `price_data`/`area_data`, with honest source_unavailable / thin / listing_pris_okand reasons and an observable terminal `market_status`.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-06-20T19:29:20Z
- **Completed:** 2026-06-20T19:31:21Z
- **Tasks:** 1
- **Files modified:** 1 (created)

## Accomplishments

- Created `src/actions/enrich-market-context.ts` mirroring the `analyze-brf.ts` spine: auth gate (`getUser`) → ownership check (`row.user_id === user.id`, defence-in-depth behind RLS) → `market_status: "fetching"` → external fetch → cost gate → independent persist → terminal status.
- Wired all upstream Plan 03/04 cores: `resolveGeo`, `fetchSoldComps` + `normalizeSoldOutput`, `computePriceComparison`, `soldSourceCostSek` + `SOLD_SOURCE_COST_CAP_SEK`, `fetchScbDemographics`, and the extended `listingDataSchema`.
- `npx tsc --noEmit` clean; full `npx vitest run` GREEN (56 passed, 6 todo, 9 files) — no regressions, no live network calls in tests.

## How the key behaviours are implemented

### Tiered sold-source fetch-walk + the <=3-call bound

`walkSoldTiers()` iterates `TIER_LADDER = [building, neighborhood, wide]` (narrow→wide). Each iteration increments a `renders` counter and is hard-capped by `MAX_SOURCE_CALLS = 3` (`if (renders >= MAX_SOURCE_CALLS) break`). After each tier's `fetchSoldComps` → `normalizeSoldOutput`, it computes `recentUsableCount(comps, nowMs)` — usable comps (finite pris/kvm > 0) with a parseable `soldDate` inside a 365-day window — and **short-circuits at the first tier whose recent usable count exceeds `PRICE_COMPARISON_THRESHOLDS.thinMaxComps` (2)**. This implements the SPIKE's "trigger the walk-up on recency + count, NOT on totalCount" finding (03-SPIKE.md §1.4: a sparse locality returns a full page but reaches back ~17 months). The walk therefore bills at most 3 renders and usually 1.

If no tier is "sufficient" but at least one tier fetched, the last (widest) attempt's comps are returned so `computePriceComparison` can tag a **real** sparse area as `thin`. Only when **every** attempted tier failed to fetch does the walk rethrow — the caller maps that to `source_unavailable`.

### Independent persistence (D-08 / Success Criterion 3)

The PRICE and AREA branches are structured as two separate `try/catch` blocks producing `price: PriceData | null` and `area: AreaData | null` independently. A single `.update({ price_data, area_data, market_status, market_source, market_cost_sek })` writes both columns — each is written even when the other is null/source_unavailable. A dead sold source persists `price_data.reason = "source_unavailable"` while `area_data` is still written; an SCB failure sets `area = null` without touching the price branch.

### source_unavailable vs thin vs listing_pris_okand

- **listing_pris_okand** (HIGH-3): a pre-guard reads `listing.prisPerKvm`; if 0/null/non-finite it builds a `listingPrisOkandPrice()` (no ±%, deltaPct null) and **skips the fetch-walk entirely** — never spends a render and never feeds a 0 figure into `computePriceComparison` (the false −100% bug). `compare.ts` guards this too; the pre-guard is the spend-saving belt-and-braces.
- **source_unavailable** (HIGH-1): the `catch` around `walkSoldTiers` sets `sourceUnavailablePrice()` — a distinct dead-source state, NOT thin, NOT null. Also set when an old row has no coords (no areaId ladder → the source is structurally unreachable). Logged with ids + error code only.
- **thin / ok**: owned by `compare.ts` from a REAL fetched result; this action passes its `reason` through verbatim.

### Cost cap value + gate

`soldSourceCostSek({ renders })` is computed from the walk's render count, then gated against `SOLD_SOURCE_COST_CAP_SEK = 1.0 SEK` **before persistence** (mirrors analyze-brf.ts:250-256). Pre-guard / no-coords / no-fetch paths have `renders = 0` → 0 cost. The spend itself is independently bounded by `MAX_SOURCE_CALLS`, closing the reviewer's "cap is only on persist" gap (T-03-17).

### Older-row degrade path

When the listing has no usable lat/lng (`hasCoords` false), `resolveGeo` is skipped and `geo` is set to `{ kommunCode: null, desoCode: null }`. `fetchScbDemographics` then returns its kommun-baseline `AreaData` (metrics null) per its own contract — no backfill, no crash (RESEARCH Open Q3, D-06). The PRICE side persists `source_unavailable` for the same row since there is no areaId ladder.

### Terminal status

`priceUsable = price != null && price.reason !== "source_unavailable"`; `areaUsable = areaHasUsableData(area)` (>=1 of population/age/income/tenure present). `market_status = "done"` when either is usable, else `"failed"` via the observable `writeFailedStatus` helper. `market_status` is never left null after running (null = never-enriched fetch affordance).

## Deviations from Plan

None — plan executed exactly as written. One unused helper (`usableCount`) was introduced and immediately removed in favour of `recentUsableCount` (the recency+count walk trigger) before commit; no functional impact.

## Verification

- `npx tsc --noEmit` → no errors (TYPES-OK).
- `npx vitest run src/lib/market` → 4 files, 22 tests passed.
- `npx vitest run` (full) → 9 files, 56 passed, 6 todo. No regressions.
- `npx eslint src/actions/enrich-market-context.ts` → 0 errors, 0 warnings.
- Grep gates: AUTH-GATE-PRESENT, SOURCE-UNAVAIL-OK, `.update(` count = 3 (fetching, failed-status, persist).

## Known Stubs

None.

## Self-Check: PASSED

- FOUND: src/actions/enrich-market-context.ts
- FOUND: .planning/phases/03-market-context/03-05-SUMMARY.md
- FOUND: commit 31fd64a
