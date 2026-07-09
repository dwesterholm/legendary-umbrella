---
phase: 08-brf-auto-fetch
plan: 05
subsystem: brf-analysis
tags: [gap-closure, jsonb, nextjs, zod, react, supabase]

# Dependency graph
requires:
  - phase: 08-brf-auto-fetch
    provides: "runBrfExtraction shared core (08-01), fetch-document.ts FetchedDocument.fiscalYear/isMostRecent (08-02), confirmAndAnalyze auto-fetch action (08-03), BrfScoreCard fiscal-year/staleness rendering (08-04)"
provides:
  - "fiscalYear/isMostRecent persisted end-to-end from fetch to render, closing ROADMAP Success Criterion 4"
  - "BrfData.fiscalYear / BrfData.isMostRecent additive-optional JSONB fields"
  - "runBrfExtraction(..., fetchMeta?) optional fetch-metadata param"
affects: [brf-analysis, analysis-page]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Auto-fetch metadata threaded via an optional trailing param (fetchMeta) rather than a new DB column — reuses the existing brf_data JSONB, additive-optional so old rows still safeParse"

key-files:
  created:
    - src/components/brf-score-card.test.tsx
  modified:
    - src/lib/brf/run-extraction.ts
    - src/lib/schemas/brf.ts
    - src/actions/fetch-brf-auto.ts
    - src/actions/fetch-brf-auto.test.ts
    - src/lib/brf/run-extraction.test.ts
    - "src/app/(app)/analysis/[id]/page.tsx"

key-decisions:
  - "Persisted fiscalYear/isMostRecent inside the existing brf_data JSONB column (BrfData interface) instead of adding a new analyses column/migration — the gap directive's preferred path, avoiding an unnecessary migration 010"
  - "runBrfExtraction's fetchMeta param is optional and additive; the manual path (analyzeBrf) passes nothing, so BrfData.fiscalYear/isMostRecent are simply absent there — no behavior change to the manual regression suite"
  - "confirmAndAnalyze persists fetchArsredovisning's actual doc.fiscalYear/doc.isMostRecent, never the client-supplied preview value passed as _fiscalYear — preserved the existing 'source of truth is the confirm-time fetch' discipline and added a test proving it"

requirements-completed: [ENRICH-02]

# Metrics
duration: 35min
completed: 2026-07-07
---

# Phase 8 Plan 5: BRF Fiscal-Year Persistence Gap Closure Summary

**Threaded `FetchedDocument.fiscalYear`/`isMostRecent` from auto-fetch through `runBrfExtraction`'s JSONB persist into `page.tsx`, making the previously-dormant fiscal-year line and staleness caption in `BrfScoreCard` render on real analyses (ROADMAP Success Criterion 4).**

## Performance

- **Duration:** 35 min
- **Started:** 2026-07-07T09:37:00Z
- **Completed:** 2026-07-07T10:12:00Z
- **Tasks:** 3 (schema/persist, thread-through, render)
- **Files modified:** 6 modified, 1 created

## Accomplishments

- `BrfData` (the `brf_data` JSONB payload) now carries optional `fiscalYear`/`isMostRecent` fields, validated by an updated `brfDataSchema` — no new migration; the existing JSONB column absorbs the additive-optional fields (CR-01 discipline preserved: old rows without these keys still `safeParse`)
- `runBrfExtraction` accepts an optional `fetchMeta` param and, when provided, writes `fiscalYear`/`isMostRecent` into the terminal persisted `brf_data`; the manual path (`analyzeBrf`) passes nothing, leaving both fields absent exactly as before
- `confirmAndAnalyze` threads `fetchArsredovisning`'s real `doc.fiscalYear`/`doc.isMostRecent` into that `fetchMeta` param — the confirm-time fetch remains the source of truth, never the client-supplied preview value
- `page.tsx` reads `brfData?.fiscalYear ?? null` / `brfData?.isMostRecent ?? null` instead of hardcoding `null`, so `BrfScoreCard`'s fiscal-year line and terracotta staleness caption go live on every completed auto-fetch analysis
- Added a dedicated `brf-score-card.test.tsx` proving the fiscal-year line renders with real data, the staleness caption shows only when `isMostRecent === false` (never fabricated on `true`/`null`), and both stay absent on the manual path

## Task Commits

Each task was committed atomically:

1. **Task 1: Persist fiscalYear/isMostRecent in BrfData JSONB** - `a9c8f1e` (feat)
2. **Task 2: Thread FetchedDocument values through confirmAndAnalyze -> runBrfExtraction** - `692c5c7` (feat)
3. **Task 3: Render real values in page.tsx + score-card tests** - `5d27829` (feat)

