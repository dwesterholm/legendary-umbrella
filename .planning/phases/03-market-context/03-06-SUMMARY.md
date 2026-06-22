---
phase: 03-market-context
plan: 06
subsystem: ui
tags: [react, server-components, next, supabase, scb, booli, market-context]

# Dependency graph
requires:
  - phase: 03-market-context (03-05)
    provides: enrichMarketContext server action; persisted price_data/area_data jsonb; market_status
  - phase: 03-market-context (03-03/03-04)
    provides: PriceData/AreaData schemas, safeParsePriceData/safeParseAreaData, deterministic compute
  - phase: 02-brf-financial-analysis (02-06)
    provides: BRF visual language (brf-score-card.tsx headline banner, source reveal, confidence badge); MetricCard idiom (listing-summary.tsx)
provides:
  - PriceComparisonCard — ±% headline, comp-list receipt, sample/tier/distribution, confidence, source label, "ej värdering" disclaimer; four distinct honest reason states
  - AreaStatsCard — four SCB demographics metric cards + geo-level label + "Källa: SCB" + freshness
  - MarketContextSection — client orchestrator, independent per-panel degrade, enrich trigger (owner-only)
  - analysis page wiring — safeParsePriceData/safeParseAreaData reads, replaces the two ComingSoonSection placeholders, keeps AI Rapport
affects: [04-ai-report, phase-4-synthesis]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server card + small client reveal: cards are server components rendering persisted values; only the comp-list <details>/<summary> reveal is client (no recomputation in the component)"
    - "Reason-enum render branching: PriceComparisonCard branches on priceData.reason BEFORE rendering a headline — ok/thin/source_unavailable/listing_pris_okand each render a distinct honest state (HIGH-1/HIGH-3)"
    - "Independent per-panel degrade: one null source never blanks the other (Success Criterion 3 / D-08)"

key-files:
  created:
    - src/components/price-comparison-card.tsx
    - src/components/area-stats-card.tsx
    - src/components/market-context-section.tsx
  modified:
    - src/app/(app)/analysis/[id]/page.tsx
    - src/lib/market/sold-source.ts
    - src/lib/market/scb-client.ts
    - src/lib/geo/resolve-geo.ts
    - next.config.ts

key-decisions:
  - "Cards are server components with a small client sub-component for the comp-list reveal (PATTERNS line 132) — far less interactivity than the fully-client BrfScoreCard"
  - "PriceComparisonCard branches on priceData.reason: source_unavailable renders a DISTINCT neutral 'Prisjämförelse ej tillgänglig' message, never collapsed into the thin-data 'för få försäljningar' marker (HIGH-1); listing_pris_okand shows 'pris/kvm saknas för objektet', never a −100 % headline (HIGH-3)"
  - "Panels are owner-only by construction — the page renders only for a persisted analysis row, which exists only for an authenticated owner (analyze.ts:96-124); no isGuest prop, no separate login wall (HIGH-2)"
  - "Apify scrapers absorb cold-start: waitSecs 60→240 + run.status SUCCEEDED guard (live-gate fix 822d433); maxRequestRetries 1→3 for Booli's intermittent 403 (f3fcb1a)"
  - "deso.geojson loaded via process.cwd() + outputFileTracingIncludes so the polygon ships in the Next server bundle at runtime (live-gate fix c9d599b)"

patterns-established:
  - "Reason-enum render branching for honest partial-data states over a persisted enum (render decision, not recomputation)"
  - "Independent per-panel degrade in a client orchestrator mirroring brf-section.tsx initialView"

requirements-completed: [PRICE-01, AREA-01]

# Metrics
duration: ~90min (incl. live-gate debugging across 5 fixes)
completed: 2026-06-22
---

# Phase 3 Plan 06: Market-Context UI Panels Summary

**Two live market panels wired into the analysis page — a real Booli sold-comps price comparison (±% headline, comp-list receipt, sample/tier/distribution, confidence) and four live SCB DeSO demographics metrics — with distinct honest states for dead/thin/missing-price sources and independent per-panel degrade.**

## Performance

- **Duration:** ~90 min (including live-gate debugging across 5 fixes)
- **Tasks:** 3 (2 auto + 1 human-verify gate)
- **Files modified:** 8 (3 created, 5 modified)

## Accomplishments