**Plan metadata:** pending (docs: complete plan, this commit)

## Files Created/Modified

- `src/lib/brf/run-extraction.ts` - `BrfData` gains optional `fiscalYear`/`isMostRecent`; new `BrfFetchMeta` type; `runBrfExtraction` accepts optional 5th `fetchMeta` param and writes it into the terminal persist
- `src/lib/schemas/brf.ts` - `brfDataSchema` gains matching `fiscalYear`/`isMostRecent` optional/nullable fields so `safeParseBrfData` accepts the new shape on read
- `src/actions/fetch-brf-auto.ts` - `confirmAndAnalyze` passes `{ fiscalYear: doc.fiscalYear, isMostRecent: doc.isMostRecent }` from the actual `fetchArsredovisning` result into `runBrfExtraction`
- `src/actions/fetch-brf-auto.test.ts` - updated the happy-path assertion for the new 5th arg; added a test proving the real fetched value wins over a stale client-supplied preview
- `src/lib/brf/run-extraction.test.ts` - new tests proving fetchMeta persists into the terminal write, is absent on the manual path, and survives the D-06 cache round-trip
- `src/app/(app)/analysis/[id]/page.tsx` - `BrfSection` now receives `brfData?.fiscalYear ?? null` / `brfData?.isMostRecent ?? null` instead of hardcoded `null`
- `src/components/brf-score-card.test.tsx` (new) - rendering tests for the fiscal-year line and staleness caption using real prop values

## Decisions Made

- **JSONB over migration:** the gap directive explicitly preferred reusing an existing persisted field over adding a new column. `brf_data` is already a JSONB column read/written by the exact code paths that needed to carry this data, so extending `BrfData`/`brfDataSchema` was strictly simpler and avoided an unnecessary `010_brf_fiscal_year.sql` migration, a live `supabase db push --linked`, and the associated `supabase migration list --linked` verification step. No migration file was created; none was needed.
- **Optional trailing param over a required one:** `runBrfExtraction(..., fetchMeta?)` keeps the manual path's call signature valid unchanged (no fetchMeta arg), and the `analyze-brf.test.ts` regression suite required zero changes as a result.
- **Confirm-time fetch remains authoritative:** `confirmAndAnalyze`'s `_fiscalYear` parameter (the client's preview value) is still intentionally unused for persistence — only `fetchArsredovisning`'s actual returned `doc.fiscalYear`/`doc.isMostRecent` are threaded through, preserving the pre-existing "never trust the client preview" discipline. A new test (`fetch-brf-auto.test.ts`) makes this explicit by passing a deliberately stale preview and asserting the real fetched value is what reaches `runBrfExtraction`.

## Deviations from Plan

None — plan executed exactly as scoped by the gap-closure objective. No architectural changes, no new migration, no changes to the manual-upload path's behavior.

## Known Stubs

None. The Bolagsverket rung remains an intentional, documented v1 deferral from Phase 8's original scope (unrelated to this gap) — not introduced or touched by this plan.

## Threat Flags

None. This closure adds no new network endpoints, auth paths, or trust-boundary schema changes — it only threads an already-computed, already-network-fetched value (`FetchedDocument.fiscalYear`/`isMostRecent`, computed in 08-02's `fetch-document.ts`) through existing, already-authenticated/ownership-gated code paths (`confirmAndAnalyze`, `runBrfExtraction`) into an existing JSONB column.

## Verification

- `npx vitest run` — 404 passed / 1 skipped (38 files passed, 1 skipped) — up from 395/1 before this plan (9 new tests: 3 in `run-extraction.test.ts`, 1 in `fetch-brf-auto.test.ts`, 5 in new `brf-score-card.test.tsx`)
- `npx tsc --noEmit` — clean, no output
- `npm run build` — compiled successfully, all routes generated, no errors
- Manual-upload path regression: `analyze-brf.test.ts` untouched and green — `runBrfExtraction`'s new `fetchMeta` param is optional and never passed by `analyzeBrf`

## Next Phase Readiness

ROADMAP Success Criterion 4 is now fully closed end-to-end for the auto-fetch path. The only remaining item from `08-VERIFICATION.md` is the operator-deferred live end-to-end Allabrf smoke test (`08-04-PLAN.md` Task 4's `[BLOCKING]` checkpoint), which this gap-closure plan was explicitly instructed NOT to run or fake. That live verification (confirming the fiscal-year line and staleness caption render correctly against a real Allabrf-fetched document, not just synthetic test data) remains the one open human-verification item for Phase 8.

## Self-Check: PASSED

All created/modified files confirmed present on disk; all three task commits (`a9c8f1e`, `692c5c7`, `5d27829`) confirmed present in `git log`.