- **PRICE-01 satisfied in FULL (live, not mock).** The human live-gate confirmed a genuine end-to-end comparison: `slutpriser?areaIds=115341` returned 35 sold comps (`hasApollo true`) → reason `"ok"`, with the ±% headline, the "Visa jämförda försäljningar" comp-list receipt (real dates + pris/kvm), sample size + tier, distribution range, confidence badge, source+freshness label, and the "ej värdering" disclaimer. This is NOT the mock fixture — the live Booli SSR source path works.
- **AREA-01 satisfied (live DeSO).** The SCB panel renders four real demographics metrics for Södermalm DeSO `0180C3130` (population 1616, median income 414.7k, age distribution, tenure/ownership mix), with the geo-level label and "Källa: SCB" + per-metric year.
- **Distinct honest price states (HIGH-1/HIGH-3).** PriceComparisonCard branches on `priceData.reason` so `source_unavailable` ("Prisjämförelse ej tillgänglig") is visually distinct from the thin-data "för få försäljningar" marker, and `listing_pris_okand` shows "pris/kvm saknas för objektet" instead of a false −100 % headline.
- **Independent partial-data degrade (Success Criterion 3 / D-08).** Each panel degrades on its own null/marker; one missing source never blanks or hides the other, and the page always loads.
- **Owner-only by construction (HIGH-2).** No `isGuest` prop, no login wall — the page renders only for a persisted owner row; enrichMarketContext re-checks auth + ownership server-side as defence-in-depth.

## Task Commits

Each task was committed atomically:

1. **Task 1: price-comparison-card.tsx + area-stats-card.tsx (display panels)** — `62e8aa6` (feat)
2. **Task 2: market-context-section.tsx + wire into analysis page** — `87e80cc` (feat)
3. **Task 3: human-verify PRICE-01 LIVE GATE** — APPROVED (no implementation commit; five fixes below were made during the gate)

**Live-gate fixes (committed on main during Task 3):**

- `822d433` fix(03): absorb Apify cold-start in Booli scrapers — waitSecs 60→240 + run.status SUCCEEDED guard (scraper returned before the actor finished cold-starting)
- `c9d599b` fix(03): load deso.geojson via process.cwd() + outputFileTracingIncludes — the DeSO polygon was absent from the Next server bundle so AREA resolved null at runtime
- `83fc76b` fix(03): correct SCB population/income query bodies + DeSO vintage — the AREA metrics requests returned 400
- `d7c25c7` fix(03): normalize live Apollo array shape + correct tier→areaId mapping — PRICE was falsely "thin"; re-captured the sold-comps fixture to the true live shape; added sold-schema.test.ts + sold-source.test.ts
- `f3fcb1a` fix(03): bump sold-source maxRequestRetries 1→3 — for Booli's intermittent 403

## Files Created/Modified

- `src/components/price-comparison-card.tsx` — PRICE-01 panel: ±% headline banner, comp-list receipt reveal, sample/tier/distribution, confidence + source label + "ej värdering" disclaimer; distinct ok/thin/source_unavailable/listing_pris_okand states (server card + small client reveal)
- `src/components/area-stats-card.tsx` — AREA-01 panel: four demographics metric cards + geo-level label + "Källa: SCB" + freshness; "Ej tillgänglig" fallback for null metrics
- `src/components/market-context-section.tsx` — client orchestrator: present/null/fetch branching mirroring brf-section.tsx, triggers enrichMarketContext, degrades each panel independently (owner-only, no guest path)
- `src/app/(app)/analysis/[id]/page.tsx` — RSC reads + safeParsePriceData/safeParseAreaData revalidation, renders MarketContextSection in place of the two placeholders, keeps the AI Rapport ComingSoonSection
- `src/lib/market/sold-source.ts` — live-gate fixes: Apollo array-shape normalization, tier→areaId mapping correction, cold-start waitSecs + SUCCEEDED guard, retries 1→3
- `src/lib/market/scb-client.ts` — live-gate fix: corrected population/income query bodies + DeSO vintage
- `src/lib/geo/resolve-geo.ts` — live-gate fix: load deso.geojson via process.cwd()
- `next.config.ts` — outputFileTracingIncludes so deso.geojson ships in the server bundle

## Decisions Made

- Server card + small client reveal split for both cards (less interactivity than BrfScoreCard; no recomputation in component).
- Reason-enum render branching to keep the four honest price states distinct (HIGH-1/HIGH-3) — a render decision over a persisted enum, never a recomputation.
- Owner-only by construction; no guest read path or login wall added (HIGH-2).

## Deviations from Plan

### Auto-fixed Issues

The five live-gate fixes above were Rule 1 (bug) fixes discovered when the panels were exercised against the LIVE sources during the Task 3 human-verify gate. Build/type checks passed before the gate; only running the real sources surfaced them.

**1. [Rule 1 - Bug] Apify cold-start race in Booli scrapers**
- **Found during:** Task 3 (live gate)
- **Issue:** scraper returned before the cold-started actor reached SUCCEEDED, yielding empty/partial data
- **Fix:** waitSecs 60→240 + explicit run.status SUCCEEDED guard
- **Committed in:** `822d433`

**2. [Rule 1 - Bug] deso.geojson missing from Next server bundle (AREA null at runtime)**
- **Found during:** Task 3 (live gate)
- **Issue:** the DeSO polygon was not traced into the server bundle, so resolveGeo returned null at runtime
- **Fix:** load via process.cwd() + next.config.ts outputFileTracingIncludes
- **Committed in:** `c9d599b`

**3. [Rule 1 - Bug] SCB population/income query bodies + DeSO vintage returned 400**
- **Found during:** Task 3 (live gate)
- **Issue:** AREA metric requests were malformed → HTTP 400, no metrics
- **Fix:** corrected the query bodies and DeSO vintage
- **Committed in:** `83fc76b`

**4. [Rule 1 - Bug] live Apollo array shape mismatch + wrong tier→areaId mapping (PRICE falsely "thin")**
- **Found during:** Task 3 (live gate)
- **Issue:** the live Apollo state was a different array shape than the original fixture, and the tier→areaId mapping was wrong, so a real 35-comp area was misreported as thin
- **Fix:** normalized the live Apollo array shape, corrected tier→areaId mapping, re-captured the fixture to the true live shape, added sold-schema.test.ts + sold-source.test.ts to lock the shape
- **Committed in:** `d7c25c7`

**5. [Rule 1 - Bug] Booli intermittent 403**
- **Found during:** Task 3 (live gate)
- **Issue:** Booli intermittently returned 403 on a single attempt
- **Fix:** maxRequestRetries 1→3
- **Committed in:** `f3fcb1a`

---

**Total deviations:** 5 auto-fixed (all Rule 1 — bugs only the live sources surfaced)
**Impact on plan:** All five were necessary to make the live PRICE-01/AREA-01 path work end-to-end. No scope creep — the plan's design (cards, section, wiring) was unchanged; these fixes corrected the underlying source/geo/SCB transport so the panels render real data.

## Issues Encountered

- **Watch item (not blocking):** a transient HTTP 402 was seen ONCE on the Apify actor during the live gate and did not reproduce. Flagged for a future transient-vs-permanent error-handling improvement (distinguish a recoverable 402/quota blip from a permanent source failure so it does not surface as source_unavailable when a retry would succeed). Not a blocker — PRICE-01 verified live after it cleared.

## Verification

- **Human live-gate: APPROVED** — both panels render correctly in the running app: a genuine live price comparison (real sold comps + ±%, reason "ok") AND the four live SCB area metrics. PRICE-01 confirmed satisfied in FULL on the live source (not the mock fixture). AREA-01 satisfied on live DeSO data.
- Full suite: 67 passed (11 files); `npx tsc --noEmit` clean; `npm run build` succeeds.

## Next Phase Readiness

- Phase 3 is functionally complete: all 6 plans executed; PRICE-01 + AREA-01 satisfied live. Phase 4 (AI Report) can now synthesize listing + BRF + price comparison + area demographics.
- Carry-forward: transient-vs-permanent Apify error handling (the 402 watch item) and the monitored CF/transport fragility (`hasApollo === false`/non-200 alerting) should inform Phase 4 robustness.

## Self-Check: PASSED

- All three created components exist on disk.
- All task + live-gate fix commits verified present in git history (62e8aa6, 87e80cc, 822d433, c9d599b, 83fc76b, d7c25c7, f3fcb1a).

---
*Phase: 03-market-context*
*Completed: 2026-06-22*
